/*
 * Application state.
 *
 * One hook owns everything, because almost every panel depends on the same few
 * things: which audio is loaded, what the STFT settings are, and what the worker has
 * computed from them. Splitting that across stores would mean keeping several copies
 * of "is this result still valid for the current settings" in sync, and getting that
 * wrong shows up as a plot that quietly describes the previous configuration.
 *
 * The rule the state follows: changing the audio invalidates everything, changing
 * the STFT invalidates everything derived from it, and changing pair settings
 * invalidates only pair results.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ANALYSIS_BAND,
  DEFAULT_EDGE_MM,
  DEFAULT_ENVIRONMENT,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_STFT,
  FIRMWARE_BANDS,
  NEO2,
  SIGNATURE_BAND_EDGES,
  WindowKind,
  type GeometryInfo,
  type Signature,
  type StftMetrics,
  type SynthParams,
} from "@het68/dsp-core";
import {
  channelView,
  decodeWav,
  parseAnnotations,
  type Annotation,
  type SerialEvent,
  type WavFile,
} from "@het68/io";
import type { ColormapName, FrequencyScale, SpectrogramViewState } from "@het68/ui";
import { DspClient, type TimingRecord } from "../dsp/client.js";
import type {
  BandSpec,
  BandsResult,
  CoherenceResult,
  EnvironmentResult,
  F0Result,
  HealthResult,
  InitResult,
  MappingResult,
  PairParams,
  PairsResult,
  StftResult,
  SurfaceResult,
} from "../dsp/protocol.js";

export interface LoadedAudio {
  name: string;
  kind: "file" | "synthetic" | "live";
  /** Kept on the UI side for readouts and export; the worker holds its own copy. */
  planar: Float32Array;
  channels: number;
  frames: number;
  sampleRate: number;
  durationSec: number;
  wav: WavFile | null;
  /** Non-canonical file warnings, surfaced rather than swallowed. */
  warnings: string[];
}

export interface BandDefinition extends BandSpec {
  label: string;
  colour: string;
  firmware: boolean;
  enabled: boolean;
}

export interface SignatureEntry {
  id: string;
  label: string;
  createdAt: string;
  signature: Signature;
  meta: {
    model: string;
    ridModuleFitted: boolean;
    ridModuleLocation?: string;
    distanceM?: number;
    azimuthDeg?: number;
    conditions?: string;
    sourceFile: string;
    startSec: number;
    endSec: number;
    channel: number;
  };
}

export interface StftSettings {
  fftSize: number;
  winLength: number;
  hop: number;
  windowKind: WindowKind;
  beta: number;
  floorDb: number;
}

export interface HarmonicSettings {
  channel: number;
  fLoHz: number;
  fHiHz: number;
  nHarmonics: number;
  blades: number;
  maxRelJump: number;
  maxMiss: number;
}

export type Status =
  | { state: "idle" }
  | { state: "busy"; what: string }
  | { state: "error"; what: string; message: string };

const DEFAULT_BANDS: BandDefinition[] = [
  ...FIRMWARE_BANDS.map((b) => ({
    id: b.id,
    label: b.label,
    loHz: b.loHz,
    hiHz: b.hiHz,
    colour: b.colour,
    firmware: true,
    enabled: b.id === "drone",
  })),
  {
    id: "neo2-analysis",
    label: "Neo 2 analysis (600 Hz – 8 kHz)",
    loHz: ANALYSIS_BAND.loHz,
    hiHz: ANALYSIS_BAND.hiHz,
    colour: "#22d3ee",
    firmware: false,
    enabled: true,
  },
];

export function useAnalyzer() {
  const clientRef = useRef<DspClient | null>(null);
  const [init, setInit] = useState<InitResult | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [timings, setTimings] = useState<readonly TimingRecord[]>([]);

  // ---- environment and geometry -----------------------------------------
  const [edgeMm, setEdgeMm] = useState(DEFAULT_EDGE_MM);
  const [tempC, setTempC] = useState(DEFAULT_ENVIRONMENT.tempC);
  const [humidityPct, setHumidityPct] = useState(DEFAULT_ENVIRONMENT.humidityPct);
  const [pressurePa, setPressurePa] = useState(DEFAULT_ENVIRONMENT.pressurePa);
  const [environment, setEnvironment] = useState<EnvironmentResult | null>(null);

  // ---- audio -------------------------------------------------------------
  const [audio, setAudio] = useState<LoadedAudio | null>(null);

  // ---- STFT --------------------------------------------------------------
  const [stftSettings, setStftSettings] = useState<StftSettings>({
    fftSize: DEFAULT_STFT.fftSize,
    winLength: DEFAULT_STFT.fftSize,
    hop: DEFAULT_STFT.hop,
    windowKind: DEFAULT_STFT.windowKind,
    beta: DEFAULT_STFT.beta,
    floorDb: -120,
  });
  const [stft, setStft] = useState<StftResult | null>(null);

  // ---- view --------------------------------------------------------------
  const [view, setView] = useState<SpectrogramViewState>({
    frameFrom: 0,
    frameTo: 1,
    fLoHz: 0,
    fHiHz: DEFAULT_SAMPLE_RATE / 2,
    dbMin: -100,
    dbMax: -10,
    scale: "linear",
    colormap: "viridis",
  });
  const [selection, setSelection] = useState<{ startSec: number; endSec: number } | null>(
    null,
  );

  // ---- derived results ---------------------------------------------------
  const [bands, setBands] = useState<BandDefinition[]>(DEFAULT_BANDS);
  const [bandsResult, setBandsResult] = useState<BandsResult | null>(null);
  const [pairParams, setPairParams] = useState<PairParams>({
    blockLen: 2048,
    hop: 1024,
    nfft: 8192,
    usePhat: true,
    maxLag: 64,
    fLoHz: 800,
    fHiHz: 6000,
  });
  const [pairs, setPairs] = useState<PairsResult | null>(null);
  const [surface, setSurface] = useState<SurfaceResult | null>(null);
  const [coherence, setCoherence] = useState<CoherenceResult | null>(null);
  const [selectedPair, setSelectedPair] = useState(0);
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [mapping, setMapping] = useState<MappingResult | null>(null);

  const [harmonic, setHarmonic] = useState<HarmonicSettings>({
    channel: 0,
    fLoHz: NEO2.f0SearchHz.lo,
    fHiHz: NEO2.f0SearchHz.hi,
    nHarmonics: NEO2.nHarmonics,
    blades: NEO2.blades,
    maxRelJump: 0.06,
    maxMiss: 5,
  });
  const [f0, setF0] = useState<F0Result | null>(null);
  const [library, setLibrary] = useState<SignatureEntry[]>([]);
  const [matchScore, setMatchScore] = useState<{
    signatureId: string;
    score: Float32Array;
    f0: Float32Array;
  } | null>(null);

  // ---- annotations -------------------------------------------------------
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [serial, setSerial] = useState<SerialEvent[]>([]);
  const [timeSyncEpoch, setTimeSyncEpoch] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const appendLog = useCallback((line: string) => {
    const stamp = new Date().toISOString().slice(11, 23);
    setLog((prev) => [...prev.slice(-499), `${stamp}  ${line}`]);
  }, []);

  // ---- worker lifecycle --------------------------------------------------

  useEffect(() => {
    const client = new DspClient();
    clientRef.current = client;
    const off = client.onTimings((t) => setTimings([...t]));
    client
      .init()
      .then((info) => {
        setInit(info);
        appendLog(
          `DSP core v${info.version} loaded, max FFT ${info.maxFftSize}, arena ${info.arena.capacityBytes} bytes`,
        );
      })
      .catch((err: Error) =>
        setStatus({ state: "error", what: "init", message: err.message }),
      );
    return () => {
      off();
      client.terminate();
      clientRef.current = null;
    };
  }, [appendLog]);

  const run = useCallback(
    async <T>(what: string, fn: (c: DspClient) => Promise<T>): Promise<T | null> => {
      const client = clientRef.current;
      if (!client) return null;
      setStatus({ state: "busy", what });
      try {
        const result = await fn(client);
        setStatus({ state: "idle" });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ state: "error", what, message });
        appendLog(`ERROR ${what}: ${message}`);
        return null;
      }
    },
    [appendLog],
  );

  // Geometry follows the environment; the sound speed feeds every lag in mm and the
  // grating frequency drawn over the spectrogram.
  useEffect(() => {
    if (!init) return;
    void run("geometry", async (c) => {
      const env = await c.setEnvironment({
        edgeMm,
        tempC,
        humidityPct,
        pressurePa,
        sampleRate: audio?.sampleRate ?? DEFAULT_SAMPLE_RATE,
      });
      setEnvironment(env);
      return env;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init, edgeMm, tempC, humidityPct, pressurePa, audio?.sampleRate]);

  // The firmware derives its own maximum lag from a cold-extreme sound speed; the
  // pair search window follows it so the analyzer looks at the same range.
  useEffect(() => {
    if (!environment) return;
    setPairParams((p) => ({ ...p, maxLag: environment.geometry.firmwareMaxLag }));
  }, [environment]);

  const invalidateDerived = useCallback(() => {
    setBandsResult(null);
    setPairs(null);
    setSurface(null);
    setCoherence(null);
    setF0(null);
    setMatchScore(null);
  }, []);

  // ---- loading -----------------------------------------------------------

  const loadPlanar = useCallback(
    async (a: Omit<LoadedAudio, "durationSec">) => {
      const loaded: LoadedAudio = {
        ...a,
        durationSec: a.frames / a.sampleRate,
      };
      setAudio(loaded);
      setStft(null);
      setHealth(null);
      setMapping(null);
      invalidateDerived();
      setSelection(null);

      // The worker takes ownership of the buffer it is sent, so it gets a copy and
      // the UI keeps the original for readouts and export.
      await run("load audio", (c) =>
        c.loadAudio({
          planar: a.planar.slice(),
          channels: a.channels,
          frames: a.frames,
          sampleRate: a.sampleRate,
        }),
      );
      appendLog(
        `loaded ${a.name}: ${a.channels} ch, ${a.frames} frames, ${a.sampleRate} Hz (${(a.frames / a.sampleRate).toFixed(2)} s)`,
      );
      return loaded;
    },
    [run, appendLog, invalidateDerived],
  );

  const loadWavFile = useCallback(
    async (file: File) => {
      setStatus({ state: "busy", what: `decoding ${file.name}` });
      try {
        const buffer = await file.arrayBuffer();
        const wav = decodeWav(buffer);
        for (const w of wav.warnings) appendLog(`WAV warning: ${w}`);
        await loadPlanar({
          name: file.name,
          kind: "file",
          planar: wav.planar,
          channels: wav.channels,
          frames: wav.frames,
          sampleRate: wav.format.sampleRate,
          wav,
          warnings: wav.warnings,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ state: "error", what: "decode wav", message });
        appendLog(`ERROR decoding ${file.name}: ${message}`);
      }
    },
    [loadPlanar, appendLog],
  );

  const loadAnnotationFile = useCallback(
    async (file: File) => {
      const text = await file.text();
      const parsed = parseAnnotations(text, {
        durationSec: audio?.durationSec,
        recordingStartEpoch: timeSyncEpoch ?? undefined,
      });
      setAnnotations(parsed.annotations);
      setSerial(parsed.serial);
      if (parsed.timeSyncEpoch !== null) setTimeSyncEpoch(parsed.timeSyncEpoch);
      appendLog(
        `annotations from ${file.name}: ${parsed.annotations.length} events, ${parsed.serial.length} firmware lines, ${parsed.unparsed.length} unreadable`,
      );
      for (const w of parsed.warnings) appendLog(`annotation warning: ${w}`);
    },
    [audio?.durationSec, timeSyncEpoch, appendLog],
  );

  const generateScene = useCallback(
    async (params: SynthParams, label: string) => {
      const result = await run("synthesise scene", (c) => c.synth(params));
      if (!result) return;
      await loadPlanar({
        name: label,
        kind: "synthetic",
        planar: result.planar,
        channels: result.channels,
        frames: result.frames,
        sampleRate: result.sampleRate,
        wav: null,
        warnings: [],
      });
    },
    [run, loadPlanar],
  );

  // ---- analysis ----------------------------------------------------------

  const runStft = useCallback(async () => {
    if (!audio) return;
    const result = await run("STFT", (c) =>
      c.stft({
        fftSize: stftSettings.fftSize,
        winLength: stftSettings.winLength,
        hop: stftSettings.hop,
        windowKind: stftSettings.windowKind,
        beta: stftSettings.beta,
        floorDb: stftSettings.floorDb,
      }),
    );
    if (!result) return;
    setStft(result);
    invalidateDerived();

    // Colour scale from the data: the strongest bin anywhere sets the top and 70 dB
    // below it the bottom, which puts a quiet recording on screen without hunting
    // for the right numbers first.
    const max = Math.max(...result.ranges.map((r) => r.max));
    setView((v) => ({
      ...v,
      frameFrom: 0,
      frameTo: result.frames,
      dbMax: Math.ceil(max / 5) * 5,
      dbMin: Math.ceil(max / 5) * 5 - 70,
      fHiHz: v.fHiHz > audio.sampleRate / 2 ? audio.sampleRate / 2 : v.fHiHz,
    }));
    appendLog(
      `STFT ${result.metrics.fftSize}/${result.metrics.hop} ${result.frames} frames x ${result.bins} bins, ${result.metrics.binHz.toFixed(2)} Hz, ${result.metrics.windowMs.toFixed(1)} ms`,
    );
  }, [audio, run, stftSettings, invalidateDerived, appendLog]);

  const runBands = useCallback(async () => {
    if (!stft) return;
    const active = bands.filter((b) => b.enabled);
    if (active.length === 0) return;
    const result = await run("band metrics", (c) =>
      c.bands(active.map((b) => ({ id: b.id, loHz: b.loHz, hiHz: b.hiHz }))),
    );
    if (result) setBandsResult(result);
  }, [stft, bands, run]);

  const runPairs = useCallback(async () => {
    if (!audio) return;
    const result = await run("15 pairs", (c) => c.pairs(pairParams));
    if (result) setPairs(result);
  }, [audio, run, pairParams]);

  const runSurface = useCallback(
    async (pair: number) => {
      if (!audio) return;
      setSelectedPair(pair);
      const result = await run(`lag surface, pair ${pair}`, (c) =>
        c.surface(pair, pairParams),
      );
      if (result) setSurface(result);
    },
    [audio, run, pairParams],
  );

  const runCoherence = useCallback(
    async (pair: number) => {
      if (!audio) return;
      const active = bands.filter((b) => b.enabled);
      const result = await run(`coherence, pair ${pair}`, (c) =>
        c.coherence(
          pair,
          pairParams.nfft,
          pairParams.nfft / 2,
          active.map((b) => ({ id: b.id, loHz: b.loHz, hiHz: b.hiHz })),
        ),
      );
      if (result) setCoherence(result);
    },
    [audio, run, bands, pairParams.nfft],
  );

  const runHealth = useCallback(async () => {
    if (!audio) return;
    const result = await run("health", (c) => c.health());
    if (result) {
      setHealth(result);
      for (const f of result.findings) appendLog(`${f.severity.toUpperCase()} ${f.message}`);
    }
  }, [audio, run, appendLog]);

  const runMapping = useCallback(async () => {
    if (!audio) return;
    const result = await run("channel mapping", (c) => c.mapping());
    if (result) {
      setMapping(result);
      for (const p of result.problems) appendLog(`MAPPING ${p}`);
    }
  }, [audio, run, appendLog]);

  const runF0 = useCallback(async () => {
    if (!stft) return;
    const result = await run("f0 track", (c) =>
      c.f0({
        channel: harmonic.channel,
        fLoHz: harmonic.fLoHz,
        fHiHz: harmonic.fHiHz,
        nHarmonics: harmonic.nHarmonics,
        blades: harmonic.blades,
        maxRelJump: harmonic.maxRelJump,
        maxMiss: harmonic.maxMiss,
      }),
    );
    if (result) {
      setF0(result);
      appendLog(
        `f0 median ${result.medianF0Hz.toFixed(1)} Hz (${result.medianRpm.toFixed(0)} rpm), locked in ${(result.lockedFraction * 100).toFixed(0)}% of frames`,
      );
    }
  }, [stft, run, harmonic, appendLog]);

  const extractSignature = useCallback(
    async (label: string, meta: Partial<SignatureEntry["meta"]>) => {
      if (!stft || !selection || !audio) return null;
      const result = await run("extract signature", (c) =>
        c.signatureExtract({
          channel: harmonic.channel,
          startSec: selection.startSec,
          endSec: selection.endSec,
          fLoHz: harmonic.fLoHz,
          fHiHz: harmonic.fHiHz,
          nHarmonics: harmonic.nHarmonics,
          blades: harmonic.blades,
          bandEdgesHz: [...SIGNATURE_BAND_EDGES],
        }),
      );
      if (!result) return null;
      const entry: SignatureEntry = {
        id: `sig-${Date.now().toString(36)}`,
        label,
        createdAt: new Date().toISOString(),
        signature: result.signature,
        meta: {
          model: NEO2.label,
          ridModuleFitted: false,
          sourceFile: audio.name,
          startSec: selection.startSec,
          endSec: selection.endSec,
          channel: harmonic.channel,
          ...meta,
        },
      };
      setLibrary((prev) => [...prev, entry]);
      appendLog(
        `signature "${label}" from ${result.frames} frames, ${result.signature.combRatios.length} combs, HNR ${result.signature.hnrDb.toFixed(1)} dB`,
      );
      return entry;
    },
    [stft, selection, audio, run, harmonic, appendLog],
  );

  const matchSignature = useCallback(
    async (entry: SignatureEntry) => {
      if (!stft) return;
      const result = await run(`match ${entry.label}`, (c) =>
        c.signatureMatch({
          channel: harmonic.channel,
          signature: entry.signature,
          bandEdgesHz: [...SIGNATURE_BAND_EDGES],
        }),
      );
      if (result) {
        setMatchScore({ signatureId: entry.id, score: result.score, f0: result.f0 });
      }
    },
    [stft, run, harmonic],
  );

  // ---- derived helpers ---------------------------------------------------

  const spectrogramChannels = useMemo(() => {
    if (!stft || !audio) return [];
    const stride = stft.frames * stft.bins;
    return Array.from({ length: stft.channels }, (_, ch) => ({
      label: `mic ${ch + 1}`,
      db: stft.db.subarray(ch * stride, (ch + 1) * stride),
      frames: stft.frames,
      bins: stft.bins,
    }));
  }, [stft, audio]);

  const hopSec = stft ? stft.metrics.hop / stft.metrics.sampleRate : 0;

  const channelSamples = useCallback(
    (ch: number): Float32Array | null => {
      if (!audio) return null;
      if (audio.wav) return channelView(audio.wav, ch);
      return audio.planar.subarray(ch * audio.frames, (ch + 1) * audio.frames);
    },
    [audio],
  );

  return {
    client: clientRef,
    init,
    status,
    timings,
    log,
    appendLog,

    edgeMm,
    setEdgeMm,
    tempC,
    setTempC,
    humidityPct,
    setHumidityPct,
    pressurePa,
    setPressurePa,
    environment,

    audio,
    loadWavFile,
    loadPlanar,
    loadAnnotationFile,
    generateScene,

    stftSettings,
    setStftSettings,
    stft,
    runStft,

    view,
    setView,
    selection,
    setSelection,

    bands,
    setBands,
    bandsResult,
    runBands,

    pairParams,
    setPairParams,
    pairs,
    runPairs,
    surface,
    runSurface,
    coherence,
    runCoherence,
    selectedPair,
    setSelectedPair,

    health,
    runHealth,
    mapping,
    runMapping,

    harmonic,
    setHarmonic,
    f0,
    runF0,
    library,
    setLibrary,
    extractSignature,
    matchSignature,
    matchScore,

    annotations,
    setAnnotations,
    serial,
    setSerial,
    timeSyncEpoch,
    setTimeSyncEpoch,

    spectrogramChannels,
    hopSec,
    channelSamples,
  };
}

export type Analyzer = ReturnType<typeof useAnalyzer>;

export const WINDOW_OPTIONS: ReadonlyArray<{ value: WindowKind; label: string }> = [
  { value: WindowKind.Rect, label: "Rectangular" },
  { value: WindowKind.Hann, label: "Hann" },
  { value: WindowKind.Hamming, label: "Hamming" },
  { value: WindowKind.BlackmanHarris, label: "Blackman-Harris" },
  { value: WindowKind.Kaiser, label: "Kaiser" },
];

export const FFT_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384] as const;

export const SCALE_OPTIONS: ReadonlyArray<{ value: FrequencyScale; label: string }> = [
  { value: "linear", label: "Linear" },
  { value: "log", label: "Log" },
  { value: "mel", label: "Mel" },
];

export const COLORMAP_OPTIONS: ReadonlyArray<{ value: ColormapName; label: string }> = [
  { value: "viridis", label: "Viridis" },
  { value: "magma", label: "Magma" },
  { value: "inferno", label: "Inferno" },
  { value: "turbo", label: "Turbo" },
  { value: "grey", label: "Grey" },
];
