/** Windows the analyzer offers, matching h68_window_kind in C. */
export const WindowKind = {
  Rect: 0,
  Hann: 1,
  Hamming: 2,
  BlackmanHarris: 3,
  Kaiser: 4,
} as const;

export type WindowKind = (typeof WindowKind)[keyof typeof WindowKind];

export const WINDOW_LABELS: Record<WindowKind, string> = {
  [WindowKind.Rect]: "Rectangular",
  [WindowKind.Hann]: "Hann",
  [WindowKind.Hamming]: "Hamming",
  [WindowKind.BlackmanHarris]: "Blackman-Harris",
  [WindowKind.Kaiser]: "Kaiser",
};

/**
 * Derived properties of the current analysis window. These are the numbers that
 * decide whether a harmonic comb can be resolved, so they are meant to be on
 * screen rather than buried: a Neo 2's rotors sit about 10 Hz apart, which is
 * below `binHz` at anything shorter than 4096 samples.
 */
export interface StftMetrics {
  fftSize: number;
  hop: number;
  winLength: number;
  sampleRate: number;
  /** Frequency resolution of the transform, sampleRate / fftSize. */
  binHz: number;
  /** Time extent of one frame. */
  windowMs: number;
  hopMs: number;
  /** Fraction, so 0.75 means each frame shares three quarters with the last. */
  overlap: number;
  /** Equivalent noise bandwidth, in bins and in Hz. */
  enbwBins: number;
  enbwHz: number;
  /** sum(w)/N; a tone's true amplitude is recovered by dividing this out. */
  coherentGain: number;
  /** Worst-case attenuation for a tone falling between two bin centres. */
  scallopDb: number;
  nenbw: number;
  /** Highest sidelobe, measured from the window's transform rather than tabulated. */
  sidelobeDb: number;
}

export interface GccResult {
  /** Parabolically interpolated peak position, in samples. */
  peakLag: number;
  /** 1.0 means a perfectly coherent single delay. */
  peakValue: number;
  secondLag: number;
  secondValue: number;
  /**
   * peakValue / secondValue. Near 1 the delay is ambiguous, which is what spatial
   * aliasing looks like above c/(2*baseline) and is unavoidable across the whole
   * drone band at a 384 mm edge.
   */
  peakRatio: number;
  peakIndex: number;
}

export interface GccSurface {
  /** columns * (2*maxLag+1), column major in time. */
  surface: Float32Array;
  /** Per-column peak statistics. */
  columns: GccResult[];
  maxLag: number;
  /** Time of each column's centre, in seconds. */
  times: Float32Array;
}

export interface ChannelStats {
  rms: number;
  rmsDb: number;
  peak: number;
  peakDb: number;
  crestDb: number;
  dc: number;
  clippedSamples: number;
  silentSamples: number;
  noiseFloorDb: number;
  zeroCrossingRate: number;
  dead: boolean;
  saturated: boolean;
}

export interface F0Candidate {
  f0Hz: number;
  /** Comb salience above the local noise floor, in dB. */
  score: number;
  /** Shaft speed, the unit in which an implausible answer is obvious. */
  rpm: number;
  hnrDb: number;
  nHarmonics: number;
}

export interface F0TrackPoint {
  f0Hz: number;
  rpm: number;
  score: number;
  locked: boolean;
}

/**
 * Everything here is invariant to absolute rotor speed. That is not a stylistic
 * choice: ground truth requires a 32 g Dronetag Mini on a 151 g airframe, which
 * lifts hover RPM by roughly 10 percent, so any template keyed to an absolute f0
 * would describe the instrumented aircraft rather than the stock one.
 */
export interface Signature {
  version: number;
  blades: number;
  /** Rotor rates relative to the mean of the set, ascending. */
  combRatios: number[];
  /** Harmonic levels relative to the fundamental, in dB. */
  harmonicRelDb: number[];
  /** Spread of each harmonic across the frames the template was built from. */
  harmonicSdDb: number[];
  /** Band energies relative to the total, in dB. */
  bandRelDb: number[];
  hnrDb: number;
  hnrSdDb: number;
  /** Acceptance gate only; deliberately wide and not a discriminator. */
  f0GateLoHz: number;
  f0GateHiHz: number;
  f0DriftPct: number;
  modDepthDb: number;
  /** Frames that actually contributed. Zero means no comb was found. */
  nFrames: number;
}

export interface SignatureMatch {
  /** 0..1, where 1 is a perfect match. */
  score: number;
  f0Hz: number;
}

/** Parameters for the synthetic scene generator. */
export interface SynthParams {
  sampleRate: number;
  nSamples: number;
  edgeMm: number;
  tempC: number;
  humidityPct: number;
  pressurePa: number;
  airAbsorption: boolean;
  azDeg: number;
  elDeg: number;
  distanceM: number;
  /** Independent rates per rotor; equal rates would hide the beating that is a multirotor's most distinctive feature. */
  rpm: number[];
  nRotors: number;
  blades: number;
  rpmJitterPct: number;
  rpmRampPct: number;
  nHarmonics: number;
  harmonicRolloffDb: number;
  tonalLevelDb: number;
  broadbandLevelDb: number;
  broadbandLoHz: number;
  broadbandHiHz: number;
  windLevelDb: number;
  windCutoffHz: number;
  backgroundLevelDb: number;
  /** A pure tone, for demonstrating grating lobes. */
  toneHz: number;
  toneLevelDb: number;
  seed: number;
}

/** Geometry facts derived from the current edge length and medium. */
export interface GeometryInfo {
  edgeMm: number;
  soundSpeed: number;
  sampleRate: number;
  /** 3 opposite pairs at the full edge, 12 adjacent at edge/sqrt(2). */
  longBaselineMm: number;
  shortBaselineMm: number;
  gratingLongHz: number;
  gratingShortHz: number;
  angularResolutionDeg: number;
  lagQuantumMm: number;
  /** The firmware's own correlation budget, recomputed the way doa.c does it. */
  firmwareMaxLag: number;
  firmwareSpan: number;
  farField6kHzM: number;
  micPositionsMm: Float32Array;
}
