import type { Readable } from "node:stream";

type VoiceCaptureEntry = {
  generation: number;
  stream: Readable;
};

type VoiceCaptureTimer = {
  generation: number;
  timer: ReturnType<typeof setTimeout>;
};

export type VoiceCaptureState = {
  activeSpeakers: Set<string>;
  activeCaptureStreams: Map<string, VoiceCaptureEntry>;
  captureFinalizeTimers: Map<string, VoiceCaptureTimer>;
  // Per-speaker hard cap on a single capture segment, armed alongside the
  // finalize timer; cleared everywhere the finalize timer is cleared so the two
  // stay symmetric and never outlive their generation.
  captureMaxDurationTimers: Map<string, VoiceCaptureTimer>;
  captureGenerations: Map<string, number>;
};

export function createVoiceCaptureState(): VoiceCaptureState {
  return {
    activeSpeakers: new Set(),
    activeCaptureStreams: new Map(),
    captureFinalizeTimers: new Map(),
    captureMaxDurationTimers: new Map(),
    captureGenerations: new Map(),
  };
}

export function stopVoiceCaptureState(state: VoiceCaptureState): void {
  for (const { timer } of state.captureFinalizeTimers.values()) {
    clearTimeout(timer);
  }
  state.captureFinalizeTimers.clear();
  for (const { timer } of state.captureMaxDurationTimers.values()) {
    clearTimeout(timer);
  }
  state.captureMaxDurationTimers.clear();
  for (const { stream } of state.activeCaptureStreams.values()) {
    stream.destroy();
  }
  state.activeCaptureStreams.clear();
  state.captureGenerations.clear();
  state.activeSpeakers.clear();
}

export function getActiveVoiceCapture(
  state: VoiceCaptureState,
  userId: string,
): VoiceCaptureEntry | undefined {
  return state.activeCaptureStreams.get(userId);
}

export function isVoiceCaptureActive(state: VoiceCaptureState, userId: string): boolean {
  return state.activeSpeakers.has(userId);
}

export function clearVoiceCaptureFinalizeTimer(
  state: VoiceCaptureState,
  userId: string,
  generation?: number,
): boolean {
  const scheduled = state.captureFinalizeTimers.get(userId);
  if (!scheduled || (generation !== undefined && scheduled.generation !== generation)) {
    return false;
  }
  clearTimeout(scheduled.timer);
  state.captureFinalizeTimers.delete(userId);
  return true;
}

function clearVoiceCaptureMaxDurationTimer(
  state: VoiceCaptureState,
  userId: string,
  generation?: number,
): boolean {
  const scheduled = state.captureMaxDurationTimers.get(userId);
  if (!scheduled || (generation !== undefined && scheduled.generation !== generation)) {
    return false;
  }
  clearTimeout(scheduled.timer);
  state.captureMaxDurationTimers.delete(userId);
  return true;
}

export function beginVoiceCapture(
  state: VoiceCaptureState,
  userId: string,
  stream: Readable,
): number {
  const generation = (state.captureGenerations.get(userId) ?? 0) + 1;
  state.captureGenerations.set(userId, generation);
  state.activeSpeakers.add(userId);
  state.activeCaptureStreams.set(userId, { generation, stream });
  clearVoiceCaptureFinalizeTimer(state, userId, generation);
  clearVoiceCaptureMaxDurationTimer(state, userId, generation);
  return generation;
}

export function finishVoiceCapture(
  state: VoiceCaptureState,
  userId: string,
  generation: number,
): boolean {
  clearVoiceCaptureFinalizeTimer(state, userId, generation);
  clearVoiceCaptureMaxDurationTimer(state, userId, generation);
  const activeCapture = state.activeCaptureStreams.get(userId);
  if (activeCapture?.generation !== generation) {
    return false;
  }
  state.activeCaptureStreams.delete(userId);
  state.activeSpeakers.delete(userId);
  return true;
}

export function scheduleVoiceCaptureFinalize(params: {
  state: VoiceCaptureState;
  userId: string;
  delayMs: number;
  onFinalize?: (capture: VoiceCaptureEntry) => void;
}): boolean {
  const { state, userId, delayMs, onFinalize } = params;
  const capture = state.activeCaptureStreams.get(userId);
  if (!capture) {
    return false;
  }
  clearVoiceCaptureFinalizeTimer(state, userId, capture.generation);
  const timer = setTimeout(() => {
    const activeCapture = state.activeCaptureStreams.get(userId);
    if (!activeCapture || activeCapture.generation !== capture.generation) {
      return;
    }
    state.captureFinalizeTimers.delete(userId);
    state.activeCaptureStreams.delete(userId);
    state.activeSpeakers.delete(userId);
    onFinalize?.(activeCapture);
    activeCapture.stream.destroy();
  }, delayMs);
  state.captureFinalizeTimers.set(userId, { generation: capture.generation, timer });
  return true;
}

export function scheduleVoiceCaptureMaxDuration(params: {
  state: VoiceCaptureState;
  userId: string;
  delayMs: number;
  onCap?: (capture: VoiceCaptureEntry) => void;
}): boolean {
  const { state, userId, delayMs, onCap } = params;
  const capture = state.activeCaptureStreams.get(userId);
  if (!capture) {
    return false;
  }
  clearVoiceCaptureMaxDurationTimer(state, userId, capture.generation);
  const timer = setTimeout(() => {
    const activeCapture = state.activeCaptureStreams.get(userId);
    if (!activeCapture || activeCapture.generation !== capture.generation) {
      return;
    }
    state.captureMaxDurationTimers.delete(userId);
    // Only destroy the stream: this ends decodeOpusStream's `for await` loop so
    // the ≤cap PCM already captured is written + transcribed by the normal path.
    // Active-speaker/capture-stream bookkeeping is cleared by finishVoiceCapture
    // in the capture handler's finally, keeping ownership in one place.
    onCap?.(activeCapture);
    activeCapture.stream.destroy();
  }, delayMs);
  state.captureMaxDurationTimers.set(userId, { generation: capture.generation, timer });
  return true;
}
