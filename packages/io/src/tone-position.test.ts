import { describe, expect, it } from "vitest";
import { locateTone } from "./tone-position.js";

function tone(frames: number, sampleRate: number, hz: number, amp: number, phase = 0): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate + phase);
  }
  return out;
}

describe("locateTone", () => {
  it("picks the microphone that carries the 2 kHz tone", () => {
    const frames = 4800;
    const channels = 6;
    const planar = new Float32Array(frames * channels);
    planar.set(tone(frames, 48000, 2000, 0.02), 0);
    planar.set(tone(frames, 48000, 2000, 0.4), 4 * frames);
    const fix = locateTone({ planar, channels, frames, sampleRate: 48000 });
    expect(fix.loudest).toBe(5);
    expect(fix.mode).toBe("nearest");
    expect(fix.dominanceDb).toBeGreaterThan(10);
    expect(fix.nominalAzDeg).not.toBeNull();
  });

  it("reports a stereo pan when Chromium only delivered two channels", () => {
    const frames = 4800;
    const planar = new Float32Array(frames * 2);
    planar.set(tone(frames, 48000, 2000, 0.05), 0);
    planar.set(tone(frames, 48000, 2000, 0.5), frames);
    const fix = locateTone({ planar, channels: 2, frames, sampleRate: 48000 });
    expect(fix.mode).toBe("stereo");
    expect(fix.loudest).toBe(2);
    expect(fix.stereoPan).toBeGreaterThan(0.5);
    expect(fix.nominalAzDeg).toBeNull();
  });

  it("stays silent when the tone is absent", () => {
    const frames = 4800;
    const planar = new Float32Array(frames * 2);
    const fix = locateTone({ planar, channels: 2, frames, sampleRate: 48000 });
    expect(fix.mode).toBe("silent");
    expect(fix.loudest).toBeNull();
  });
});
