/**
 * Where a narrow tone sits relative to the het68 microphones.
 *
 * A pure tone above the cube's grating frequency (~447 Hz at 384 mm) does not
 * have a unique delay, so the primary answer is which microphone is loudest.
 * With all six channels we also report an energy-weighted azimuth on the
 * nominal cube; that azimuth is only meaningful when the microphones are
 * actually on that cube.
 */

export const TONE_HZ_DEFAULT = 2000;

/** Face-centre directions of the cube standing on a vertex. Same as firmware MIC_DIR. */
export const MIC_DIR: readonly (readonly [number, number, number])[] = [
  [0.8165, 0, 0.57735],
  [-0.40825, 0.70711, 0.57735],
  [-0.40825, -0.70711, 0.57735],
  [-0.8165, 0, -0.57735],
  [0.40825, -0.70711, -0.57735],
  [0.40825, 0.70711, -0.57735],
];

export interface ToneLevel {
  channel: number;
  magnitude: number;
  db: number;
}

export interface ToneFix {
  toneHz: number;
  channels: number;
  sampleRate: number;
  levels: ToneLevel[];
  /** 1-based microphone index, or null when the tone is absent. */
  loudest: number | null;
  /** Loudest minus the median, in dB. Near zero means the tone is everywhere. */
  dominanceDb: number;
  /**
   * Stereo panorama from the first two channels, -1 (left / ch1) to +1 (right / ch2).
   * This is all a browser downmix can support.
   */
  stereoPan: number | null;
  /** Energy-weighted azimuth on the nominal cube, degrees, 0 = mic-1 / +X. */
  nominalAzDeg: number | null;
  mode: "silent" | "stereo" | "nearest";
}

function goertzel(samples: Float32Array, sampleRate: number, toneHz: number): { re: number; im: number } {
  const omega = (2 * Math.PI * toneHz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const re = s1 - s2 * Math.cos(omega);
  const im = s2 * Math.sin(omega);
  return { re, im };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Loudest 0.5 s (or the whole buffer, if shorter), stepped by half a window. */
function loudestWindow(
  planar: Float32Array,
  channels: number,
  frames: number,
  sampleRate: number,
  toneHz: number,
): { start: number; length: number } {
  const win = Math.min(frames, Math.round(sampleRate * 0.5));
  if (win <= 0) return { start: 0, length: 0 };
  if (win >= frames) return { start: 0, length: frames };
  const hop = Math.max(1, Math.floor(win / 2));
  let best = -1;
  let bestStart = 0;
  const scratch = new Float32Array(win);
  for (let start = 0; start + win <= frames; start += hop) {
    let energy = 0;
    const n = Math.min(channels, 6);
    for (let ch = 0; ch < n; ch++) {
      scratch.set(planar.subarray(ch * frames + start, ch * frames + start + win));
      const g = goertzel(scratch, sampleRate, toneHz);
      energy += g.re * g.re + g.im * g.im;
    }
    if (energy > best) {
      best = energy;
      bestStart = start;
    }
  }
  return { start: bestStart, length: win };
}

export function locateTone(opts: {
  planar: Float32Array;
  channels: number;
  frames: number;
  sampleRate: number;
  toneHz?: number;
}): ToneFix {
  const toneHz = opts.toneHz ?? TONE_HZ_DEFAULT;
  const { planar, channels, frames, sampleRate } = opts;
  const empty: ToneFix = {
    toneHz,
    channels,
    sampleRate,
    levels: [],
    loudest: null,
    dominanceDb: 0,
    stereoPan: null,
    nominalAzDeg: null,
    mode: "silent",
  };
  if (channels < 1 || frames < 16 || sampleRate <= 0) return empty;

  const window = loudestWindow(planar, channels, frames, sampleRate, toneHz);
  const buf = new Float32Array(window.length);
  const levels: ToneLevel[] = [];
  for (let ch = 0; ch < channels; ch++) {
    buf.set(planar.subarray(ch * frames + window.start, ch * frames + window.start + window.length));
    const g = goertzel(buf, sampleRate, toneHz);
    const magnitude = Math.hypot(g.re, g.im) / window.length;
    const db = 20 * Math.log10(magnitude + 1e-12);
    levels.push({ channel: ch + 1, magnitude, db });
  }

  const peak = Math.max(...levels.map((l) => l.magnitude));
  if (peak < 1e-6) {
    return { ...empty, levels, mode: "silent" };
  }

  let loudest = 1;
  for (const level of levels) {
    if (level.magnitude > levels[loudest - 1]!.magnitude) loudest = level.channel;
  }
  const dominanceDb = levels[loudest - 1]!.db - median(levels.map((l) => l.db));

  let stereoPan: number | null = null;
  if (channels >= 2) {
    const a = levels[0]!.magnitude;
    const b = levels[1]!.magnitude;
    stereoPan = (b - a) / (a + b + 1e-12);
  }

  let nominalAzDeg: number | null = null;
  if (channels >= 6) {
    let x = 0;
    let y = 0;
    let wsum = 0;
    for (let i = 0; i < 6; i++) {
      const w = levels[i]!.magnitude ** 2;
      const dir = MIC_DIR[i]!;
      x += w * dir[0];
      y += w * dir[1];
      wsum += w;
    }
    if (wsum > 0) {
      let az = (Math.atan2(y, x) * 180) / Math.PI;
      if (az < 0) az += 360;
      nominalAzDeg = az;
    }
  }

  return {
    toneHz,
    channels,
    sampleRate,
    levels,
    loudest,
    dominanceDb,
    stereoPan,
    nominalAzDeg,
    mode: channels >= 6 ? "nearest" : channels === 2 ? "stereo" : "nearest",
  };
}
