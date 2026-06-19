import path from "node:path";
import { Readable } from "node:stream";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { maybeControlDiscordVoiceAgentRun } from "./agent-control.js";
import { createDiscordOpusPlaybackStream } from "./audio.js";
import { resolveDiscordVoiceIngressContext, runDiscordVoiceAgentTurn } from "./ingress.js";
import { formatVoiceIngressPrompt } from "./prompt.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import {
  logVoiceVerbose,
  PLAYBACK_READY_TIMEOUT_MS,
  SPEAKING_READY_TIMEOUT_MS,
  type VoiceSessionEntry,
} from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";
import { synthesizeVoiceReplyAudio, transcribeVoiceAudio } from "./tts.js";

const VOICE_TRANSCRIPT_LOG_PREVIEW_CHARS = 500;
const logger = createSubsystemLogger("discord/voice");

function formatVoiceTranscriptLogPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= VOICE_TRANSCRIPT_LOG_PREVIEW_CHARS) {
    return oneLine;
  }
  return `${oneLine.slice(0, VOICE_TRANSCRIPT_LOG_PREVIEW_CHARS)}...`;
}

export async function processDiscordVoiceSegment(params: {
  entry: VoiceSessionEntry;
  wavPath: string;
  userId: string;
  durationSeconds: number;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv;
  ownerAllowFrom?: string[];
  fetchGuildName: (guildId: string) => Promise<string | undefined>;
  speakerContext: DiscordVoiceSpeakerContextResolver;
  transcripts?: VoiceSessionEntry["transcripts"];
  enqueuePlayback: (entry: VoiceSessionEntry, task: () => Promise<void>) => void;
}) {
  const { entry, wavPath, userId, durationSeconds } = params;
  // Run-scoped barge-in generation: captured before the agent turn so an
  // interruption also flushes replies still being generated when it happened.
  const bargeGen = entry.bargeInGeneration ?? 0;
  logVoiceVerbose(
    `segment processing (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId}`,
  );
  const ingress = await resolveDiscordVoiceIngressContext({
    entry,
    userId,
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    ownerAllowFrom: params.ownerAllowFrom,
    fetchGuildName: params.fetchGuildName,
    speakerContext: params.speakerContext,
  });
  if (!ingress) {
    logVoiceVerbose(
      `segment unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return;
  }
  // Enqueue a synthesized reply (or failure notice) through the same playback
  // path so the STT-failure branch and the normal reply share the barge-in
  // generation guard rather than drifting (tamakiii/meta#1329).
  const enqueueReplyPlayback = (
    voiceReplyAudio: Extract<
      Awaited<ReturnType<typeof synthesizeVoiceReplyAudio>>,
      { status: "ok" }
    >,
  ) => {
    params.enqueuePlayback(entry, async () => {
      const voiceSdk = loadDiscordVoiceSdk();
      const releaseAudioStream =
        voiceReplyAudio.mode === "stream" ? voiceReplyAudio.release : undefined;
      try {
        // Inside the try so the finally below still releases stream resources.
        if ((entry.bargeInGeneration ?? 0) !== bargeGen) {
          logger.info(
            `discord voice: playback skipped (barge-in gen ${bargeGen} -> ${entry.bargeInGeneration ?? 0}): guild ${entry.guildId} channel ${entry.channelId}`,
          );
          return;
        }
        if (voiceReplyAudio.mode === "stream") {
          logVoiceVerbose(
            `playback start: guild ${entry.guildId} channel ${entry.channelId} stream`,
          );
          const nodeStream = Readable.fromWeb(
            voiceReplyAudio.audioStream as import("node:stream/web").ReadableStream<Uint8Array>,
          );
          const resource = voiceSdk.createAudioResource(
            createDiscordOpusPlaybackStream(nodeStream),
            {
              inputType: voiceSdk.StreamType.Opus,
            },
          );
          entry.player.play(resource);
        } else {
          logVoiceVerbose(
            `playback start: guild ${entry.guildId} channel ${entry.channelId} file ${path.basename(voiceReplyAudio.audioPath)}`,
          );
          const resource = voiceSdk.createAudioResource(
            createDiscordOpusPlaybackStream(voiceReplyAudio.audioPath),
            {
              inputType: voiceSdk.StreamType.Opus,
            },
          );
          entry.player.play(resource);
        }
        await voiceSdk
          .entersState(entry.player, voiceSdk.AudioPlayerStatus.Playing, PLAYBACK_READY_TIMEOUT_MS)
          .catch(() => undefined);
        await voiceSdk
          .entersState(entry.player, voiceSdk.AudioPlayerStatus.Idle, SPEAKING_READY_TIMEOUT_MS)
          .catch(() => undefined);
        logVoiceVerbose(`playback done: guild ${entry.guildId} channel ${entry.channelId}`);
      } finally {
        await releaseAudioStream?.();
      }
    });
  };

  let transcript: string | undefined;
  try {
    transcript = await transcribeVoiceAudio({
      cfg: params.cfg,
      agentId: entry.route.agentId,
      filePath: wavPath,
    });
  } catch (error: unknown) {
    // Without this the throw (e.g. whisper.cpp "failed to encode" on an
    // oversized clip) propagates to manager.enqueueProcessing's log-only
    // `.catch` and the assistant silently stops replying (tamakiii/meta#1329).
    // Speak a brief notice so the speaker knows to retry.
    logger.warn(`discord voice: transcription failed: ${formatErrorMessage(error)}`);
    if (params.transcripts) {
      return;
    }
    const noticeAudio = await synthesizeVoiceReplyAudio({
      cfg: params.cfg,
      override: params.discordConfig.voice?.tts,
      replyText: "Sorry, I didn't catch that — could you try a shorter message?",
      speakerLabel: ingress.speakerLabel,
    });
    if (noticeAudio.status === "empty" || noticeAudio.status === "failed") {
      if (noticeAudio.status === "failed") {
        logger.warn(`discord voice: TTS failed: ${noticeAudio.error ?? "unknown error"}`);
      }
      return;
    }
    enqueueReplyPlayback(noticeAudio);
    return;
  }
  if (!transcript) {
    logVoiceVerbose(
      `transcription empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return;
  }
  logVoiceVerbose(
    `transcription ok (${transcript.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
  );
  logVoiceVerbose(
    `transcript from ${ingress.speakerLabel} (${userId}) in guild ${entry.guildId} channel ${entry.channelId}: ${formatVoiceTranscriptLogPreview(transcript)}`,
  );
  if (params.transcripts) {
    await params.transcripts.onUtterance({
      sessionId: params.transcripts.sessionId,
      startedAt: new Date().toISOString(),
      final: true,
      speaker: {
        id: userId,
        label: ingress.speakerLabel,
      },
      text: transcript,
      metadata: {
        channel: "discord",
        guildId: entry.guildId,
        channelId: entry.channelId,
        voiceSessionKey: entry.voiceSessionKey,
      },
    });
    return;
  }

  let replyText: string;
  const control = await maybeControlDiscordVoiceAgentRun({
    entry,
    text: transcript,
  }).catch((error: unknown) => {
    logger.warn(
      `discord voice: active-run control failed; falling back to normal segment handling: ${formatErrorMessage(error)}`,
    );
    return undefined;
  });

  if (control?.handled) {
    logger.info(
      `discord voice: active-run control handled mode=${control.result.mode} ok=${control.result.ok} active=${control.result.active} reason=${control.result.reason ?? "none"} session=${entry.route.sessionKey}`,
    );
    replyText = control.speakText ?? "";
  } else {
    const prompt = formatVoiceIngressPrompt(transcript, ingress.speakerLabel);
    const turn = await runDiscordVoiceAgentTurn({
      entry,
      userId,
      message: prompt,
      cfg: params.cfg,
      discordConfig: params.discordConfig,
      runtime: params.runtime,
      context: ingress,
      ownerAllowFrom: params.ownerAllowFrom,
      fetchGuildName: params.fetchGuildName,
      speakerContext: params.speakerContext,
    });
    if (!turn) {
      logVoiceVerbose(
        `segment unauthorized before agent turn: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return;
    }
    replyText = turn.text;
  }

  if (!replyText) {
    logVoiceVerbose(
      `reply empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return;
  }
  logVoiceVerbose(
    `reply ok (${replyText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
  );

  const voiceReplyAudio = await synthesizeVoiceReplyAudio({
    cfg: params.cfg,
    override: params.discordConfig.voice?.tts,
    replyText,
    speakerLabel: ingress.speakerLabel,
  });
  if (voiceReplyAudio.status === "empty") {
    logVoiceVerbose(
      `tts skipped (empty): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return;
  }
  if (voiceReplyAudio.status === "failed") {
    logger.warn(`discord voice: TTS failed: ${voiceReplyAudio.error ?? "unknown error"}`);
    return;
  }
  logVoiceVerbose(
    `tts ok (${voiceReplyAudio.speakText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
  );

  enqueueReplyPlayback(voiceReplyAudio);
}
