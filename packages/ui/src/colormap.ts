/*
 * Colour maps.
 *
 * Viridis is the default because it is perceptually uniform: equal steps in dB look
 * like equal steps of colour, so a harmonic that appears twice as bright really is.
 * Grey is here for the same reason in reverse — it makes faint structure easy to
 * miss, which is occasionally what you want when judging whether something is there
 * at all. Turbo is included because it exaggerates small differences, which is
 * useful for hunting a weak comb and misleading for anything quantitative.
 */

export type ColormapName = "viridis" | "magma" | "inferno" | "turbo" | "grey";

/** Control points, sampled from the reference maps and interpolated at build time. */
const STOPS: Record<ColormapName, [number, number, number][]> = {
  viridis: [
    [68, 1, 84],
    [72, 40, 120],
    [62, 74, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [109, 205, 89],
    [180, 222, 44],
    [253, 231, 37],
  ],
  magma: [
    [0, 0, 4],
    [28, 16, 68],
    [79, 18, 123],
    [129, 37, 129],
    [181, 54, 122],
    [229, 80, 100],
    [251, 135, 97],
    [254, 194, 135],
    [252, 253, 191],
  ],
  inferno: [
    [0, 0, 4],
    [31, 12, 72],
    [85, 15, 109],
    [136, 34, 106],
    [186, 54, 85],
    [227, 89, 51],
    [249, 142, 9],
    [249, 201, 50],
    [252, 255, 164],
  ],
  turbo: [
    [48, 18, 59],
    [70, 107, 227],
    [40, 187, 236],
    [61, 235, 168],
    [148, 253, 85],
    [223, 231, 55],
    [254, 173, 51],
    [239, 96, 26],
    [186, 34, 6],
    [122, 4, 3],
  ],
  grey: [
    [0, 0, 0],
    [255, 255, 255],
  ],
};

const LUT_SIZE = 256;
const cache = new Map<ColormapName, Uint8Array>();

/** RGBA lookup table, 256 entries, for uploading as a texture. */
export function colormapLut(name: ColormapName): Uint8Array {
  const cached = cache.get(name);
  if (cached) return cached;

  const stops = STOPS[name];
  const lut = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = (i / (LUT_SIZE - 1)) * (stops.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(stops.length - 1, lo + 1);
    const f = t - lo;
    for (let c = 0; c < 3; c++) {
      lut[i * 4 + c] = Math.round(stops[lo]![c]! + (stops[hi]![c]! - stops[lo]![c]!) * f);
    }
    lut[i * 4 + 3] = 255;
  }
  cache.set(name, lut);
  return lut;
}

/** A single colour from a map, for legends and line plots. */
export function colormapAt(name: ColormapName, t: number): string {
  const lut = colormapLut(name);
  const i = Math.max(0, Math.min(LUT_SIZE - 1, Math.round(t * (LUT_SIZE - 1))));
  return `rgb(${lut[i * 4]},${lut[i * 4 + 1]},${lut[i * 4 + 2]})`;
}

export const COLORMAP_NAMES: ColormapName[] = [
  "viridis",
  "magma",
  "inferno",
  "turbo",
  "grey",
];

/** Fixed per-channel colours, matching the CSS custom properties. */
export const CHANNEL_COLOURS = [
  "#1fbfa0",
  "#3b82f6",
  "#f59e0b",
  "#a78bfa",
  "#ef4444",
  "#22d3ee",
] as const;

export function channelColour(ch: number): string {
  return CHANNEL_COLOURS[ch % CHANNEL_COLOURS.length]!;
}
