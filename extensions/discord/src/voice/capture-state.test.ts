import { describe, expect, it, vi } from "vitest";
import {
  beginVoiceCapture,
  clearVoiceCaptureFinalizeTimer,
  createVoiceCaptureState,
  finishVoiceCapture,
  scheduleVoiceCaptureFinalize,
  scheduleVoiceCaptureMaxDuration,
} from "./capture-state.js";

describe("voice capture state", () => {
  it("increments generations per speaker", () => {
    const state = createVoiceCaptureState();
    const first = beginVoiceCapture(state, "u1", { destroy: vi.fn() } as never);
    finishVoiceCapture(state, "u1", first);
    const second = beginVoiceCapture(state, "u1", { destroy: vi.fn() } as never);

    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it("clears active speaker state before destroying a finalized capture", async () => {
    vi.useFakeTimers();
    try {
      const state = createVoiceCaptureState();
      const destroy = vi.fn(() => {
        expect(state.activeSpeakers.has("u1")).toBe(false);
        expect(state.activeCaptureStreams.has("u1")).toBe(false);
      });
      beginVoiceCapture(state, "u1", { destroy } as never);

      expect(scheduleVoiceCaptureFinalize({ state, userId: "u1", delayMs: 1_200 })).toBe(true);
      await vi.advanceTimersByTimeAsync(1_200);

      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a pending finalize be canceled for the same generation", () => {
    const state = createVoiceCaptureState();
    const generation = beginVoiceCapture(state, "u1", { destroy: vi.fn() } as never);

    expect(scheduleVoiceCaptureFinalize({ state, userId: "u1", delayMs: 1_200 })).toBe(true);
    expect(clearVoiceCaptureFinalizeTimer(state, "u1", generation)).toBe(true);
    expect(state.captureFinalizeTimers.has("u1")).toBe(false);
  });

  it("destroys the capture stream when the max-duration cap fires", async () => {
    vi.useFakeTimers();
    try {
      const state = createVoiceCaptureState();
      const destroy = vi.fn();
      beginVoiceCapture(state, "u1", { destroy } as never);

      const onCap = vi.fn();
      expect(scheduleVoiceCaptureMaxDuration({ state, userId: "u1", delayMs: 20_000, onCap })).toBe(
        true,
      );
      await vi.advanceTimersByTimeAsync(20_000);

      expect(onCap).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(state.captureMaxDurationTimers.has("u1")).toBe(false);
      // Cap only destroys the stream; active-speaker bookkeeping is the capture
      // handler's finishVoiceCapture job, so the stream stays registered here.
      expect(state.activeCaptureStreams.has("u1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the max-duration timer when the capture finishes", () => {
    const state = createVoiceCaptureState();
    const generation = beginVoiceCapture(state, "u1", { destroy: vi.fn() } as never);

    expect(scheduleVoiceCaptureMaxDuration({ state, userId: "u1", delayMs: 20_000 })).toBe(true);
    expect(state.captureMaxDurationTimers.has("u1")).toBe(true);
    finishVoiceCapture(state, "u1", generation);
    expect(state.captureMaxDurationTimers.has("u1")).toBe(false);
  });
});
