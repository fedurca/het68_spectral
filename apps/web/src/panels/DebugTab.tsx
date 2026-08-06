/*
 * Maximum debug.
 *
 * The premise of the whole application is that the detector will be tuned by looking at
 * intermediate results, not by looking at a verdict. So everything the worker computed
 * is inspectable here, per frame and per bin, along with how long each call took and
 * how much memory it cost. A number that cannot be re-derived outside this tool is not
 * evidence, which is why every panel has an export.
 *
 * The performance table matters more than it looks. Whether a 16k transform over a
 * five-minute six-channel recording is workable, and whether the same C code will fit
 * the microcontroller's budget on the second core, are questions this tool has to
 * answer about itself before it can be trusted to answer them about the firmware.
 */

import { useMemo, useState } from "react";
import { LinePlot } from "@het68/ui";
import {
  Badge,
  Button,
  DataTable,
  NumberField,
  Panel,
  Readout,
  SelectField,
} from "@het68/ui";
import {
  describeWav,
  downloadCsv,
  downloadJson,
  envelope,
  matrixToCsv,
  seriesToCsv,
} from "@het68/io";
import type { BuildInfo } from "../buildinfo.js";
import type { Analyzer } from "../state/analyzer.js";
import type { TimingRecord } from "../dsp/client.js";

export function DebugTab({
  analyzer,
  build,
  gpuBytes,
}: {
  analyzer: Analyzer;
  build: BuildInfo | null;
  gpuBytes: number;
}) {
  const {
    audio,
    stft,
    stftSettings,
    environment,
    init,
    timings,
    log,
    bandsResult,
    bands,
    pairs,
    surface,
    coherence,
    health,
    mapping,
    f0,
    library,
    annotations,
    serial,
    timeSyncEpoch,
    hopSec,
    spectrogramChannels,
    edgeMm,
    tempC,
    humidityPct,
    pressurePa,
  } = analyzer;

  const [inspectChannel, setInspectChannel] = useState(0);
  const [inspectFrame, setInspectFrame] = useState(0);
  const [binFrom, setBinFrom] = useState(0);
  const [binTo, setBinTo] = useState(64);

  const byKind = useMemo(() => {
    const map = new Map<string, { n: number; total: number; worst: number; failures: number }>();
    for (const t of timings) {
      const e = map.get(t.kind) ?? { n: 0, total: 0, worst: 0, failures: 0 };
      e.n++;
      e.total += t.elapsedMs;
      e.worst = Math.max(e.worst, t.elapsedMs);
      if (!t.ok) e.failures++;
      map.set(t.kind, e);
    }
    return [...map.entries()]
      .map(([kind, e]) => ({ kind, ...e, mean: e.total / e.n }))
      .sort((a, b) => b.total - a.total);
  }, [timings]);

  const channel = spectrogramChannels[inspectChannel] ?? null;
  const frame = channel
    ? Math.max(0, Math.min(channel.frames - 1, inspectFrame))
    : 0;

  const binRows = useMemo(() => {
    if (!channel || !stft) return [];
    const from = Math.max(0, Math.min(channel.bins - 1, binFrom));
    const to = Math.max(from + 1, Math.min(channel.bins, binTo));
    const rows: { bin: number; hz: number; values: number[] }[] = [];
    for (let b = from; b < to; b++) {
      rows.push({
        bin: b,
        hz: b * stft.metrics.binHz,
        values: spectrogramChannels.map((c) => c.db[frame * c.bins + b] ?? Number.NaN),
      });
    }
    return rows;
  }, [channel, stft, binFrom, binTo, frame, spectrogramChannels]);

  const exportEverything = () => {
    downloadJson(
      "session-debug.json",
      envelope(
        "het68-spectral-debug",
        {
          build,
          dsp: init,
          source: audio
            ? {
                name: audio.name,
                kind: audio.kind,
                channels: audio.channels,
                frames: audio.frames,
                sampleRate: audio.sampleRate,
                durationSec: audio.durationSec,
                warnings: audio.warnings,
                wavChunks: audio.wav ? describeWav(audio.wav) : null,
              }
            : null,
          geometry: { edgeMm, tempC, humidityPct, pressurePa, environment },
          stft: stft ? { settings: stftSettings, metrics: stft.metrics, frames: stft.frames, bins: stft.bins } : null,
          bands: bands.map((b) => ({ ...b })),
          bandNoiseFloors: bandsResult?.series.map((s) => ({
            bandId: s.bandId,
            channel: s.channel,
            noiseFloorDb: s.noiseFloorDb,
          })),
          pairs: pairs?.pairs.map((p) => ({
            pair: p.pair,
            i: p.i,
            j: p.j,
            baselineMm: p.baselineMm,
            opposite: p.opposite,
            gratingHz: p.gratingHz,
            maxLagSamples: p.maxLagSamples,
          })),
          health,
          mapping,
          f0: f0
            ? {
                channel: f0.channel,
                medianF0Hz: f0.medianF0Hz,
                medianRpm: f0.medianRpm,
                lockedFraction: f0.lockedFraction,
              }
            : null,
          signatures: library,
          annotations,
          serial,
          timeSyncEpoch,
          timings,
          log,
        },
        build ? { version: build.version, commit: build.commit } : undefined,
      ),
    );
  };

  return (
    <>
      <Panel
        title="Build and core"
        actions={<Button primary onClick={exportEverything}>Export everything</Button>}
        note="Every export carries the version and commit that produced it, so a result found six months from now traces back to the code that made it."
      >
        <Readout
          rows={[
            ["version", build?.version ?? "unknown"],
            ["commit", build ? `${build.commit}${build.dirty ? " (dirty tree)" : ""}` : "unknown"],
            ["branch", build?.branch ?? "unknown"],
            ["built", build?.builtAt ?? "unknown"],
            ["DSP core version", init?.version ?? "not loaded"],
            ["max FFT", init?.maxFftSize ?? "—"],
            [
              "arena",
              init
                ? `${init.arena.usedBytes} of ${init.arena.capacityBytes} bytes, ${init.arena.plans} FFT plans cached`
                : "—",
            ],
            ["GPU textures", `${(gpuBytes / 1e6).toFixed(2)} MB`],
            [
              "SharedArrayBuffer",
              typeof SharedArrayBuffer === "undefined"
                ? "unavailable, COOP/COEP are not set"
                : "available",
            ],
            [
              "hardware threads",
              typeof navigator === "undefined" ? "—" : (navigator.hardwareConcurrency ?? "unknown"),
            ],
          ]}
        />
        <p className="panel-note">
          The same C sources build to WebAssembly here and to the firmware's second core,
          with floating-point contraction disabled in both so a result computed in the
          browser is the result the microcontroller would compute.
        </p>
      </Panel>

      <Panel
        title="Performance"
        actions={
          <Button
            disabled={timings.length === 0}
            onClick={() =>
              downloadCsv(
                "timings.csv",
                seriesToCsv(
                  ["at_ms", "elapsed_ms", "ok"],
                  timings.map((t: TimingRecord) => [t.at, t.elapsedMs, t.ok ? 1 : 0]),
                ),
              )
            }
          >
            Export CSV
          </Button>
        }
        note="Wall-clock time for every worker call. The question this answers is whether the analysis is fast enough to tune with, which is a different question from whether it is correct."
      >
        <table className="data">
          <thead>
            <tr>
              <th>operation</th>
              <th>calls</th>
              <th>mean ms</th>
              <th>worst ms</th>
              <th>total ms</th>
              <th>failures</th>
            </tr>
          </thead>
          <tbody>
            {byKind.map((e) => (
              <tr key={e.kind}>
                <td>{e.kind}</td>
                <td>{e.n}</td>
                <td>{e.mean.toFixed(1)}</td>
                <td>{e.worst.toFixed(1)}</td>
                <td>{e.total.toFixed(0)}</td>
                <td>
                  {e.failures > 0 ? <Badge tone="error">{e.failures}</Badge> : "0"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {timings.length > 0 ? (
          <LinePlot
            series={[
              {
                label: "elapsed",
                colour: "#22d3ee",
                data: timings.map((t) => t.elapsedMs),
                xFrom: 0,
                xStep: 1,
              },
            ]}
            height={140}
            xLabel="call"
            yLabel="ms"
            logY
            fmtX={(v) => v.toFixed(0)}
          />
        ) : null}
      </Panel>

      {audio ? (
        <Panel
          title="Source file"
          note="Non-canonical files are common: arecord writes packed 24-bit, and some tools leave odd chunk sizes behind. What was found is listed rather than corrected silently."
        >
          <Readout
            rows={[
              ["name", audio.name],
              ["kind", audio.kind],
              ["channels", audio.channels],
              ["frames", audio.frames],
              ["sample rate", `${audio.sampleRate} Hz`],
              ["duration", `${audio.durationSec.toFixed(3)} s`],
              [
                "memory",
                `${((audio.planar.length * 4) / 1e6).toFixed(1)} MB on this side, the same again in the worker`,
              ],
              [
                "format",
                audio.wav
                  ? `${audio.wav.format.formatName}, ${audio.wav.format.bitsPerSample}-bit ${audio.wav.format.encoding}`
                  : "generated in memory",
              ],
            ]}
          />
          {audio.wav ? <pre className="log">{describeWav(audio.wav).join("\n")}</pre> : null}
          {audio.warnings.length > 0 ? (
            audio.warnings.map((w, i) => (
              <div key={i} className="finding" data-severity="warn">
                <span>{w}</span>
              </div>
            ))
          ) : null}
        </Panel>
      ) : null}

      {stft && channel ? (
        <Panel
          title="Per-frame, per-bin inspector"
          actions={
            <Button
              onClick={() =>
                downloadCsv(
                  `spectrogram-ch${inspectChannel + 1}.csv`,
                  matrixToCsv(channel.db, channel.frames, channel.bins, {
                    binHz: stft.metrics.binHz,
                    hopSec,
                    binFrom,
                    binTo,
                  }),
                )
              }
            >
              Export bins {binFrom}–{binTo} as CSV
            </Button>
          }
          note="The exact numbers behind the picture. Bin indices are shown with their frequencies, because a bin number means nothing without the transform that produced it."
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
              gap: "0.5rem",
            }}
          >
            <SelectField
              label="Channel"
              value={inspectChannel}
              options={spectrogramChannels.map((c, i) => ({ value: i, label: c.label }))}
              onChange={setInspectChannel}
            />
            <NumberField
              label="Frame"
              value={frame}
              min={0}
              max={channel.frames - 1}
              onChange={setInspectFrame}
              hint={`${(frame * hopSec).toFixed(4)} s`}
            />
            <NumberField
              label="Bin from"
              value={binFrom}
              min={0}
              max={channel.bins - 1}
              onChange={setBinFrom}
              hint={`${(binFrom * stft.metrics.binHz).toFixed(1)} Hz`}
            />
            <NumberField
              label="Bin to"
              value={binTo}
              min={1}
              max={channel.bins}
              onChange={setBinTo}
              hint={`${(binTo * stft.metrics.binHz).toFixed(1)} Hz`}
            />
          </div>

          <DataTable
            columns={[
              { key: "bin", label: "bin", render: (r: (typeof binRows)[number]) => r.bin },
              { key: "hz", label: "Hz", render: (r) => r.hz.toFixed(2) },
              ...spectrogramChannels.map((c, i) => ({
                key: `ch${i}`,
                label: c.label,
                render: (r: (typeof binRows)[number]) =>
                  Number.isFinite(r.values[i]!) ? r.values[i]!.toFixed(2) : "—",
              })),
              {
                key: "spread",
                label: "spread dB",
                render: (r) => {
                  const finite = r.values.filter((v) => Number.isFinite(v));
                  if (finite.length === 0) return "—";
                  return (Math.max(...finite) - Math.min(...finite)).toFixed(2);
                },
              },
            ]}
            rows={binRows}
            keyOf={(r) => String(r.bin)}
            maxHeight="24rem"
          />
        </Panel>
      ) : null}

      <Panel title="What has been computed">
        <Readout
          rows={[
            ["STFT", stft ? `${stft.frames} × ${stft.bins} × ${stft.channels}` : "no"],
            ["band metrics", bandsResult ? `${bandsResult.series.length} series` : "no"],
            ["pairs", pairs ? `${pairs.pairs.length} pairs × ${pairs.columns} columns` : "no"],
            ["lag surface", surface ? `pair ${surface.pair}` : "no"],
            ["coherence", coherence ? `pair ${coherence.pair}` : "no"],
            ["health", health ? `${health.findings.length} findings` : "no"],
            ["mapping", mapping ? `${mapping.problems.length} problems` : "no"],
            ["f0 track", f0 ? `${f0.track.length} frames` : "no"],
            ["signatures", library.length],
            ["annotations", annotations.length],
            ["serial events", serial.length],
            [
              "time sync",
              timeSyncEpoch === null
                ? "not set, so ground truth cannot be aligned"
                : new Date(timeSyncEpoch * 1000).toISOString(),
            ],
          ]}
        />
      </Panel>

      {annotations.length > 0 || serial.length > 0 ? (
        <Panel
          title="Annotations and firmware lines"
          actions={
            <Button
              onClick={() =>
                downloadJson("annotations.json", envelope("het68-annotations", { annotations, serial }))
              }
            >
              Export
            </Button>
          }
        >
          <DataTable
            columns={[
              { key: "t", label: "start", render: (a) => `${a.startSec.toFixed(3)} s` },
              { key: "e", label: "end", render: (a) => `${a.endSec.toFixed(3)} s` },
              { key: "label", label: "label", render: (a) => a.label },
              {
                key: "meta",
                label: "fields",
                render: (a) =>
                  Object.entries(a.meta ?? {})
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(" ") || "—",
              },
            ]}
            rows={annotations}
            keyOf={(a) => a.id}
            maxHeight="14rem"
          />
          {serial.length > 0 ? (
            <pre className="log">{serial.slice(-80).map((s) => s.raw).join("\n")}</pre>
          ) : null}
        </Panel>
      ) : null}

      <Panel
        title="Log"
        actions={
          <Button onClick={() => downloadJson("log.json", { log })}>Export</Button>
        }
        note="Every load, every warning, every failure, in order."
      >
        <pre className="log">{log.join("\n")}</pre>
      </Panel>
    </>
  );
}
