import { WindowKind } from "./types.js";

/** Chosen geometry. See docs for why 384 mm rather than 512. */
export const DEFAULT_EDGE_MM = 384;
export const DEFAULT_SAMPLE_RATE = 48000;

export interface Band {
  id: string;
  label: string;
  loHz: number;
  hiHz: number;
  /** Bands the firmware already uses, shown for context even though v1 only works on drones. */
  firmware: boolean;
  colour: string;
}

/**
 * The firmware's own class bands. Only the drone band is being worked on; the rest
 * are here so it is visible whether energy is landing where some other detector
 * would claim it.
 */
export const FIRMWARE_BANDS: Band[] = [
  { id: "wind", label: "Wind", loHz: 0, hiHz: 250, firmware: true, colour: "#64748b" },
  { id: "vehicle", label: "Vehicle", loHz: 80, hiHz: 2500, firmware: true, colour: "#a16207" },
  { id: "walker", label: "Walker", loHz: 150, hiHz: 600, firmware: true, colour: "#7c3aed" },
  { id: "drone", label: "Drone", loHz: 800, hiHz: 6000, firmware: true, colour: "#1fbfa0" },
  { id: "bird", label: "Bird", loHz: 2000, hiHz: 8000, firmware: true, colour: "#3b82f6" },
];

/**
 * Deliberately wider than the firmware's 800 Hz to 6 kHz drone band, so it can be
 * measured whether those edges are in the right place. The Neo 2's fundamental sits
 * right on the 800 Hz boundary at hover and drops below it off throttle, which
 * makes the lower edge the single most consequential tuning parameter in the whole
 * detector.
 */
export const ANALYSIS_BAND = { loHz: 600, hiHz: 8000 };

/** Band edges handed to signature extraction, in Hz. */
export const SIGNATURE_BAND_EDGES = [300, 800, 2000, 6000, 12000];

/**
 * DJI Neo 2, the first machine being tuned for.
 *
 * 151 g take-off weight (160 g with the transceiver), four two-blade 2217S props of
 * 55.9 mm diameter running inside integral ducts. DJI does not publish rotor speed,
 * so the range below is derived from thrust: 38 g per rotor over a 2.45e-3 m^2 disc
 * gives an induced velocity of 7.9 m/s, which against a 1.7 inch pitch puts hover
 * somewhere between 20000 and 35000 rpm.
 *
 * These are estimates. Measuring the real rate from the first recording is an
 * explicit task, not a by-product.
 */
export const NEO2 = {
  label: "DJI Neo 2",
  massG: 151,
  rotors: 4,
  blades: 2,
  propDiameterMm: 55.9,
  ducted: true,
  /** Blade-pass frequency = rpm/60 * blades. */
  bpfRangeHz: { lo: 667, hi: 1167 },
  rpmRangeHover: { lo: 20000, hi: 35000 },
  /** Search window for f0, wide enough to cover the whole plausible throttle range. */
  f0SearchHz: { lo: 500, hi: 1400 },
  /** Six to nine harmonics fit below 6 kHz at this spacing. */
  nHarmonics: 9,
  /**
   * A 32 g Dronetag Mini on a 151 g airframe is 21 percent more mass, and since
   * thrust goes with the square of rotor speed that is about 10 percent more RPM.
   * Every recording with ground truth carries this shift, which is why signatures
   * must not depend on absolute f0.
   */
  ridModuleMassG: 32,
  ridRpmShiftPct: 10,
} as const;

export interface StftPreset {
  id: string;
  label: string;
  fftSize: number;
  hop: number;
  windowKind: WindowKind;
  rationale: string;
}

/**
 * The trade-off between these two is the thing the application exists to make
 * visible: 4096 follows a comb through a manoeuvre, 8192 pulls the individual
 * rotors apart in a steady hover but smears any change.
 */
export const STFT_PRESETS: StftPreset[] = [
  {
    id: "neo2-track",
    label: "Neo 2 - track the comb",
    fftSize: 4096,
    hop: 1024,
    windowKind: WindowKind.Hann,
    rationale:
      "11.7 Hz bins over 85 ms. Follows f0 through spool-up and manoeuvres, but the four rotors merge into one comb.",
  },
  {
    id: "neo2-separate",
    label: "Neo 2 - separate the rotors",
    fftSize: 8192,
    hop: 2048,
    windowKind: WindowKind.Hann,
    rationale:
      "5.9 Hz bins over 171 ms. Resolves rotors roughly 10 Hz apart in a steady hover; too slow for transients.",
  },
  {
    id: "transient",
    label: "Transients",
    fftSize: 1024,
    hop: 256,
    windowKind: WindowKind.Hann,
    rationale:
      "21 ms frames for take-off and fast passes, at 46.9 Hz resolution which is far too coarse for the comb.",
  },
  {
    id: "lowest-sidelobe",
    label: "Low sidelobe survey",
    fftSize: 8192,
    hop: 2048,
    windowKind: WindowKind.BlackmanHarris,
    rationale:
      "Sidelobes below -90 dB, so a weak harmonic next to a strong one is real rather than leakage. Costs a third more bandwidth per bin.",
  },
];

/** Sensible defaults for a session before anything is known about it. */
export const DEFAULT_STFT = {
  fftSize: 4096,
  hop: 1024,
  windowKind: WindowKind.Hann,
  beta: 8.6,
  sampleRate: DEFAULT_SAMPLE_RATE,
};

export const DEFAULT_ENVIRONMENT = {
  tempC: 15,
  humidityPct: 60,
  pressurePa: 101325,
};
