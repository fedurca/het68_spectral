import createModule from "../wasm/h68dsp.mjs";
import type { H68Module } from "../wasm/h68dsp.mjs";
import {
  WindowKind,
  type ChannelStats,
  type F0Candidate,
  type F0TrackPoint,
  type GccResult,
  type GccSurface,
  type GeometryInfo,
  type Signature,
  type StftMetrics,
  type SynthParams,
} from "./types.js";
import type { DoaParams, DoaRunResult } from "./doa-params.js";
import { DEFAULT_DOA_PARAMS } from "./doa-params.js";

/** Channels are microphones 1..6 with no permutation, matching the WAV layout. */
export const N_CHANNELS = 6;
export const N_PAIRS = 15;

/** Unordered pairs in the same order the C side uses. */
export const PAIRS: ReadonlyArray<readonly [number, number]> = (() => {
  const out: [number, number][] = [];
  for (let i = 0; i < N_CHANNELS; i++) {
    for (let j = i + 1; j < N_CHANNELS; j++) out.push([i, j]);
  }
  return out;
})();

const SIG_FLOATS = 60;
const SYNTH_FLOATS = 34;
const SYNTH_MAX_ROTORS = 8;
const STATS_PER_CHANNEL = 13;

export interface StftConfig {
  fftSize: number;
  /** Defaults to fftSize; a shorter window zero pads, interpolating the spectrum without adding resolution. */
  winLength?: number;
  hop: number;
  windowKind: WindowKind;
  /** Kaiser only. */
  beta?: number;
  sampleRate: number;
}

export interface GccOptions {
  blockLen: number;
  hop: number;
  /** Must be at least 2*blockLen so the correlation does not wrap. */
  nfft: number;
  usePhat: boolean;
  maxLag: number;
  fLoHz: number;
  fHiHz: number;
  sampleRate: number;
}

/**
 * Tracks wasm heap allocations made for one operation and releases them together.
 * The DSP itself never allocates; this is only the host side moving buffers across
 * the boundary.
 */
class Scratch {
  private readonly ptrs: number[] = [];
  constructor(private readonly m: H68Module) {}

  bytes(n: number): number {
    const p = this.m._h68_malloc(n);
    if (p === 0) throw new Error(`wasm allocation of ${n} bytes failed`);
    this.ptrs.push(p);
    return p;
  }

  floats(n: number): number {
    return this.bytes(n * 4);
  }

  ints(n: number): number {
    return this.bytes(n * 4);
  }

  /** Copies a typed array into fresh wasm memory. */
  copyFloats(src: Float32Array | ArrayLike<number>): number {
    const arr = src instanceof Float32Array ? src : Float32Array.from(src);
    const p = this.floats(arr.length);
    this.m.HEAPF32.set(arr, p >> 2);
    return p;
  }

  readFloats(ptr: number, n: number): Float32Array {
    // Sliced rather than subarray: the caller keeps the result after free(), and
    // a view into the heap would dangle or shift under memory growth.
    return this.m.HEAPF32.slice(ptr >> 2, (ptr >> 2) + n);
  }

  readInts(ptr: number, n: number): Int32Array {
    return this.m.HEAP32.slice(ptr >> 2, (ptr >> 2) + n);
  }

  release(): void {
    for (const p of this.ptrs) this.m._h68_free(p);
    this.ptrs.length = 0;
  }
}

function statusError(code: number, what: string): void {
  if (code >= 0) return;
  const names: Record<number, string> = {
    [-1]: "invalid argument",
    [-2]: "out of memory",
    [-3]: "not configured",
  };
  throw new Error(`${what}: ${names[code] ?? `error ${code}`}`);
}

/**
 * Typed front end for the C DSP core.
 *
 * Calls are deliberately coarse. A whole lag-by-time surface or a six-channel
 * spectrogram comes back from one call because crossing the JS/wasm boundary per
 * frame costs more than the arithmetic inside.
 */
export class DspCore {
  private constructor(private readonly m: H68Module) {}

  static async load(): Promise<DspCore> {
    const mod = await createModule();
    return new DspCore(mod as H68Module);
  }

  get version(): number {
    return this.m._h68_version();
  }

  get maxFftSize(): number {
    return this.m._h68_max_fft();
  }

  /** Static arena usage, which is only FFT plans. Surfaced for the debug panel. */
  arenaUsage(): { usedBytes: number; capacityBytes: number; plans: number } {
    return {
      usedBytes: this.m._h68_arena_used_bytes(),
      capacityBytes: this.m._h68_arena_capacity_bytes(),
      plans: this.m._h68_fft_plan_count(),
    };
  }

  // ---- geometry ---------------------------------------------------------

  soundSpeed(tempC: number, humidityPct: number, pressurePa = 101325): number {
    return this.m._h68_api_sound_speed(tempC, humidityPct, pressurePa);
  }

  airAbsorptionDbPerM(
    freqHz: number,
    tempC: number,
    humidityPct: number,
    pressurePa = 101325,
  ): number {
    return this.m._h68_api_air_absorption_db_per_m(
      freqHz,
      tempC,
      humidityPct,
      pressurePa,
    );
  }

  baselineMm(i: number, j: number, edgeMm: number): number {
    return this.m._h68_api_baseline_mm(i, j, edgeMm);
  }

  isOppositePair(i: number, j: number): boolean {
    return this.m._h68_api_pair_is_opposite(i, j) !== 0;
  }

  /** Positive lag means the wavefront reached j later than i. */
  expectedLagSamples(
    i: number,
    j: number,
    azDeg: number,
    elDeg: number,
    edgeMm: number,
    soundSpeed: number,
    sampleRate: number,
  ): number {
    return this.m._h68_api_expected_lag(
      i,
      j,
      azDeg,
      elDeg,
      edgeMm,
      soundSpeed,
      sampleRate,
    );
  }

  geometry(edgeMm: number, soundSpeed: number, sampleRate: number): GeometryInfo {
    const s = new Scratch(this.m);
    try {
      const pos = s.floats(18);
      this.m._h68_api_mic_positions(edgeMm, pos);
      const longB = this.m._h68_api_baseline_mm(0, 4, edgeMm);
      const shortB = this.m._h68_api_baseline_mm(0, 1, edgeMm);
      return {
        edgeMm,
        soundSpeed,
        sampleRate,
        longBaselineMm: longB,
        shortBaselineMm: shortB,
        gratingLongHz: this.m._h68_api_grating_hz(longB, soundSpeed),
        gratingShortHz: this.m._h68_api_grating_hz(shortB, soundSpeed),
        angularResolutionDeg: this.m._h68_api_angular_resolution_deg(
          edgeMm,
          soundSpeed,
          sampleRate,
        ),
        lagQuantumMm: this.m._h68_api_lag_quantum_mm(soundSpeed, sampleRate),
        firmwareMaxLag: this.m._h68_api_firmware_maxlag(edgeMm, sampleRate),
        firmwareSpan: this.m._h68_api_firmware_span(edgeMm, sampleRate, 256),
        farField6kHzM: this.m._h68_api_far_field_m(edgeMm, 6000, soundSpeed),
        micPositionsMm: s.readFloats(pos, 18),
      };
    } finally {
      s.release();
    }
  }

  // ---- STFT -------------------------------------------------------------

  configureStft(cfg: StftConfig): StftMetrics {
    const winLength = cfg.winLength ?? cfg.fftSize;
    const rc = this.m._h68_api_stft_configure(
      cfg.fftSize,
      winLength,
      cfg.hop,
      cfg.windowKind,
      cfg.beta ?? 8.6,
      cfg.sampleRate,
    );
    statusError(rc, "stft configure");
    return this.stftMetrics();
  }

  stftMetrics(): StftMetrics {
    const s = new Scratch(this.m);
    try {
      const p = s.floats(16);
      statusError(this.m._h68_api_stft_metrics(p), "stft metrics");
      const v = s.readFloats(p, 16);
      return {
        fftSize: v[0]!,
        hop: v[1]!,
        winLength: v[2]!,
        sampleRate: v[3]!,
        binHz: v[4]!,
        windowMs: v[5]!,
        hopMs: v[6]!,
        overlap: v[7]!,
        enbwBins: v[8]!,
        enbwHz: v[9]!,
        coherentGain: v[10]!,
        scallopDb: v[11]!,
        nenbw: v[12]!,
        sidelobeDb: v[13]!,
      };
    } finally {
      s.release();
    }
  }

  get bins(): number {
    return this.m._h68_api_stft_bins();
  }

  frameCount(nsamples: number): number {
    return this.m._h68_api_stft_frames(nsamples);
  }

  /** dBFS spectrogram for one channel, frames * bins, row major in time. */
  analyzeChannel(
    samples: Float32Array,
    floorDb = -140,
    wantPhase = false,
  ): { db: Float32Array; phase: Float32Array | null; frames: number; bins: number } {
    const bins = this.bins;
    const frames = this.frameCount(samples.length);
    if (frames <= 0) {
      return { db: new Float32Array(0), phase: null, frames: 0, bins };
    }
    const s = new Scratch(this.m);
    try {
      const x = s.copyFloats(samples);
      const out = s.floats(frames * bins);
      const ph = wantPhase ? s.floats(frames * bins) : 0;
      statusError(
        this.m._h68_api_stft_analyze(x, samples.length, floorDb, out, ph),
        "stft analyze",
      );
      return {
        db: s.readFloats(out, frames * bins),
        phase: wantPhase ? s.readFloats(ph, frames * bins) : null,
        frames,
        bins,
      };
    } finally {
      s.release();
    }
  }

  /**
   * All channels at once. `planar` holds nch consecutive blocks of nsamples; the
   * result holds nch consecutive blocks of frames*bins.
   */
  analyzeAll(
    planar: Float32Array,
    nch: number,
    nsamples: number,
    floorDb = -140,
  ): { db: Float32Array; frames: number; bins: number } {
    const bins = this.bins;
    const frames = this.frameCount(nsamples);
    if (frames <= 0) return { db: new Float32Array(0), frames: 0, bins };
    const s = new Scratch(this.m);
    try {
      const x = s.copyFloats(planar);
      const out = s.floats(nch * frames * bins);
      statusError(
        this.m._h68_api_stft_analyze_all(x, nch, nsamples, floorDb, out),
        "stft analyze all",
      );
      return { db: s.readFloats(out, nch * frames * bins), frames, bins };
    } finally {
      s.release();
    }
  }

  /** Linear magnitudes, which is what the harmonic and signature code expects. */
  magnitudeLinear(samples: Float32Array): {
    mag: Float32Array;
    frames: number;
    bins: number;
  } {
    const bins = this.bins;
    const frames = this.frameCount(samples.length);
    if (frames <= 0) return { mag: new Float32Array(0), frames: 0, bins };
    const s = new Scratch(this.m);
    try {
      const x = s.copyFloats(samples);
      const out = s.floats(frames * bins);
      statusError(
        this.m._h68_api_stft_magnitude_linear(x, samples.length, out),
        "stft magnitude",
      );
      return { mag: s.readFloats(out, frames * bins), frames, bins };
    } finally {
      s.release();
    }
  }

  // ---- watched bands ----------------------------------------------------

  /**
   * Band energy, tonality and peak frequency over time for every channel.
   *
   * The arithmetic is in C because the firmware does the same summation to decide
   * what it is hearing; a threshold read off a plot here is then the same number the
   * detector will compare against. `noisePercentile` sets which quantile of each
   * band's own history counts as its noise floor.
   */
  bandMetrics(
    planar: Float32Array,
    nch: number,
    nsamples: number,
    bands: ReadonlyArray<{ loHz: number; hiHz: number }>,
    noisePercentile = 0.1,
  ): {
    frames: number;
    nbands: number;
    energyDb: Float32Array;
    tonalityDb: Float32Array;
    peakHz: Float32Array;
    floorDb: Float32Array;
  } {
    const nbands = bands.length;
    const frames = this.frameCount(nsamples);
    if (nbands === 0 || frames <= 0) {
      return {
        frames: Math.max(frames, 0),
        nbands,
        energyDb: new Float32Array(0),
        tonalityDb: new Float32Array(0),
        peakHz: new Float32Array(0),
        floorDb: new Float32Array(0),
      };
    }
    const s = new Scratch(this.m);
    try {
      const planarPtr = s.copyFloats(planar);
      const lo = s.copyFloats(bands.map((b) => b.loHz));
      const hi = s.copyFloats(bands.map((b) => b.hiHz));
      const count = nch * nbands * frames;
      const energy = s.floats(count);
      const tonality = s.floats(count);
      const peak = s.floats(count);
      const floor = s.floats(nch * nbands);
      statusError(
        this.m._h68_api_band_metrics(
          planarPtr,
          nch,
          nsamples,
          lo,
          hi,
          nbands,
          noisePercentile,
          energy,
          tonality,
          peak,
          floor,
        ),
        "band metrics",
      );
      return {
        frames,
        nbands,
        energyDb: s.readFloats(energy, count),
        tonalityDb: s.readFloats(tonality, count),
        peakHz: s.readFloats(peak, count),
        floorDb: s.readFloats(floor, nch * nbands),
      };
    } finally {
      s.release();
    }
  }

  // ---- pairs ------------------------------------------------------------

  gccColumn(
    xi: Float32Array,
    xj: Float32Array,
    opts: Omit<GccOptions, "hop">,
  ): { corr: Float32Array; result: GccResult } {
    const span = 2 * opts.maxLag + 1;
    const s = new Scratch(this.m);
    try {
      const a = s.copyFloats(xi);
      const b = s.copyFloats(xj);
      const corr = s.floats(span);
      const stats = s.floats(6);
      statusError(
        this.m._h68_api_gcc_column(
          a,
          b,
          opts.blockLen,
          opts.nfft,
          opts.usePhat ? 1 : 0,
          opts.maxLag,
          opts.fLoHz,
          opts.fHiHz,
          opts.sampleRate,
          corr,
          stats,
        ),
        "gcc column",
      );
      const v = s.readFloats(stats, 6);
      return {
        corr: s.readFloats(corr, span),
        result: {
          peakLag: v[0]!,
          peakValue: v[1]!,
          secondLag: v[2]!,
          secondValue: v[3]!,
          peakRatio: v[4]!,
          peakIndex: v[5]!,
        },
      };
    } finally {
      s.release();
    }
  }

  /**
   * The lag-by-time surface for one pair. This is the view that answers whether a
   * delay is stable or hopping between grating lobes, which at a 384 mm edge is the
   * question the whole drone band raises.
   */
  gccSurface(xi: Float32Array, xj: Float32Array, opts: GccOptions): GccSurface {
    const nsamples = Math.min(xi.length, xj.length);
    const span = 2 * opts.maxLag + 1;
    const columns = this.m._h68_api_gcc_columns(
      nsamples,
      opts.blockLen,
      opts.hop,
    );
    if (columns <= 0) {
      return {
        surface: new Float32Array(0),
        columns: [],
        maxLag: opts.maxLag,
        times: new Float32Array(0),
      };
    }
    const s = new Scratch(this.m);
    try {
      const a = s.copyFloats(xi);
      const b = s.copyFloats(xj);
      const surf = s.floats(columns * span);
      const stats = s.floats(columns * 6);
      const rc = this.m._h68_api_gcc_surface(
        a,
        b,
        nsamples,
        opts.blockLen,
        opts.hop,
        opts.nfft,
        opts.usePhat ? 1 : 0,
        opts.maxLag,
        opts.fLoHz,
        opts.fHiHz,
        opts.sampleRate,
        surf,
        stats,
      );
      statusError(rc, "gcc surface");
      const raw = s.readFloats(stats, columns * 6);
      const cols: GccResult[] = [];
      const times = new Float32Array(columns);
      for (let c = 0; c < columns; c++) {
        cols.push({
          peakLag: raw[c * 6]!,
          peakValue: raw[c * 6 + 1]!,
          secondLag: raw[c * 6 + 2]!,
          secondValue: raw[c * 6 + 3]!,
          peakRatio: raw[c * 6 + 4]!,
          peakIndex: raw[c * 6 + 5]!,
        });
        times[c] = (c * opts.hop + opts.blockLen / 2) / opts.sampleRate;
      }
      return {
        surface: s.readFloats(surf, columns * span),
        columns: cols,
        maxLag: opts.maxLag,
        times,
      };
    } finally {
      s.release();
    }
  }

  /**
   * Welch-averaged magnitude-squared coherence. Coherence, not correlation, is what
   * says whether a band carries a usable delay, and it shows the effect of aliasing
   * directly.
   */
  coherence(
    xi: Float32Array,
    xj: Float32Array,
    nfft: number,
    hop: number,
    windowKind: WindowKind = WindowKind.Hann,
    beta = 8.6,
  ): { msc: Float32Array; frames: number } {
    const n = Math.min(xi.length, xj.length);
    const bins = nfft / 2 + 1;
    const s = new Scratch(this.m);
    try {
      const a = s.copyFloats(xi);
      const b = s.copyFloats(xj);
      const out = s.floats(bins);
      const frames = this.m._h68_api_coherence(
        a,
        b,
        n,
        nfft,
        hop,
        windowKind,
        beta,
        out,
      );
      statusError(frames, "coherence");
      return { msc: s.readFloats(out, bins), frames };
    } finally {
      s.release();
    }
  }

  /**
   * Mean coherence over a band, power weighted.
   *
   * Must be called directly after `coherence()` for the same pair: the weighting
   * uses the spectra accumulated by that call, which the next one overwrites.
   */
  coherenceBand(
    msc: Float32Array,
    nfft: number,
    sampleRate: number,
    fLoHz: number,
    fHiHz: number,
  ): number {
    const s = new Scratch(this.m);
    try {
      const p = s.copyFloats(msc);
      return this.m._h68_api_coherence_band(p, nfft, sampleRate, fLoHz, fHiHz);
    } finally {
      s.release();
    }
  }

  // ---- health -----------------------------------------------------------

  channelStats(
    planar: Float32Array,
    nch: number,
    n: number,
    clipThreshold = 0.999,
  ): ChannelStats[] {
    const s = new Scratch(this.m);
    try {
      const x = s.copyFloats(planar);
      const out = s.floats(nch * STATS_PER_CHANNEL);
      this.m._h68_api_channel_stats(x, nch, n, clipThreshold, out);
      const v = s.readFloats(out, nch * STATS_PER_CHANNEL);
      const res: ChannelStats[] = [];
      for (let c = 0; c < nch; c++) {
        const o = c * STATS_PER_CHANNEL;
        res.push({
          rms: v[o]!,
          rmsDb: v[o + 1]!,
          peak: v[o + 2]!,
          peakDb: v[o + 3]!,
          crestDb: v[o + 4]!,
          dc: v[o + 5]!,
          clippedSamples: v[o + 6]!,
          silentSamples: v[o + 7]!,
          noiseFloorDb: v[o + 8]!,
          zeroCrossingRate: v[o + 9]!,
          dead: v[o + 10]! !== 0,
          saturated: v[o + 11]! !== 0,
        });
      }
      return res;
    } finally {
      s.release();
    }
  }

  /** Pearson correlation for all 15 pairs, in PAIRS order. */
  channelCorrelations(planar: Float32Array, n: number): Float32Array {
    const s = new Scratch(this.m);
    try {
      const x = s.copyFloats(planar);
      const out = s.floats(N_PAIRS);
      this.m._h68_api_channel_correlations(x, n, out);
      return s.readFloats(out, N_PAIRS);
    } finally {
      s.release();
    }
  }

  /**
   * Which channel carries the tone in each slot of the 1 kHz / 100 ms alternating
   * calibration signal. A swapped pair here rotates every azimuth the array will
   * ever report, so this runs before anything else in a session.
   */
  mappingProbe(
    planar: Float32Array,
    nch: number,
    n: number,
    sampleRate: number,
    toneHz = 1000,
    slotMs = 100,
    maxSlots = 512,
  ): { active: Int32Array; marginDb: Float32Array } {
    const s = new Scratch(this.m);
    try {
      const x = s.copyFloats(planar);
      const active = s.ints(maxSlots);
      const margin = s.floats(maxSlots);
      const slots = this.m._h68_api_mapping_probe(
        x,
        nch,
        n,
        sampleRate,
        toneHz,
        slotMs,
        active,
        margin,
        maxSlots,
      );
      statusError(slots, "mapping probe");
      return {
        active: s.readInts(active, slots),
        marginDb: s.readFloats(margin, slots),
      };
    } finally {
      s.release();
    }
  }

  goertzel(x: Float32Array, freqHz: number, sampleRate: number): number {
    const s = new Scratch(this.m);
    try {
      const p = s.copyFloats(x);
      return this.m._h68_api_goertzel(p, x.length, freqHz, sampleRate);
    } finally {
      s.release();
    }
  }

  // ---- harmonic ---------------------------------------------------------

  f0Candidates(
    mag: Float32Array,
    binHz: number,
    fLoHz: number,
    fHiHz: number,
    nHarmonics: number,
    blades: number,
    maxOut = 8,
  ): F0Candidate[] {
    const s = new Scratch(this.m);
    try {
      const p = s.copyFloats(mag);
      const out = s.floats(maxOut * 5);
      const n = this.m._h68_api_f0_candidates(
        p,
        mag.length,
        binHz,
        fLoHz,
        fHiHz,
        nHarmonics,
        blades,
        out,
        maxOut,
      );
      statusError(n, "f0 candidates");
      const v = s.readFloats(out, Math.max(n, 0) * 5);
      const res: F0Candidate[] = [];
      for (let i = 0; i < n; i++) {
        res.push({
          f0Hz: v[i * 5]!,
          score: v[i * 5 + 1]!,
          rpm: v[i * 5 + 2]!,
          hnrDb: v[i * 5 + 3]!,
          nHarmonics: v[i * 5 + 4]!,
        });
      }
      return res;
    } finally {
      s.release();
    }
  }

  /** f0 across a whole spectrogram with continuity, in one call. */
  f0Track(
    mag: Float32Array,
    frames: number,
    bins: number,
    binHz: number,
    fLoHz: number,
    fHiHz: number,
    nHarmonics: number,
    blades: number,
    maxRelJump = 0.06,
    maxMiss = 5,
  ): F0TrackPoint[] {
    const s = new Scratch(this.m);
    try {
      const p = s.copyFloats(mag);
      const out = s.floats(frames * 4);
      statusError(
        this.m._h68_api_f0_track(
          p,
          frames,
          bins,
          binHz,
          fLoHz,
          fHiHz,
          nHarmonics,
          blades,
          maxRelJump,
          maxMiss,
          out,
        ),
        "f0 track",
      );
      const v = s.readFloats(out, frames * 4);
      const res: F0TrackPoint[] = [];
      for (let f = 0; f < frames; f++) {
        res.push({
          f0Hz: v[f * 4]!,
          rpm: v[f * 4 + 1]!,
          score: v[f * 4 + 2]!,
          locked: v[f * 4 + 3]! !== 0,
        });
      }
      return res;
    } finally {
      s.release();
    }
  }

  hnrDb(
    mag: Float32Array,
    binHz: number,
    f0Hz: number,
    nHarmonics: number,
    fLoHz: number,
    fHiHz: number,
  ): number {
    const s = new Scratch(this.m);
    try {
      const p = s.copyFloats(mag);
      return this.m._h68_api_hnr_db(
        p,
        mag.length,
        binHz,
        f0Hz,
        nHarmonics,
        fLoHz,
        fHiHz,
      );
    } finally {
      s.release();
    }
  }

  cepstrum(mag: Float32Array, cepstrumSize: number): Float32Array {
    const s = new Scratch(this.m);
    try {
      const p = s.copyFloats(mag);
      const out = s.floats(mag.length);
      statusError(
        this.m._h68_api_cepstrum(p, mag.length, cepstrumSize, out),
        "cepstrum",
      );
      return s.readFloats(out, mag.length);
    } finally {
      s.release();
    }
  }

  // ---- signatures -------------------------------------------------------

  signatureExtract(
    mag: Float32Array,
    frames: number,
    bins: number,
    binHz: number,
    fLoHz: number,
    fHiHz: number,
    nHarmonics: number,
    blades: number,
    bandEdgesHz: number[],
  ): Signature {
    const nBands = Math.max(bandEdgesHz.length - 1, 0);
    const s = new Scratch(this.m);
    try {
      const p = s.copyFloats(mag);
      const edges = s.copyFloats(bandEdgesHz);
      const out = s.floats(SIG_FLOATS);
      const rc = this.m._h68_api_signature_extract(
        p,
        frames,
        bins,
        binHz,
        fLoHz,
        fHiHz,
        nHarmonics,
        blades,
        edges,
        nBands,
        out,
      );
      statusError(rc, "signature extract");
      return decodeSignature(s.readFloats(out, SIG_FLOATS));
    } finally {
      s.release();
    }
  }

  signatureMatchFrames(
    sig: Signature,
    mag: Float32Array,
    frames: number,
    bins: number,
    binHz: number,
    bandEdgesHz: number[],
  ): { score: Float32Array; f0: Float32Array } {
    const s = new Scratch(this.m);
    try {
      const sp = s.copyFloats(encodeSignature(sig));
      const p = s.copyFloats(mag);
      const edges = s.copyFloats(bandEdgesHz);
      const out = s.floats(frames * 2);
      statusError(
        this.m._h68_api_signature_match_frames(
          sp,
          p,
          frames,
          bins,
          binHz,
          edges,
          out,
        ),
        "signature match",
      );
      const v = s.readFloats(out, frames * 2);
      const score = new Float32Array(frames);
      const f0 = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        score[f] = v[f * 2]!;
        f0[f] = v[f * 2 + 1]!;
      }
      return { score, f0 };
    } finally {
      s.release();
    }
  }

  signatureDistance(a: Signature, b: Signature): number {
    const s = new Scratch(this.m);
    try {
      return this.m._h68_api_signature_distance(
        s.copyFloats(encodeSignature(a)),
        s.copyFloats(encodeSignature(b)),
      );
    } finally {
      s.release();
    }
  }

  // ---- synthesis --------------------------------------------------------

  synthDefaultsNeo2(sampleRate: number, nSamples: number): SynthParams {
    const s = new Scratch(this.m);
    try {
      const out = s.floats(SYNTH_FLOATS);
      this.m._h68_api_synth_defaults_neo2(sampleRate, nSamples, out);
      return decodeSynth(s.readFloats(out, SYNTH_FLOATS));
    } finally {
      s.release();
    }
  }

  /** Renders a scene as planar 6-channel float, channel stride nSamples. */
  synthRender(params: SynthParams): Float32Array {
    const s = new Scratch(this.m);
    try {
      const p = s.copyFloats(encodeSynth(params));
      const out = s.floats(N_CHANNELS * params.nSamples);
      statusError(this.m._h68_api_synth_render(p, out), "synth render");
      return s.readFloats(out, N_CHANNELS * params.nSamples);
    } finally {
      s.release();
    }
  }

  // ---- firmware DOA (host/WASM shim) ------------------------------------

  doaSetParams(p: DoaParams): void {
    const s = new Scratch(this.m);
    try {
      const buf = s.floats(12);
      const heap = this.m.HEAPF32;
      const o = buf >> 2;
      heap[o] = p.edgeMm;
      heap[o + 1] = p.cMmS;
      heap[o + 2] = p.droneRms;
      heap[o + 3] = p.windRatio;
      heap[o + 4] = p.windRmsMin;
      heap[o + 5] = p.droneCrestMax;
      heap[o + 6] = p.droneConfMin;
      heap[o + 7] = p.vehRms;
      heap[o + 8] = p.birdRms;
      heap[o + 9] = p.walkRms;
      heap[o + 10] = p.pairMask;
      heap[o + 11] = p.logEnabled ? 1 : 0;
      this.m._h68_api_doa_params_set(buf);
    } finally {
      s.release();
    }
  }

  doaReset(): void {
    this.m._h68_api_doa_reset();
  }

  /**
   * Run the firmware DOA on planar float audio (converted to int16 like the
   * USB path). Returns captured SRC/TRACKS lines and track counts.
   */
  doaRun(
    planar: Float32Array,
    frames: number,
    params: DoaParams = DEFAULT_DOA_PARAMS,
  ): DoaRunResult {
    this.doaSetParams(params);
    this.doaReset();
    const s = new Scratch(this.m);
    try {
      const chunk = 512;
      const interleaved = s.bytes(chunk * 6 * 2);
      for (let off = 0; off < frames; off += chunk) {
        const n = Math.min(chunk, frames - off);
        const view = new Int16Array(this.m.HEAPU8.buffer, interleaved, n * 6);
        for (let i = 0; i < n; i++) {
          for (let c = 0; c < 6; c++) {
            const v = planar[c * frames + off + i] ?? 0;
            const clipped = Math.max(-1, Math.min(1, v));
            view[i * 6 + c] = (clipped * 20000) | 0;
          }
        }
        this.m._h68_api_doa_push(interleaved, n);
        this.m._h68_api_doa_step(n);
      }
      while (this.m._h68_api_doa_step(2048) > 0) {
        /* drain */
      }
      const cap = 64 * 1024;
      const dst = s.bytes(cap);
      const n = this.m._h68_api_doa_drain_lines(dst, cap);
      const bytes = this.m.HEAPU8.slice(dst, dst + Math.max(0, n));
      const text = new TextDecoder().decode(bytes);
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      return {
        lines,
        ndrone: this.m._h68_api_doa_ndrone(),
        nvehicle: this.m._h68_api_doa_nvehicle(),
        nbird: this.m._h68_api_doa_nbird(),
        nwalker: this.m._h68_api_doa_nwalker(),
        wind: this.m._h68_api_doa_wind() !== 0,
        windAz: this.m._h68_api_doa_wind_az(),
        windEl: this.m._h68_api_doa_wind_el(),
      };
    } finally {
      s.release();
    }
  }
}

// ---- flat array codecs ---------------------------------------------------
// Layouts mirror the comments in csrc/h68_api.c. Keeping them in one place means a
// field added on the C side breaks here loudly rather than shifting every value
// after it silently.

function decodeSignature(v: Float32Array): Signature {
  const nHarm = v[3]!;
  const nBands = v[4]!;
  const nCombs = v[2]!;
  return {
    version: v[0]!,
    blades: v[1]!,
    combRatios: Array.from(v.slice(12, 12 + nCombs)),
    harmonicRelDb: Array.from(v.slice(20, 20 + nHarm)),
    harmonicSdDb: Array.from(v.slice(36, 36 + nHarm)),
    bandRelDb: Array.from(v.slice(52, 52 + nBands)),
    hnrDb: v[5]!,
    hnrSdDb: v[6]!,
    f0GateLoHz: v[7]!,
    f0GateHiHz: v[8]!,
    f0DriftPct: v[9]!,
    modDepthDb: v[10]!,
    nFrames: v[11]!,
  };
}

function encodeSignature(s: Signature): Float32Array {
  const v = new Float32Array(SIG_FLOATS);
  v[0] = s.version;
  v[1] = s.blades;
  v[2] = s.combRatios.length;
  v[3] = s.harmonicRelDb.length;
  v[4] = s.bandRelDb.length;
  v[5] = s.hnrDb;
  v[6] = s.hnrSdDb;
  v[7] = s.f0GateLoHz;
  v[8] = s.f0GateHiHz;
  v[9] = s.f0DriftPct;
  v[10] = s.modDepthDb;
  v[11] = s.nFrames;
  v.set(s.combRatios.slice(0, 8), 12);
  v.set(s.harmonicRelDb.slice(0, 16), 20);
  v.set(s.harmonicSdDb.slice(0, 16), 36);
  v.set(s.bandRelDb.slice(0, 8), 52);
  return v;
}

function decodeSynth(v: Float32Array): SynthParams {
  return {
    sampleRate: v[0]!,
    nSamples: v[1]!,
    edgeMm: v[2]!,
    tempC: v[3]!,
    humidityPct: v[4]!,
    pressurePa: v[5]!,
    airAbsorption: v[6]! !== 0,
    azDeg: v[7]!,
    elDeg: v[8]!,
    distanceM: v[9]!,
    nRotors: v[10]!,
    blades: v[11]!,
    rpmJitterPct: v[12]!,
    rpmRampPct: v[13]!,
    nHarmonics: v[14]!,
    harmonicRolloffDb: v[15]!,
    tonalLevelDb: v[16]!,
    broadbandLevelDb: v[17]!,
    broadbandLoHz: v[18]!,
    broadbandHiHz: v[19]!,
    windLevelDb: v[20]!,
    windCutoffHz: v[21]!,
    backgroundLevelDb: v[22]!,
    toneHz: v[23]!,
    toneLevelDb: v[24]!,
    seed: v[25]!,
    rpm: Array.from(v.slice(26, 26 + SYNTH_MAX_ROTORS)),
  };
}

function encodeSynth(p: SynthParams): Float32Array {
  const v = new Float32Array(SYNTH_FLOATS);
  v[0] = p.sampleRate;
  v[1] = p.nSamples;
  v[2] = p.edgeMm;
  v[3] = p.tempC;
  v[4] = p.humidityPct;
  v[5] = p.pressurePa;
  v[6] = p.airAbsorption ? 1 : 0;
  v[7] = p.azDeg;
  v[8] = p.elDeg;
  v[9] = p.distanceM;
  v[10] = p.nRotors;
  v[11] = p.blades;
  v[12] = p.rpmJitterPct;
  v[13] = p.rpmRampPct;
  v[14] = p.nHarmonics;
  v[15] = p.harmonicRolloffDb;
  v[16] = p.tonalLevelDb;
  v[17] = p.broadbandLevelDb;
  v[18] = p.broadbandLoHz;
  v[19] = p.broadbandHiHz;
  v[20] = p.windLevelDb;
  v[21] = p.windCutoffHz;
  v[22] = p.backgroundLevelDb;
  v[23] = p.toneHz;
  v[24] = p.toneLevelDb;
  v[25] = p.seed;
  for (let i = 0; i < SYNTH_MAX_ROTORS; i++) v[26 + i] = p.rpm[i] ?? 0;
  return v;
}
