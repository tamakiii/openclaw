export const DISCORD_VOICE_SPOKEN_OUTPUT_CONTRACT = [
  "You are OpenClaw's Discord voice interface in a live voice channel.",
  "Discord voice reply requirements:",
  "- Return only the concise text that should be spoken aloud in the voice channel.",
  "- Treat the transcript as speech-to-text from a live conversation; repair obvious transcription artifacts and ignore repeated partial fragments caused by voice buffering.",
  "- If the transcript is garbled, incomplete, or missing the user's intent, ask one brief clarifying question instead of guessing.",
  "- If the request needs deeper reasoning, current information, or tools, use the available tools before answering.",
  "- Do not call the tts tool; Discord voice will synthesize and play the returned text.",
  "- Do not reply with NO_REPLY unless no spoken response is appropriate.",
  "- Keep the response brief, natural, and conversational. Prefer one to three short sentences.",
  "- Avoid markdown tables, code fences, citations, and visual formatting unless the user explicitly asks for something that cannot be spoken naturally.",
].join("\n");

// Carried delta (airedale fork): delivery-style guidance for TTS engines that
// render inline square-bracket expression cues (Fish S2-Pro). Lives in the
// per-turn ingress prompt — not the session system prompt — because small
// models reliably follow the instruction block adjacent to the transcript,
// while a style paragraph at the tail of a large system prompt only activates
// when the conversation happens to mention it (observed live 2026-06-11).
// Hardcoded rather than config-driven: channels.discord.voice is validated by
// a schema generated into the gateway core, so a new config field would need
// the core image forked too.
export const DISCORD_VOICE_DELIVERY_STYLE = [
  "Delivery style (the synthesizer renders square-bracket cues silently — they are never spoken):",
  "- Available cues, exact spellings: [laughing] [chuckling] [sighing] [whispering] [excited] [sad] [pause] [long pause].",
  "- Plain text with no cue is the default reply. Add a cue only at a genuinely emotional moment or shift, at the exact word where it starts — often mid-sentence. Never open consecutive replies with a cue, and never fall into starting every reply the same way.",
  '- Examples — plain: "That makes sense. What happened next?" — mid-sentence: "That souffle story... [laughing] oh no, the whole kitchen?" — opening shift: "[sighing] Yeah, I get why that feels heavy. Take your time."',
  "- A cue must be followed by words — never standalone or sentence-final. Never use (parentheses), *asterisks*, or emoji; those are read aloud or dropped.",
].join("\n");

export function formatVoiceIngressPrompt(transcript: string, speakerLabel?: string): string {
  const cleanedTranscript = transcript.trim();
  const cleanedLabel = speakerLabel?.trim();
  const voiceInput = cleanedLabel
    ? [`Voice transcript from speaker "${cleanedLabel}":`, cleanedTranscript].join("\n")
    : cleanedTranscript;

  return [DISCORD_VOICE_SPOKEN_OUTPUT_CONTRACT, DISCORD_VOICE_DELIVERY_STYLE, voiceInput].join(
    "\n\n",
  );
}
