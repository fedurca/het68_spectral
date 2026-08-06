/*
 * Message protocol between the UI and the DSP worker.
 *
 * Requests are coarse. One message computes six spectrograms or a whole
 * lag-by-time surface, because the audio never crosses the boundary more than once
 * and neither should the results. Every reply carries the wall-clock time the work
 * took, which is what the performance panel shows.
 */

import type {
  ChannelStats,
  F0Candidate,
  F0TrackPoint,
  GccResult,
  GeometryInfo,
  Signature,
  StftMetrics,
  SynthParams,
} from "@het68/dsp-core";

export interface BandSpec {
  id: string;
  loHz: number;
  hiHz: number;
}

export interface StftRequestParams {
  fftSize: number;
  winLength?: number;
  hop: number;
  windowKind: number;
  beta: number;
  floorDb: number;
}

export interface PairParams {
  blockLen: number;
  hop: number;
  nfft: number;
  usePhat: boolean;
  maxLag: number;
  fLoHz: number;
  fHiHz: number;
}

export type WorkerRequest =
  | { id: number; kind: "init" }
  | {
      id: number;
      kind: "setEnvironment";
      edgeMm: number;
      tempC: number;
      humidityPct: number;
      pressurePa: number;
      sampleRate: number;
    }
  | {
      id: number;
      kind: "loadAudio";
      planar: Float32Array;
      channels: number;
      frames: number;
      sampleRate: number;
      /** Offset of this buffer within the whole recording, for live capture. */
      startSample?: number;
    }
  | { id: number; kind: "stft"; params: StftRequestParams }
  | { id: number; kind: "phase"; channel: number }
  | { id: number; kind: "bands"; bands: BandSpec[]; noiseFloorPercentile: number }
  | { id: number; kind: "pairs"; params: PairParams }
  | { id: number; kind: "surface"; pair: number; params: PairParams }
  | {
      id: number;
      kind: "coherence";
      pair: number;
      nfft: number;
      hop: number;
      bands: BandSpec[];
    }
  | { id: number; kind: "health"; clipThreshold: number }
  | { id: number; kind: "mapping"; toneHz: number; slotMs: number }
  | {
      id: number;
      kind: "f0";
      channel: number;
      fLoHz: number;
      fHiHz: number;
      nHarmonics: number;
      blades: number;
      maxRelJump: number;
      maxMiss: number;
    }
  | {
      id: number;
      kind: "f0Frame";
      channel: number;
      frame: number;
      fLoHz: number;
      fHiHz: number;
      nHarmonics: number;
      blades: number;
    }
  | { id: number; kind: "cepstrum"; channel: number; frame: number }
  | {
      id: number;
      kind: "signatureExtract";
      channel: number;
      startSec: number;
      endSec: number;
      fLoHz: number;
      fHiHz: number;
      nHarmonics: number;
      blades: number;
      bandEdgesHz: number[];
    }
  | {
      id: number;
      kind: "signatureMatch";
      channel: number;
      signature: Signature;
      bandEdgesHz: number[];
    }
  | { id: number; kind: "synth"; params: SynthParams }
  | { id: number; kind: "spectrumFrame"; channel: number; frame: number }
  | { id: number; kind: "arena" };

export interface InitResult {
  version: number;
  maxFftSize: number;
  arena: { usedBytes: number; capacityBytes: number; plans: number };
}

export interface EnvironmentResult {
  soundSpeed: number;
  geometry: GeometryInfo;
  /** Air absorption at a few frequencies, for the range budget. */
  absorptionDbPerM: { freqHz: number; dbPerM: number }[];
}

export interface AudioLoadedResult {
  channels: number;
  frames: number;
  sampleRate: number;
  durationSec: number;
}

export interface StftResult {
  metrics: StftMetrics;
  frames: number;
  bins: number;
  channels: number;
  /** Channel-major dB, each block frames*bins. */
  db: Float32Array;
  /** Per channel min and max in dB, so the shared colour scale can be set. */
  ranges: { min: number; max: number }[];
}

export interface BandSeries {
  bandId: string;
  channel: number;
  /** Mean power in the band per frame, dB. */
  energyDb: Float32Array;
  /** Band energy above the band's own noise floor estimate, dB. */
  snrDb: Float32Array;
  /** Spectral flatness turned round: high means tonal. */
  tonality: Float32Array;
  noiseFloorDb: number;
}

export interface BandsResult {
  series: BandSeries[];
  frames: number;
}

export interface PairSeries {
  pair: number;
  i: number;
  j: number;
  lagSamples: Float32Array;
  lagMm: Float32Array;
  peakValue: Float32Array;
  peakRatio: Float32Array;
  times: Float32Array;
  /** True where the peak sits within one grating period of the second peak. */
  ambiguous: Uint8Array;
  baselineMm: number;
  opposite: boolean;
  gratingHz: number;
  maxLagSamples: number;
}

export interface PairsResult {
  pairs: PairSeries[];
  columns: number;
}

export interface SurfaceResult {
  pair: number;
  surface: Float32Array;
  columns: number;
  span: number;
  maxLag: number;
  times: Float32Array;
  peaks: GccResult[];
}

export interface CoherenceResult {
  pair: number;
  msc: Float32Array;
  binHz: number;
  frames: number;
  bands: { bandId: string; msc: number }[];
}

export interface HealthResult {
  stats: ChannelStats[];
  /** Full 6x6 Pearson matrix, row major, ones on the diagonal. */
  correlations: Float32Array;
  /** One line per channel when something is wrong with it. */
  findings: { channel: number; severity: "warn" | "error"; message: string }[];
}

export interface MappingResult {
  active: Int32Array;
  marginDb: Float32Array;
  /** Empty when every slot is where it should be. */
  problems: string[];
}

export interface F0Result {
  channel: number;
  track: F0TrackPoint[];
  /** Multiple combs per frame, which is how a quadcopter differs from one rotor. */
  combsPerFrame: Int32Array;
  medianF0Hz: number;
  medianRpm: number;
  lockedFraction: number;
}

export interface F0FrameResult {
  frame: number;
  candidates: F0Candidate[];
}

export interface SpectrumFrameResult {
  frame: number;
  channel: number;
  db: Float32Array;
  phase: Float32Array | null;
  binHz: number;
}

export interface CepstrumResult {
  frame: number;
  channel: number;
  cepstrum: Float32Array;
  quefrencySec: Float32Array;
}

export interface SignatureResult {
  signature: Signature;
  frames: number;
}

export interface SignatureMatchResult {
  score: Float32Array;
  f0: Float32Array;
}

export interface SynthResult {
  planar: Float32Array;
  channels: number;
  frames: number;
  sampleRate: number;
}

export type WorkerResultMap = {
  init: InitResult;
  setEnvironment: EnvironmentResult;
  loadAudio: AudioLoadedResult;
  stft: StftResult;
  phase: { channel: number; phase: Float32Array; frames: number; bins: number };
  bands: BandsResult;
  pairs: PairsResult;
  surface: SurfaceResult;
  coherence: CoherenceResult;
  health: HealthResult;
  mapping: MappingResult;
  f0: F0Result;
  f0Frame: F0FrameResult;
  cepstrum: CepstrumResult;
  signatureExtract: SignatureResult;
  signatureMatch: SignatureMatchResult;
  synth: SynthResult;
  spectrumFrame: SpectrumFrameResult;
  arena: { usedBytes: number; capacityBytes: number; plans: number };
};

/*
 * Every branch keeps `kind` a literal type, including the failure one, so that a
 * single check on it narrows the union. A `string` there would silently disable
 * discriminated narrowing and push the burden onto casts at every call site.
 */
export type WorkerResponse =
  | {
      id: number;
      ok: true;
      kind: keyof WorkerResultMap;
      result: WorkerResultMap[keyof WorkerResultMap];
      elapsedMs: number;
    }
  | {
      id: number;
      ok: false;
      kind: keyof WorkerResultMap;
      error: string;
      elapsedMs: number;
    }
  | { id: -1; ok: true; kind: "log"; message: string; elapsedMs: 0 };
