/*
 * Live capture from the cube and the firmware's serial line.
 *
 * Two things about this are worth stating plainly rather than discovering later.
 *
 * First, browser capture of six channels is best effort. Chrome will return two
 * channels having silently downmixed, and it applies echo cancellation, noise
 * suppression and automatic gain unless each is explicitly disabled — all three of
 * which alter the inter-channel phase that the entire array depends on. So the panel
 * reports what was actually delivered against what was asked for, and says so loudly
 * when they differ. The reliable path on macOS is the Electron build, where ffmpeg
 * with the avfoundation input hands over all six channels untouched.
 *
 * Second, a rolling buffer is not a recording. Live mode holds the last stretch of
 * audio so it can be analysed; anything worth keeping has to be captured to a file.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  NumberField,
  Panel,
  Readout,
  SelectField,
  Toggle,
} from "@het68/ui";
import { encodeWav, SerialLineReader } from "@het68/io";
import {
  getPlatform,
  type AudioDeviceInfo,
  type CaptureSession,
  type CaptureStats,
  type PlatformAdapter,
  type SerialPortInfo,
  type SerialSession,
} from "../platform/index.js";
import type { Analyzer } from "../state/analyzer.js";

const BUFFER_CHOICES = [5, 10, 20, 30, 60, 120] as const;

export function LiveTab({ analyzer }: { analyzer: Analyzer }) {
  const { appendLog, loadPlanar, setSerial, setTimeSyncEpoch, log } = analyzer;

  const [platform, setPlatform] = useState<PlatformAdapter | null>(null);
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [portId, setPortId] = useState("");
  const [baudRate, setBaudRate] = useState(115200);
  const [sampleRate, setSampleRate] = useState(48000);
  const [channels, setChannels] = useState(6);
  const [bufferSec, setBufferSec] = useState<number>(20);
  const [autoAnalyse, setAutoAnalyse] = useState(false);

  const [session, setSession] = useState<CaptureSession | null>(null);
  const [serialSession, setSerialSession] = useState<SerialSession | null>(null);
  const [stats, setStats] = useState<CaptureStats | null>(null);
  const [levels, setLevels] = useState<Float32Array | null>(null);
  const [serialLines, setSerialLines] = useState<string[]>([]);

  // Channel-major ring. Channel-major rather than interleaved because every consumer
  // downstream wants one channel contiguously, and converting per block would copy
  // the whole buffer on every callback.
  const ring = useRef<{
    data: Float32Array;
    capacity: number;
    channels: number;
    write: number;
    filled: number;
  } | null>(null);
  const serialReader = useRef(new SerialLineReader());

  useEffect(() => {
    let stopPolling: (() => void) | null = null;
    void getPlatform().then(async (p) => {
      setPlatform(p);
      if (p.name === "electron") {
        // Capture statistics live in the main process, so they are pulled in the
        // background and read synchronously when the panel draws.
        const mod = await import("../platform/electron.js");
        stopPolling = mod.startStatsPolling();
      }
      appendLog(`platform adapter: ${p.name}, shared memory ${p.hasSharedMemory ? "available" : "unavailable"}`);
      try {
        const d = await p.listAudioDevices();
        setDevices(d);
        if (d.length > 0) setDeviceId(d[0]!.id);
      } catch (err) {
        appendLog(`ERROR listing audio devices: ${(err as Error).message}`);
      }
    });
    return () => stopPolling?.();
  }, [appendLog]);

  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => setStats(session.stats()), 500);
    return () => clearInterval(id);
  }, [session]);

  const start = useCallback(async () => {
    if (!platform) return;
    const capacity = Math.round(bufferSec * sampleRate);
    ring.current = {
      data: new Float32Array(capacity * channels),
      capacity,
      channels,
      write: 0,
      filled: 0,
    };

    try {
      const s = await platform.startCapture({
        deviceId,
        channels,
        sampleRate,
        onLog: appendLog,
        onBlock: (block) => {
          const r = ring.current;
          if (!r) return;
          const n = Math.min(block.frames, r.capacity);
          for (let ch = 0; ch < Math.min(block.channels, r.channels); ch++) {
            const src = block.planar.subarray(ch * block.frames, ch * block.frames + n);
            const dstBase = ch * r.capacity;
            const first = Math.min(n, r.capacity - r.write);
            r.data.set(src.subarray(0, first), dstBase + r.write);
            if (n > first) r.data.set(src.subarray(first), dstBase);
          }
          r.write = (r.write + n) % r.capacity;
          r.filled = Math.min(r.capacity, r.filled + n);

          const rms = new Float32Array(block.channels);
          for (let ch = 0; ch < block.channels; ch++) {
            let acc = 0;
            const base = ch * block.frames;
            for (let i = 0; i < block.frames; i++) {
              const v = block.planar[base + i]!;
              acc += v * v;
            }
            rms[ch] = 20 * Math.log10(Math.sqrt(acc / Math.max(1, block.frames)) + 1e-12);
          }
          setLevels(rms);
        },
      });
      setSession(s);
      for (const w of s.format.warnings) appendLog(`capture warning: ${w}`);
      appendLog(
        `capture started on ${s.format.deviceLabel} via ${s.format.backend}: ${s.format.channels} of ${s.format.requestedChannels} channels at ${s.format.sampleRate} Hz`,
      );
      if (s.format.channels !== s.format.requestedChannels) {
        appendLog(
          `ERROR the device delivered ${s.format.channels} channels, not ${s.format.requestedChannels}. Spatial analysis is meaningless on a downmix; use the Electron build on macOS.`,
        );
      }
    } catch (err) {
      appendLog(`ERROR starting capture: ${(err as Error).message}`);
    }
  }, [platform, deviceId, channels, sampleRate, bufferSec, appendLog]);

  const stop = useCallback(async () => {
    await session?.stop();
    setSession(null);
    setLevels(null);
  }, [session]);

  /** Copies the ring in chronological order and hands it to the analyzer. */
  const snapshot = useCallback(async () => {
    const r = ring.current;
    if (!r || r.filled === 0) return;
    const frames = r.filled;
    const out = new Float32Array(frames * r.channels);
    const start = (r.write - frames + r.capacity) % r.capacity;
    for (let ch = 0; ch < r.channels; ch++) {
      const base = ch * r.capacity;
      const dst = ch * frames;
      const first = Math.min(frames, r.capacity - start);
      out.set(r.data.subarray(base + start, base + start + first), dst);
      if (frames > first) {
        out.set(r.data.subarray(base, base + (frames - first)), dst + first);
      }
    }
    await loadPlanar({
      name: `live snapshot ${new Date().toISOString().slice(11, 19)}`,
      kind: "live",
      planar: out,
      channels: r.channels,
      frames,
      sampleRate,
      wav: null,
      warnings:
        session && session.format.channels !== session.format.requestedChannels
          ? [
              `Captured ${session.format.channels} channels instead of ${session.format.requestedChannels}.`,
            ]
          : [],
    });
  }, [loadPlanar, sampleRate, session]);

  const saveWav = useCallback(async () => {
    const r = ring.current;
    if (!r || r.filled === 0 || !platform) return;
    const frames = r.filled;
    const out = new Float32Array(frames * r.channels);
    const start = (r.write - frames + r.capacity) % r.capacity;
    for (let ch = 0; ch < r.channels; ch++) {
      const base = ch * r.capacity;
      const first = Math.min(frames, r.capacity - start);
      out.set(r.data.subarray(base + start, base + start + first), ch * frames);
      if (frames > first) {
        out.set(r.data.subarray(base, base + (frames - first)), ch * frames + first);
      }
    }
    // 24-bit, matching what the firmware streams, so a saved buffer and a file from
    // the device are the same thing.
    const wav = encodeWav(out, r.channels, frames, sampleRate, 24);
    await platform.saveFile(
      `het68-live-${Date.now()}.wav`,
      new Uint8Array(wav),
      "audio/wav",
    );
    appendLog(`saved ${(frames / sampleRate).toFixed(1)} s of ${r.channels}-channel audio`);
  }, [platform, sampleRate, appendLog]);

  const startSerial = useCallback(async () => {
    if (!platform) return;
    try {
      const s = await platform.startSerial({
        portId,
        baudRate,
        onLog: appendLog,
        onLine: (line) => {
          // The adapters already split on newlines, but the reader is what carries the
          // TIME SYNC epoch forward across lines, so everything goes through it.
          for (const ev of serialReader.current.push(`${line}\n`)) {
            setSerialLines((prev) => [...prev.slice(-199), ev.raw]);
            setSerial((prev) => [...prev, ev]);
            if (ev.kind === "TIME" && ev.epochSec !== null) {
              setTimeSyncEpoch(ev.epochSec);
              appendLog(`TIME SYNC at ${ev.epochSec}; ground truth can now be aligned`);
            }
          }
        },
      });
      setSerialSession(s);
      appendLog(`serial open at ${baudRate} baud`);
    } catch (err) {
      appendLog(`ERROR opening serial: ${(err as Error).message}`);
    }
  }, [platform, portId, baudRate, appendLog, setSerial, setTimeSyncEpoch]);

  const refreshPorts = useCallback(async () => {
    if (!platform) return;
    try {
      const p = await platform.listSerialPorts();
      setPorts(p);
      if (p.length > 0 && portId === "") setPortId(p[0]!.id);
      if (p.length === 0) {
        appendLog(
          "No serial ports available. In the browser a port has to be granted by the user first; the Electron build enumerates them directly.",
        );
      }
    } catch (err) {
      appendLog(`ERROR listing serial ports: ${(err as Error).message}`);
    }
  }, [platform, portId, appendLog]);

  // Auto-analysis is off by default: a full six-channel STFT every few seconds keeps
  // the worker permanently busy and makes interaction unpleasant.
  useEffect(() => {
    if (!autoAnalyse || !session) return;
    const id = setInterval(() => void snapshot(), 5000);
    return () => clearInterval(id);
  }, [autoAnalyse, session, snapshot]);

  return (
    <>
      <Panel
        title="Capture"
        actions={
          session ? (
            <>
              <Badge tone="ok">running</Badge>
              <Button onClick={() => void stop()}>Stop</Button>
            </>
          ) : (
            <Button primary disabled={!platform} onClick={() => void start()}>
              Start
            </Button>
          )
        }
        note={
          platform?.name === "web"
            ? "Browser capture is best effort. Six channels are requested with echo cancellation, noise suppression and gain control all disabled, but the browser may still hand back a downmix — which is reported below rather than assumed away."
            : "Electron build: ffmpeg with the avfoundation input, which delivers all six channels untouched."
        }
      >
        <SelectField
          label="Device"
          value={deviceId}
          options={devices.map((d) => ({
            value: d.id,
            label: d.channels ? `${d.label} (${d.channels} ch)` : d.label,
          }))}
          onChange={setDeviceId}
          disabled={!!session}
        />
        <NumberField
          label="Channels"
          value={channels}
          min={1}
          max={8}
          onChange={setChannels}
          disabled={!!session}
        />
        <NumberField
          label="Sample rate"
          value={sampleRate}
          min={8000}
          max={192000}
          step={1000}
          onChange={setSampleRate}
          disabled={!!session}
        />
        <SelectField
          label="Rolling buffer"
          value={bufferSec}
          options={BUFFER_CHOICES.map((s) => ({ value: s, label: `${s} s` }))}
          onChange={setBufferSec}
          disabled={!!session}
          hint={`${((bufferSec * sampleRate * channels * 4) / 1e6).toFixed(0)} MB of memory`}
        />

        {session ? (
          <>
            <Readout
              rows={[
                ["backend", session.format.backend],
                ["device", session.format.deviceLabel],
                [
                  "channels",
                  session.format.channels === session.format.requestedChannels
                    ? `${session.format.channels}`
                    : `${session.format.channels} of ${session.format.requestedChannels} — spatial analysis is invalid`,
                ],
                ["sample rate", `${session.format.sampleRate} Hz`],
                ["frames delivered", stats?.framesDelivered ?? 0],
                ["underruns", stats?.underruns ?? 0],
                ["overruns", stats?.overruns ?? 0],
                ["glitches", stats?.glitches ?? 0],
                ["latency", `${(stats?.latencyMs ?? 0).toFixed(1)} ms`],
              ]}
            />
            {session.format.channels !== session.format.requestedChannels ? (
              <div className="finding" data-severity="error">
                <span>
                  The device delivered {session.format.channels} channels. Every
                  inter-microphone measurement in this application is meaningless on a
                  downmix. On macOS use the Electron build.
                </span>
              </div>
            ) : null}
          </>
        ) : null}

        {levels ? (
          <table className="data">
            <thead>
              <tr>
                <th>channel</th>
                <th>block RMS dBFS</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(levels).map((v, i) => (
                <tr key={i}>
                  <td>mic {i + 1}</td>
                  <td>{Number.isFinite(v) ? v.toFixed(1) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        <div className="btn-row">
          <Button disabled={!session} onClick={() => void snapshot()}>
            Analyse buffer
          </Button>
          <Button disabled={!session} onClick={() => void saveWav()}>
            Save buffer as WAV
          </Button>
          <Toggle
            label="Analyse every 5 s"
            checked={autoAnalyse}
            onChange={setAutoAnalyse}
          />
        </div>
        <p className="panel-note">
          The rolling buffer is not a recording. It holds the last {bufferSec} s so it can
          be analysed; save it if it matters.
        </p>
      </Panel>

      <Panel
        title="Serial, one event per line"
        actions={
          serialSession ? (
            <Button
              onClick={() => {
                void serialSession.stop();
                setSerialSession(null);
              }}
            >
              Close
            </Button>
          ) : (
            <>
              <Button onClick={() => void refreshPorts()}>List ports</Button>
              <Button primary disabled={!platform} onClick={() => void startSerial()}>
                Open
              </Button>
            </>
          )
        }
        note="TIME SYNC lines set the recording's epoch, which is what puts Remote ID truth on the same timeline as the audio. Without it the two cannot be compared at all."
      >
        <SelectField
          label="Port"
          value={portId}
          options={ports.map((p) => ({ value: p.id, label: p.label }))}
          onChange={setPortId}
          disabled={!!serialSession}
        />
        <NumberField
          label="Baud"
          value={baudRate}
          min={9600}
          max={2000000}
          step={9600}
          onChange={setBaudRate}
          disabled={!!serialSession}
        />
        {serialLines.length > 0 ? (
          <pre className="log">{serialLines.slice(-60).join("\n")}</pre>
        ) : (
          <p className="panel-note">Nothing received yet.</p>
        )}
      </Panel>

      <Panel title="Session log">
        <pre className="log">{log.slice(-120).join("\n")}</pre>
      </Panel>
    </>
  );
}
