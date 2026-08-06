/// <reference lib="webworker" />
/*
 * The DSP worker.
 *
 * Everything expensive happens here so the spectrogram stays interactive while a
 * minute of six-channel audio is transformed. The worker owns the audio: it is sent
 * once, and every later request names what to compute rather than resending it.
 *
 * Results leave as transferable buffers, so a 20 MB spectrogram moves by handing
 * over its memory rather than by copying it.
 */

import {
  DspCore,
  N_CHANNELS,
  N_PAIRS,
  PAIRS,
  WindowKind,
  type DoaParams,
  type F0TrackPoint,
} from "@het68/dsp-core";
import type {
  BandSeries,
  BandsResult,
  CoherenceResult,
  EnvironmentResult,
  F0Result,
  HealthResult,
  MappingResult,
  PairSeries,
  PairsResult,
  StftResult,
  SurfaceResult,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.js";

interface AudioState {
  planar: Float32Array;
  channels: number;
  frames: number;
  sampleRate: number;
}

interface StftState {
  frames: number;
  bins: number;
  binHz: number;
  hopSec: number;
  hop: number;
}

let core: DspCore | null = null;
let audio: AudioState | null = null;
let stft: StftState | null = null;

/** Cached linear magnitudes for one channel, since harmonic work reuses them. */
let magCache: { channel: number; mag: Float32Array; frames: number; bins: number } | null =
  null;

let edgeMm = 384;
let soundSpeed = 340.3;

function requireCore(): DspCore {
  if (!core) throw new Error("DSP core not initialised");
  return core;
}

function requireAudio(): AudioState {
  if (!audio) throw new Error("No audio loaded");
  return audio;
}

function requireStft(): StftState {
  if (!stft) throw new Error("Run an STFT first");
  return stft;
}

function channel(index: number): Float32Array {
  const a = requireAudio();
  if (index < 0 || index >= a.channels) {
    throw new Error(`Channel ${index} out of range (0..${a.channels - 1})`);
  }
  return a.planar.subarray(index * a.frames, (index + 1) * a.frames);
}

function magnitudes(index: number) {
  const a = requireAudio();
  if (magCache && magCache.channel === index) return magCache;
  const m = requireCore().magnitudeLinear(channel(index));
  magCache = { channel: index, mag: m.mag, frames: m.frames, bins: m.bins };
  void a;
  return magCache;
}

function median(values: ArrayLike<number>): number {
  const arr = Array.from(values).filter((v) => Number.isFinite(v) && v > 0);
  if (arr.length === 0) return 0;
  arr.sort((a, b) => a - b);
  return arr[arr.length >> 1]!;
}

// ---- handlers -------------------------------------------------------------

async function handleInit() {
  core = await DspCore.load();
  return {
    result: {
      version: core.version,
      maxFftSize: core.maxFftSize,
      arena: core.arenaUsage(),
    },
    transfer: [] as Transferable[],
  };
}

function handleEnvironment(req: Extract<WorkerRequest, { kind: "setEnvironment" }>) {
  const c = requireCore();
  edgeMm = req.edgeMm;
  soundSpeed = c.soundSpeed(req.tempC, req.humidityPct, req.pressurePa);
  const geometry = c.geometry(edgeMm, soundSpeed, req.sampleRate);
  // A few frequencies across the drone band: at 100 m the difference between the
  // bottom and the top of it is the difference between audible and not.
  const absorptionDbPerM = [500, 1000, 2000, 4000, 6000, 8000].map((freqHz) => ({
    freqHz,
    dbPerM: c.airAbsorptionDbPerM(freqHz, req.tempC, req.humidityPct, req.pressurePa),
  }));
  const result: EnvironmentResult = { soundSpeed, geometry, absorptionDbPerM };
  return { result, transfer: [geometry.micPositionsMm.buffer] as Transferable[] };
}

function handleLoadAudio(req: Extract<WorkerRequest, { kind: "loadAudio" }>) {
  audio = {
    planar: req.planar,
    channels: req.channels,
    frames: req.frames,
    sampleRate: req.sampleRate,
  };
  stft = null;
  magCache = null;
  return {
    result: {
      channels: req.channels,
      frames: req.frames,
      sampleRate: req.sampleRate,
      durationSec: req.frames / req.sampleRate,
    },
    transfer: [] as Transferable[],
  };
}

function handleStft(req: Extract<WorkerRequest, { kind: "stft" }>) {
  const c = requireCore();
  const a = requireAudio();
  const metrics = c.configureStft({
    fftSize: req.params.fftSize,
    winLength: req.params.winLength,
    hop: req.params.hop,
    windowKind: req.params.windowKind as WindowKind,
    beta: req.params.beta,
    sampleRate: a.sampleRate,
  });
  const out = c.analyzeAll(a.planar, a.channels, a.frames, req.params.floorDb);
  stft = {
    frames: out.frames,
    bins: out.bins,
    binHz: metrics.binHz,
    hopSec: metrics.hop / a.sampleRate,
    hop: metrics.hop,
  };
  magCache = null;

  const ranges: { min: number; max: number }[] = [];
  const stride = out.frames * out.bins;
  for (let ch = 0; ch < a.channels; ch++) {
    let min = Infinity;
    let max = -Infinity;
    const base = ch * stride;
    for (let i = 0; i < stride; i++) {
      const v = out.db[base + i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ranges.push({ min, max });
  }

  const result: StftResult = {
    metrics,
    frames: out.frames,
    bins: out.bins,
    channels: a.channels,
    db: out.db,
    ranges,
  };
  return { result, transfer: [out.db.buffer] as Transferable[] };
}

function handlePhase(req: Extract<WorkerRequest, { kind: "phase" }>) {
  const s = requireStft();
  const out = requireCore().analyzeChannel(channel(req.channel), -140, true);
  const phase = out.phase ?? new Float32Array(0);
  return {
    result: { channel: req.channel, phase, frames: s.frames, bins: s.bins },
    transfer: [phase.buffer] as Transferable[],
  };
}

function handleBands(req: Extract<WorkerRequest, { kind: "bands" }>) {
  const a = requireAudio();
  const s = requireStft();
  const m = requireCore().bandMetrics(
    a.planar,
    a.channels,
    a.frames,
    req.bands,
    req.noiseFloorPercentile,
  );

  const series: BandSeries[] = [];
  const transfer: Transferable[] = [];
  for (let ch = 0; ch < a.channels; ch++) {
    for (let b = 0; b < req.bands.length; b++) {
      const base = (ch * req.bands.length + b) * m.frames;
      const energyDb = m.energyDb.slice(base, base + m.frames);
      const tonality = m.tonalityDb.slice(base, base + m.frames);
      const floor = m.floorDb[ch * req.bands.length + b]!;
      const snrDb = new Float32Array(m.frames);
      for (let f = 0; f < m.frames; f++) snrDb[f] = energyDb[f]! - floor;
      series.push({
        bandId: req.bands[b]!.id,
        channel: ch,
        energyDb,
        snrDb,
        tonality,
        noiseFloorDb: floor,
      });
      transfer.push(energyDb.buffer, snrDb.buffer, tonality.buffer);
    }
  }
  void s;
  const result: BandsResult = { series, frames: m.frames };
  return { result, transfer };
}

function pairParams(req: { params: import("./protocol.js").PairParams }) {
  const a = requireAudio();
  return { ...req.params, sampleRate: a.sampleRate };
}

function handlePairs(req: Extract<WorkerRequest, { kind: "pairs" }>) {
  const c = requireCore();
  const a = requireAudio();
  const opts = pairParams(req);
  const lagQuantumMm = (soundSpeed / a.sampleRate) * 1000;

  const pairs: PairSeries[] = [];
  const transfer: Transferable[] = [];
  let columns = 0;

  for (let p = 0; p < N_PAIRS; p++) {
    const [i, j] = PAIRS[p]!;
    const surf = c.gccSurface(channel(i), channel(j), opts);
    columns = surf.columns.length;
    const lagSamples = new Float32Array(columns);
    const lagMm = new Float32Array(columns);
    const peakValue = new Float32Array(columns);
    const peakRatio = new Float32Array(columns);
    const ambiguous = new Uint8Array(columns);

    for (let k = 0; k < columns; k++) {
      const col = surf.columns[k]!;
      lagSamples[k] = col.peakLag;
      lagMm[k] = col.peakLag * lagQuantumMm;
      peakValue[k] = col.peakValue;
      peakRatio[k] = col.peakRatio;
      // A runner-up almost as tall as the winner is the signature of a grating
      // lobe rather than of noise, and at this edge length the whole drone band is
      // above the grating frequency, so it is expected rather than exceptional.
      ambiguous[k] = col.peakRatio > 0.8 ? 1 : 0;
    }

    const baselineMm = c.baselineMm(i, j, edgeMm);
    pairs.push({
      pair: p,
      i,
      j,
      lagSamples,
      lagMm,
      peakValue,
      peakRatio,
      times: surf.times,
      ambiguous,
      baselineMm,
      opposite: c.isOppositePair(i, j),
      gratingHz: (soundSpeed / (2 * (baselineMm / 1000))),
      maxLagSamples: (baselineMm / 1000 / soundSpeed) * a.sampleRate,
    });
    transfer.push(
      lagSamples.buffer,
      lagMm.buffer,
      peakValue.buffer,
      peakRatio.buffer,
      surf.times.buffer,
      ambiguous.buffer,
    );
  }

  const result: PairsResult = { pairs, columns };
  return { result, transfer };
}

function handleSurface(req: Extract<WorkerRequest, { kind: "surface" }>) {
  const c = requireCore();
  const [i, j] = PAIRS[req.pair]!;
  const surf = c.gccSurface(channel(i), channel(j), pairParams(req));
  const result: SurfaceResult = {
    pair: req.pair,
    surface: surf.surface,
    columns: surf.columns.length,
    span: 2 * surf.maxLag + 1,
    maxLag: surf.maxLag,
    times: surf.times,
    peaks: surf.columns,
  };
  return { result, transfer: [surf.surface.buffer, surf.times.buffer] as Transferable[] };
}

function handleCoherence(req: Extract<WorkerRequest, { kind: "coherence" }>) {
  const c = requireCore();
  const a = requireAudio();
  const [i, j] = PAIRS[req.pair]!;
  const { msc, frames } = c.coherence(
    channel(i),
    channel(j),
    req.nfft,
    req.hop,
    WindowKind.Hann,
  );
  const bands = req.bands.map((b) => ({
    bandId: b.id,
    msc: c.coherenceBand(msc, req.nfft, a.sampleRate, b.loHz, b.hiHz),
  }));
  const result: CoherenceResult = {
    pair: req.pair,
    msc,
    binHz: a.sampleRate / req.nfft,
    frames,
    bands,
  };
  return { result, transfer: [msc.buffer] as Transferable[] };
}

function handleHealth(req: Extract<WorkerRequest, { kind: "health" }>) {
  const c = requireCore();
  const a = requireAudio();
  const stats = c.channelStats(a.planar, a.channels, a.frames, req.clipThreshold);
  // The core returns the 15 unordered pairs; the panel reads a full 6x6 grid, so the
  // mirror and the unit diagonal are filled in here rather than at every lookup.
  const pairCorrelations = c.channelCorrelations(a.planar, a.frames);
  const correlations = new Float32Array(N_CHANNELS * N_CHANNELS);
  for (let i = 0; i < N_CHANNELS; i++) correlations[i * N_CHANNELS + i] = 1;
  PAIRS.forEach(([i, j], p) => {
    const v = pairCorrelations[p]!;
    correlations[i * N_CHANNELS + j] = v;
    correlations[j * N_CHANNELS + i] = v;
  });

  const findings: HealthResult["findings"] = [];
  const rms = stats.map((s) => s.rmsDb);
  const median = [...rms].sort((x, y) => x - y)[rms.length >> 1]!;

  stats.forEach((s, ch) => {
    if (s.dead) {
      findings.push({
        channel: ch,
        severity: "error",
        message: `Channel ${ch + 1} is dead (${s.rmsDb.toFixed(1)} dBFS RMS). Every spatial result is invalid until this is fixed.`,
      });
    }
    if (s.saturated || s.clippedSamples > 0) {
      findings.push({
        channel: ch,
        severity: s.saturated ? "error" : "warn",
        message: `Channel ${ch + 1} clipped ${s.clippedSamples} samples. A clipped microphone fabricates harmonics that look exactly like a rotor comb.`,
      });
    }
    if (Math.abs(s.dc) > 0.01) {
      findings.push({
        channel: ch,
        severity: "warn",
        message: `Channel ${ch + 1} has a DC offset of ${s.dc.toFixed(4)}, which biases every correlation.`,
      });
    }
    if (!s.dead && Math.abs(s.rmsDb - median) > 6) {
      findings.push({
        channel: ch,
        severity: "warn",
        message: `Channel ${ch + 1} sits ${(s.rmsDb - median).toFixed(1)} dB from the array median. There is no per-channel gain correction anywhere in the project, so this has to be measured here.`,
      });
    }
  });

  const result: HealthResult = { stats, correlations, findings };
  return { result, transfer: [correlations.buffer] as Transferable[] };
}

function handleMapping(req: Extract<WorkerRequest, { kind: "mapping" }>) {
  const c = requireCore();
  const a = requireAudio();
  const { active, marginDb } = c.mappingProbe(
    a.planar,
    a.channels,
    a.frames,
    a.sampleRate,
    req.toneHz,
    req.slotMs,
  );

  const problems: string[] = [];
  for (let s = 0; s < active.length; s++) {
    const expected = s % a.channels;
    if (active[s] !== expected) {
      problems.push(
        `Slot ${s} carried the tone on channel ${active[s]! + 1}, expected channel ${expected + 1}.`,
      );
    } else if (marginDb[s]! < 12) {
      problems.push(
        `Slot ${s} is on the right channel but only ${marginDb[s]!.toFixed(1)} dB above the next one; the calibration signal may be too quiet or the channels are crosstalking.`,
      );
    }
  }
  if (problems.length > 0) {
    problems.unshift(
      "Channel mapping does not match the 1 kHz / 100 ms sequence. A swapped pair rotates every azimuth the array will ever report.",
    );
  }

  const result: MappingResult = { active, marginDb, problems };
  return { result, transfer: [active.buffer, marginDb.buffer] as Transferable[] };
}

function handleF0(req: Extract<WorkerRequest, { kind: "f0" }>) {
  const c = requireCore();
  const s = requireStft();
  const m = magnitudes(req.channel);

  const track: F0TrackPoint[] = c.f0Track(
    m.mag,
    m.frames,
    m.bins,
    s.binHz,
    req.fLoHz,
    req.fHiHz,
    req.nHarmonics,
    req.blades,
    req.maxRelJump,
    req.maxMiss,
  );

  // How many combs each frame supports. Four rotors at slightly different speeds is
  // the most characteristic thing a multirotor does, and a single-rotor source or
  // background simply cannot produce it.
  const combsPerFrame = new Int32Array(m.frames);
  for (let f = 0; f < m.frames; f++) {
    const row = m.mag.subarray(f * m.bins, (f + 1) * m.bins);
    combsPerFrame[f] = c.f0Candidates(
      row,
      s.binHz,
      req.fLoHz,
      req.fHiHz,
      req.nHarmonics,
      req.blades,
    ).length;
  }

  const locked = track.filter((p) => p.locked);
  const result: F0Result = {
    channel: req.channel,
    track,
    combsPerFrame,
    medianF0Hz: median(locked.map((p) => p.f0Hz)),
    medianRpm: median(locked.map((p) => p.rpm)),
    lockedFraction: track.length === 0 ? 0 : locked.length / track.length,
  };
  return { result, transfer: [combsPerFrame.buffer] as Transferable[] };
}

function handleF0Frame(req: Extract<WorkerRequest, { kind: "f0Frame" }>) {
  const s = requireStft();
  const m = magnitudes(req.channel);
  const f = Math.min(Math.max(req.frame, 0), m.frames - 1);
  const row = m.mag.subarray(f * m.bins, (f + 1) * m.bins);
  return {
    result: {
      frame: f,
      candidates: requireCore().f0Candidates(
        row,
        s.binHz,
        req.fLoHz,
        req.fHiHz,
        req.nHarmonics,
        req.blades,
      ),
    },
    transfer: [] as Transferable[],
  };
}

function handleCepstrum(req: Extract<WorkerRequest, { kind: "cepstrum" }>) {
  const a = requireAudio();
  const m = magnitudes(req.channel);
  const f = Math.min(Math.max(req.frame, 0), m.frames - 1);
  const row = m.mag.subarray(f * m.bins, (f + 1) * m.bins);
  const cepstrum = requireCore().cepstrum(row, (m.bins - 1) * 2);
  const quefrencySec = new Float32Array(cepstrum.length);
  for (let i = 0; i < cepstrum.length; i++) quefrencySec[i] = i / a.sampleRate;
  return {
    result: { frame: f, channel: req.channel, cepstrum, quefrencySec },
    transfer: [cepstrum.buffer, quefrencySec.buffer] as Transferable[],
  };
}

function handleSpectrumFrame(req: Extract<WorkerRequest, { kind: "spectrumFrame" }>) {
  const s = requireStft();
  const out = requireCore().analyzeChannel(channel(req.channel), -140, true);
  const f = Math.min(Math.max(req.frame, 0), out.frames - 1);
  const db = out.db.slice(f * out.bins, (f + 1) * out.bins);
  const phase = out.phase ? out.phase.slice(f * out.bins, (f + 1) * out.bins) : null;
  return {
    result: { frame: f, channel: req.channel, db, phase, binHz: s.binHz },
    transfer: phase
      ? ([db.buffer, phase.buffer] as Transferable[])
      : ([db.buffer] as Transferable[]),
  };
}

function handleSignatureExtract(
  req: Extract<WorkerRequest, { kind: "signatureExtract" }>,
) {
  const c = requireCore();
  const a = requireAudio();
  const s = requireStft();
  const m = magnitudes(req.channel);

  const fromFrame = Math.max(0, Math.floor((req.startSec * a.sampleRate) / s.hop));
  const toFrame = Math.min(m.frames, Math.ceil((req.endSec * a.sampleRate) / s.hop));
  const frames = Math.max(0, toFrame - fromFrame);
  if (frames === 0) throw new Error("The selected range contains no whole frames");

  const slice = m.mag.subarray(fromFrame * m.bins, toFrame * m.bins);
  const signature = c.signatureExtract(
    slice,
    frames,
    m.bins,
    s.binHz,
    req.fLoHz,
    req.fHiHz,
    req.nHarmonics,
    req.blades,
    req.bandEdgesHz,
  );
  return { result: { signature, frames }, transfer: [] as Transferable[] };
}

function handleSignatureMatch(
  req: Extract<WorkerRequest, { kind: "signatureMatch" }>,
) {
  const s = requireStft();
  const m = magnitudes(req.channel);
  const { score, f0 } = requireCore().signatureMatchFrames(
    req.signature,
    m.mag,
    m.frames,
    m.bins,
    s.binHz,
    req.bandEdgesHz,
  );
  return { result: { score, f0 }, transfer: [score.buffer, f0.buffer] as Transferable[] };
}

function handleSynth(req: Extract<WorkerRequest, { kind: "synth" }>) {
  const c = requireCore();
  const planar = c.synthRender(req.params);
  return {
    result: {
      planar,
      channels: N_CHANNELS,
      frames: req.params.nSamples,
      sampleRate: req.params.sampleRate,
    },
    transfer: [planar.buffer] as Transferable[],
  };
}

function applySweepKey(base: DoaParams, key: string, value: number): DoaParams {
  const p = { ...base };
  switch (key) {
    case "edge_mm":
      p.edgeMm = value;
      break;
    case "c_mm_s":
      p.cMmS = value;
      break;
    case "drone_rms":
      p.droneRms = value;
      break;
    case "wind_ratio":
      p.windRatio = value;
      break;
    case "wind_rms_min":
      p.windRmsMin = value;
      break;
    case "drone_crest_max":
      p.droneCrestMax = value;
      break;
    case "drone_conf_min":
      p.droneConfMin = value;
      break;
    case "veh_rms":
      p.vehRms = value;
      break;
    case "bird_rms":
      p.birdRms = value;
      break;
    case "walk_rms":
      p.walkRms = value;
      break;
    case "pair_mask":
      p.pairMask = value >>> 0;
      break;
    default:
      throw new Error(`Unknown DOA sweep key "${key}"`);
  }
  return p;
}

function handleDoa(req: Extract<WorkerRequest, { kind: "doa" }>) {
  const a = requireAudio();
  const result = requireCore().doaRun(a.planar, a.frames, req.params);
  return { result, transfer: [] as Transferable[] };
}

function handleDoaSweep(req: Extract<WorkerRequest, { kind: "doaSweep" }>) {
  const a = requireAudio();
  const c = requireCore();
  const points = req.values.map((value) => {
    const params = applySweepKey(req.params, req.sweepKey, value);
    return { value, result: c.doaRun(a.planar, a.frames, params) };
  });
  return {
    result: { sweepKey: req.sweepKey, points },
    transfer: [] as Transferable[],
  };
}

// ---- dispatch -------------------------------------------------------------

async function dispatch(
  req: WorkerRequest,
): Promise<{ result: unknown; transfer: Transferable[] }> {
  switch (req.kind) {
    case "init":
      return handleInit();
    case "setEnvironment":
      return handleEnvironment(req);
    case "loadAudio":
      return handleLoadAudio(req);
    case "stft":
      return handleStft(req);
    case "phase":
      return handlePhase(req);
    case "bands":
      return handleBands(req);
    case "pairs":
      return handlePairs(req);
    case "surface":
      return handleSurface(req);
    case "coherence":
      return handleCoherence(req);
    case "health":
      return handleHealth(req);
    case "mapping":
      return handleMapping(req);
    case "f0":
      return handleF0(req);
    case "f0Frame":
      return handleF0Frame(req);
    case "cepstrum":
      return handleCepstrum(req);
    case "spectrumFrame":
      return handleSpectrumFrame(req);
    case "signatureExtract":
      return handleSignatureExtract(req);
    case "signatureMatch":
      return handleSignatureMatch(req);
    case "synth":
      return handleSynth(req);
    case "doa":
      return handleDoa(req);
    case "doaSweep":
      return handleDoaSweep(req);
    case "arena":
      return { result: requireCore().arenaUsage(), transfer: [] };
    default: {
      const exhaustive: never = req;
      throw new Error(`Unknown request ${JSON.stringify(exhaustive)}`);
    }
  }
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  const started = performance.now();
  try {
    const { result, transfer } = await dispatch(req);
    const response: WorkerResponse = {
      id: req.id,
      ok: true,
      kind: req.kind,
      result: result as never,
      elapsedMs: performance.now() - started,
    };
    (self as unknown as Worker).postMessage(response, transfer);
  } catch (err) {
    const response: WorkerResponse = {
      id: req.id,
      ok: false,
      kind: req.kind,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: performance.now() - started,
    };
    (self as unknown as Worker).postMessage(response);
  }
};
