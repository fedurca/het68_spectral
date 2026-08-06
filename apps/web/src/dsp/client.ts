/*
 * Typed client for the DSP worker.
 *
 * Requests are promises keyed by an id, and every one records how long it took. The
 * timing is not decoration: whether a 16k FFT over a five-minute recording is
 * workable is a question this tool has to answer about itself.
 */

import type {
  WorkerRequest,
  WorkerResponse,
  WorkerResultMap,
} from "./protocol.js";

export interface TimingRecord {
  kind: string;
  elapsedMs: number;
  at: number;
  ok: boolean;
  detail?: string;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  kind: string;
  started: number;
};

export class DspClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private timings: TimingRecord[] = [];
  private listeners = new Set<(t: TimingRecord[]) => void>();
  private queueDepth = 0;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "het68-dsp",
    });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      // A worker-level error leaves every outstanding request unanswered, so fail
      // them all rather than hanging the UI on a promise that will never settle.
      const error = new Error(`DSP worker failed: ${ev.message}`);
      for (const [, p] of this.pending) p.reject(error);
      this.pending.clear();
      this.queueDepth = 0;
    };
  }

  private onMessage(msg: WorkerResponse) {
    if (msg.kind === "log") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    this.queueDepth = Math.max(0, this.queueDepth - 1);

    this.record({
      kind: p.kind,
      elapsedMs: msg.elapsedMs,
      at: Date.now(),
      ok: msg.ok,
      detail: msg.ok ? undefined : msg.error,
    });

    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  private record(t: TimingRecord) {
    this.timings.push(t);
    // A long session would otherwise grow this without limit; the last few hundred
    // calls are enough to see a trend.
    if (this.timings.length > 500) this.timings.splice(0, this.timings.length - 500);
    for (const l of this.listeners) l(this.timings);
  }

  onTimings(cb: (t: TimingRecord[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get pendingCount(): number {
    return this.queueDepth;
  }

  getTimings(): readonly TimingRecord[] {
    return this.timings;
  }

  private send<K extends keyof WorkerResultMap>(
    req: Omit<Extract<WorkerRequest, { kind: K }>, "id">,
    transfer: Transferable[] = [],
  ): Promise<WorkerResultMap[K]> {
    const id = this.nextId++;
    const full = { ...req, id } as WorkerRequest;
    this.queueDepth++;
    return new Promise<WorkerResultMap[K]>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        kind: req.kind,
        started: performance.now(),
      });
      this.worker.postMessage(full, transfer);
    });
  }

  init() {
    return this.send<"init">({ kind: "init" });
  }

  setEnvironment(args: {
    edgeMm: number;
    tempC: number;
    humidityPct: number;
    pressurePa: number;
    sampleRate: number;
  }) {
    return this.send<"setEnvironment">({ kind: "setEnvironment", ...args });
  }

  /**
   * Hands the audio over to the worker. The buffer is transferred, not copied, so
   * the caller must not touch it afterwards; keep a separate copy on the UI side if
   * the waveform is needed there.
   */
  loadAudio(args: {
    planar: Float32Array;
    channels: number;
    frames: number;
    sampleRate: number;
  }) {
    return this.send<"loadAudio">({ kind: "loadAudio", ...args }, [args.planar.buffer]);
  }

  stft(params: import("./protocol.js").StftRequestParams) {
    return this.send<"stft">({ kind: "stft", params });
  }

  phase(channel: number) {
    return this.send<"phase">({ kind: "phase", channel });
  }

  bands(bands: import("./protocol.js").BandSpec[], noiseFloorPercentile = 0.1) {
    return this.send<"bands">({ kind: "bands", bands, noiseFloorPercentile });
  }

  pairs(params: import("./protocol.js").PairParams) {
    return this.send<"pairs">({ kind: "pairs", params });
  }

  surface(pair: number, params: import("./protocol.js").PairParams) {
    return this.send<"surface">({ kind: "surface", pair, params });
  }

  coherence(
    pair: number,
    nfft: number,
    hop: number,
    bands: import("./protocol.js").BandSpec[],
  ) {
    return this.send<"coherence">({ kind: "coherence", pair, nfft, hop, bands });
  }

  health(clipThreshold = 0.999) {
    return this.send<"health">({ kind: "health", clipThreshold });
  }

  mapping(toneHz = 1000, slotMs = 100) {
    return this.send<"mapping">({ kind: "mapping", toneHz, slotMs });
  }

  f0(args: {
    channel: number;
    fLoHz: number;
    fHiHz: number;
    nHarmonics: number;
    blades: number;
    maxRelJump?: number;
    maxMiss?: number;
  }) {
    return this.send<"f0">({
      kind: "f0",
      maxRelJump: 0.06,
      maxMiss: 5,
      ...args,
    });
  }

  f0Frame(args: {
    channel: number;
    frame: number;
    fLoHz: number;
    fHiHz: number;
    nHarmonics: number;
    blades: number;
  }) {
    return this.send<"f0Frame">({ kind: "f0Frame", ...args });
  }

  cepstrum(channel: number, frame: number) {
    return this.send<"cepstrum">({ kind: "cepstrum", channel, frame });
  }

  spectrumFrame(channel: number, frame: number) {
    return this.send<"spectrumFrame">({ kind: "spectrumFrame", channel, frame });
  }

  signatureExtract(args: {
    channel: number;
    startSec: number;
    endSec: number;
    fLoHz: number;
    fHiHz: number;
    nHarmonics: number;
    blades: number;
    bandEdgesHz: number[];
  }) {
    return this.send<"signatureExtract">({ kind: "signatureExtract", ...args });
  }

  signatureMatch(args: {
    channel: number;
    signature: import("@het68/dsp-core").Signature;
    bandEdgesHz: number[];
  }) {
    return this.send<"signatureMatch">({ kind: "signatureMatch", ...args });
  }

  synth(params: import("@het68/dsp-core").SynthParams) {
    return this.send<"synth">({ kind: "synth", params });
  }

  arena() {
    return this.send<"arena">({ kind: "arena" });
  }

  terminate() {
    this.worker.terminate();
    this.pending.clear();
  }
}
