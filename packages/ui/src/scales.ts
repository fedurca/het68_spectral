/*
 * Frequency and time axis scales.
 *
 * The three frequency scales answer different questions. Linear shows a harmonic
 * comb as evenly spaced lines, which is how you recognise one and how you count
 * rotors. Logarithmic compresses the top of the band so the whole 0 to 24 kHz range
 * fits without burying the 600 to 1400 Hz region where the Neo 2's fundamental
 * lives. Mel is here because it matches how the broadband part of the sound is
 * perceived, which matters if the ducted props turn out to have little tonal content
 * and the detector has to lean on spectral shape instead.
 */

export type FrequencyScale = "linear" | "log" | "mel";

/** Lowest frequency the log axis shows. Below this the ratio explodes. */
export const LOG_FLOOR_HZ = 20;

export function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

export function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

/** Maps a frequency to 0..1 across the visible range. */
export function frequencyToUnit(
  hz: number,
  loHz: number,
  hiHz: number,
  scale: FrequencyScale,
): number {
  switch (scale) {
    case "linear":
      return (hz - loHz) / (hiHz - loHz);
    case "log": {
      const lo = Math.max(loHz, LOG_FLOOR_HZ);
      const f = Math.max(hz, LOG_FLOOR_HZ);
      return (Math.log(f) - Math.log(lo)) / (Math.log(hiHz) - Math.log(lo));
    }
    case "mel": {
      const lo = hzToMel(loHz);
      return (hzToMel(hz) - lo) / (hzToMel(hiHz) - lo);
    }
  }
}

export function unitToFrequency(
  u: number,
  loHz: number,
  hiHz: number,
  scale: FrequencyScale,
): number {
  switch (scale) {
    case "linear":
      return loHz + u * (hiHz - loHz);
    case "log": {
      const lo = Math.max(loHz, LOG_FLOOR_HZ);
      return Math.exp(Math.log(lo) + u * (Math.log(hiHz) - Math.log(lo)));
    }
    case "mel": {
      const lo = hzToMel(loHz);
      return melToHz(lo + u * (hzToMel(hiHz) - lo));
    }
  }
}

export interface Tick {
  value: number;
  label: string;
  /** Position 0..1 along the axis. */
  unit: number;
  major: boolean;
}

function formatHz(hz: number): string {
  if (hz >= 1000) {
    const k = hz / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return hz.toFixed(hz < 100 ? 0 : 0);
}

/** Ticks that suit the scale: decade-ish on log, round numbers on linear. */
export function frequencyTicks(
  loHz: number,
  hiHz: number,
  scale: FrequencyScale,
  target = 8,
): Tick[] {
  const ticks: Tick[] = [];
  const push = (hz: number, major = true) => {
    if (hz < loHz || hz > hiHz) return;
    ticks.push({
      value: hz,
      label: formatHz(hz),
      unit: frequencyToUnit(hz, loHz, hiHz, scale),
      major,
    });
  };

  if (scale === "linear") {
    const span = hiHz - loHz;
    const raw = span / target;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
    for (let hz = Math.ceil(loHz / step) * step; hz <= hiHz; hz += step) push(hz);
    return ticks;
  }

  const candidates = [
    20, 50, 100, 200, 300, 500, 700, 1000, 1400, 2000, 3000, 4000, 6000, 8000, 12000,
    16000, 20000, 24000,
  ];
  for (const hz of candidates) push(hz);
  return ticks;
}

export function timeTicks(startSec: number, endSec: number, target = 10): Tick[] {
  const span = endSec - startSec;
  if (span <= 0) return [];
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const ticks: Tick[] = [];
  for (let t = Math.ceil(startSec / step) * step; t <= endSec + 1e-9; t += step) {
    ticks.push({
      value: t,
      label: step >= 1 ? `${t.toFixed(0)}s` : `${t.toFixed(step >= 0.1 ? 1 : 2)}s`,
      unit: (t - startSec) / span,
      major: true,
    });
  }
  return ticks;
}

/** Clamps a view range to the data and keeps it from collapsing to nothing. */
export function clampRange(
  from: number,
  to: number,
  min: number,
  max: number,
  minSpan: number,
): [number, number] {
  let span = Math.max(minSpan, to - from);
  span = Math.min(span, max - min);
  let lo = Math.max(min, Math.min(from, max - span));
  return [lo, lo + span];
}
