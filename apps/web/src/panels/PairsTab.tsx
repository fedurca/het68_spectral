/*
 * Differences between microphones: the fifteen pairs of an octahedral six-element
 * array, their delays, and how trustworthy those delays are.
 *
 * The central fact this panel has to communicate is that at a 384 mm edge the array is
 * spatially aliased across the entire drone band. The grating frequency on the long
 * baseline is about 447 Hz, so any single component above it admits several delays that
 * fit the observation equally well. A GCC-PHAT peak here is therefore not an answer on
 * its own, and the ratio of the runner-up peak to the winner is the honest measure of
 * whether it can be believed. The lag-by-time surface makes the same point visually:
 * ambiguity looks like several parallel ridges, and a delay hopping between them is
 * aliasing rather than a moving target.
 *
 * Coherence is the other half. Two microphones looking at the same source share a
 * coherent component; two microphones in uncorrelated wind noise do not. Where
 * coherence is low, no amount of correlation processing will produce a delay worth
 * having, and it is better to know that than to average the nonsense.
 */

import { useMemo, useState } from "react";
import { channelColour, Heatmap, LinePlot } from "@het68/ui";
import {
  Badge,
  Button,
  DataTable,
  Empty,
  NumberField,
  Panel,
  Readout,
  SelectField,
  Toggle,
} from "@het68/ui";
import { downloadCsv, seriesToCsv } from "@het68/io";
import { PAIRS } from "@het68/dsp-core";
import type { Analyzer } from "../state/analyzer.js";
import type { PairSeries } from "../dsp/protocol.js";

const FFT_CHOICES = [1024, 2048, 4096, 8192, 16384] as const;

export function PairsTab({ analyzer }: { analyzer: Analyzer }) {
  const {
    audio,
    environment,
    pairParams,
    setPairParams,
    pairs,
    runPairs,
    surface,
    runSurface,
    coherence,
    runCoherence,
    selectedPair,
    bands,
    health,
    runHealth,
    stft,
  } = analyzer;

  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const [showMm, setShowMm] = useState(true);
  const [onlyOpposite, setOnlyOpposite] = useState(false);

  const lagQuantumMm = environment
    ? (environment.soundSpeed / (audio?.sampleRate ?? 48000)) * 1000
    : 0;

  const visible = useMemo(
    () => (pairs ? pairs.pairs.filter((p) => !onlyOpposite || p.opposite) : []),
    [pairs, onlyOpposite],
  );

  const selected = pairs?.pairs.find((p) => p.pair === selectedPair) ?? null;

  const exportPairs = () => {
    if (!pairs) return;
    const columns = ["time_s"];
    for (const p of pairs.pairs) {
      columns.push(
        `p${p.pair}_${p.i + 1}${p.j + 1}_lag_samples`,
        `p${p.pair}_${p.i + 1}${p.j + 1}_lag_mm`,
        `p${p.pair}_${p.i + 1}${p.j + 1}_peak`,
        `p${p.pair}_${p.i + 1}${p.j + 1}_runner_up_ratio`,
      );
    }
    const rows: number[][] = [];
    for (let k = 0; k < pairs.columns; k++) {
      const row: number[] = [pairs.pairs[0]?.times[k] ?? k];
      for (const p of pairs.pairs) {
        row.push(p.lagSamples[k]!, p.lagMm[k]!, p.peakValue[k]!, p.peakRatio[k]!);
      }
      rows.push(row);
    }
    downloadCsv("pairs.csv", seriesToCsv(columns, rows));
  };

  return (
    <>
      <Panel
        title="Correlation settings"
        actions={
          <Button primary disabled={!audio} onClick={() => void runPairs()}>
            Compute all 15 pairs
          </Button>
        }
        note="These are the numbers the firmware would use, not the spectrogram's. Delay estimation wants a different block length from spectral display, so it has its own."
      >
        <div
          className="panel-body"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
            padding: 0,
          }}
        >
          <NumberField
            label="Block length"
            value={pairParams.blockLen}
            min={256}
            max={16384}
            step={256}
            onChange={(v) => setPairParams((p) => ({ ...p, blockLen: v }))}
            hint={`${((pairParams.blockLen / (audio?.sampleRate ?? 48000)) * 1000).toFixed(1)} ms per estimate`}
          />
          <NumberField
            label="Hop"
            value={pairParams.hop}
            min={64}
            max={pairParams.blockLen}
            step={64}
            onChange={(v) => setPairParams((p) => ({ ...p, hop: v }))}
          />
          <SelectField
            label="Correlation FFT"
            value={pairParams.nfft}
            options={FFT_CHOICES.map((n) => ({ value: n, label: String(n) }))}
            onChange={(v) => setPairParams((p) => ({ ...p, nfft: v }))}
            hint="At least twice the block length, so the circular correlation does not wrap."
          />
          <NumberField
            label="Max lag"
            value={pairParams.maxLag}
            min={1}
            max={256}
            onChange={(v) => setPairParams((p) => ({ ...p, maxLag: v }))}
            hint={
              environment
                ? `Firmware uses ${environment.geometry.firmwareMaxLag}, derived from the long baseline at a cold-extreme sound speed.`
                : undefined
            }
          />
          <NumberField
            label="Band low (Hz)"
            value={pairParams.fLoHz}
            min={0}
            step={50}
            onChange={(v) => setPairParams((p) => ({ ...p, fLoHz: v }))}
          />
          <NumberField
            label="Band high (Hz)"
            value={pairParams.fHiHz}
            min={100}
            step={100}
            onChange={(v) => setPairParams((p) => ({ ...p, fHiHz: v }))}
          />
          <Toggle
            label="PHAT weighting"
            checked={pairParams.usePhat}
            onChange={(v) => setPairParams((p) => ({ ...p, usePhat: v }))}
          />
          <Toggle label="Lags in mm" checked={showMm} onChange={setShowMm} />
        </div>

        {environment ? (
          <Readout
            rows={[
              ["one sample of lag", `${lagQuantumMm.toFixed(2)} mm`],
              [
                "long baseline",
                `${environment.geometry.longBaselineMm.toFixed(1)} mm = ${(environment.geometry.longBaselineMm / lagQuantumMm).toFixed(1)} samples`,
              ],
              [
                "short baseline",
                `${environment.geometry.shortBaselineMm.toFixed(1)} mm = ${(environment.geometry.shortBaselineMm / lagQuantumMm).toFixed(1)} samples`,
              ],
              [
                "grating frequency",
                `${environment.geometry.gratingLongHz.toFixed(0)} Hz long, ${environment.geometry.gratingShortHz.toFixed(0)} Hz short`,
              ],
              [
                "aliasing in the search band",
                pairParams.fHiHz > environment.geometry.gratingShortHz
                  ? "yes, across the whole band"
                  : "no",
              ],
            ]}
          />
        ) : null}
      </Panel>

      {!pairs ? (
        <Empty>
          {audio
            ? "Press “Compute all 15 pairs”. Every pair is estimated in one pass so their delays are directly comparable."
            : "Load audio or generate a synthetic scene first. With a synthetic scene the true delays are known, which is the only way to tell whether this is working."}
        </Empty>
      ) : (
        <>
          <Panel
            title="Pairs"
            actions={
              <>
                <Toggle
                  label="Opposite pairs only"
                  checked={onlyOpposite}
                  onChange={setOnlyOpposite}
                />
                <Button onClick={exportPairs}>Export CSV</Button>
              </>
            }
            note="Click a pair to compute its lag-by-time surface and coherence. The three opposite pairs carry the long baseline and give the sharpest delay but the worst aliasing."
          >
            <DataTable
              columns={[
                { key: "pair", label: "pair", render: (p: PairSeries) => `${p.i + 1}-${p.j + 1}` },
                {
                  key: "kind",
                  label: "baseline",
                  render: (p) =>
                    `${p.baselineMm.toFixed(0)} mm ${p.opposite ? "(opposite)" : "(adjacent)"}`,
                },
                {
                  key: "grating",
                  label: "grating",
                  render: (p) => `${p.gratingHz.toFixed(0)} Hz`,
                },
                {
                  key: "median",
                  label: showMm ? "median lag mm" : "median lag samples",
                  render: (p) => {
                    const arr = Array.from(showMm ? p.lagMm : p.lagSamples).filter((v) =>
                      Number.isFinite(v),
                    );
                    if (arr.length === 0) return "—";
                    arr.sort((a, b) => a - b);
                    return arr[arr.length >> 1]!.toFixed(2);
                  },
                },
                {
                  key: "limit",
                  label: "physical limit",
                  render: (p) => `±${p.maxLagSamples.toFixed(1)} samples`,
                },
                {
                  key: "impossible",
                  label: "beyond limit",
                  render: (p) => {
                    // A delay larger than the baseline allows cannot be a direction; it
                    // is a mis-picked peak, and counting them is the cheapest sanity
                    // check available.
                    let n = 0;
                    for (let k = 0; k < p.lagSamples.length; k++) {
                      if (Math.abs(p.lagSamples[k]!) > p.maxLagSamples + 0.5) n++;
                    }
                    const pct = (100 * n) / Math.max(1, p.lagSamples.length);
                    return pct > 5 ? (
                      <Badge tone="warn">{pct.toFixed(0)} %</Badge>
                    ) : (
                      `${pct.toFixed(0)} %`
                    );
                  },
                },
                {
                  key: "ambiguous",
                  label: "ambiguous",
                  render: (p) => {
                    let n = 0;
                    for (let k = 0; k < p.ambiguous.length; k++) n += p.ambiguous[k]!;
                    const pct = (100 * n) / Math.max(1, p.ambiguous.length);
                    return pct > 30 ? (
                      <Badge
                        tone="warn"
                        title="The runner-up peak is within 20 % of the winner, which is what a grating lobe looks like."
                      >
                        {pct.toFixed(0)} %
                      </Badge>
                    ) : (
                      `${pct.toFixed(0)} %`
                    );
                  },
                },
              ]}
              rows={visible}
              keyOf={(p) => String(p.pair)}
              selectedKey={String(selectedPair)}
              onSelect={(p) => {
                void runSurface(p.pair);
                void runCoherence(p.pair);
              }}
              maxHeight="20rem"
            />
          </Panel>

          <Panel title="Delay over time, all visible pairs">
            <LinePlot
              series={visible.map((p) => ({
                label: `${p.i + 1}-${p.j + 1}`,
                colour: channelColour(p.pair % 6),
                data: showMm ? p.lagMm : p.lagSamples,
                xFrom: p.times[0] ?? 0,
                xStep:
                  p.times.length > 1 ? (p.times[1]! - p.times[0]!) : pairParams.hop / (audio?.sampleRate ?? 48000),
              }))}
              height={200}
              xLabel="s"
              yLabel={showMm ? "mm" : "samples"}
              cursorX={hoverSec}
              onHover={setHoverSec}
              markers={
                selected
                  ? [
                      {
                        y: showMm ? selected.maxLagSamples * lagQuantumMm : selected.maxLagSamples,
                        label: "physical limit of the selected pair",
                        colour: "#ef4444",
                      },
                      {
                        y: -(showMm ? selected.maxLagSamples * lagQuantumMm : selected.maxLagSamples),
                        colour: "#ef4444",
                      },
                    ]
                  : []
              }
            />
            <p className="panel-note">
              A delay that steps between discrete levels rather than moving smoothly is
              the array switching between grating lobes. That is not noise and it will
              not average out; above the grating frequency the ambiguity has to be
              resolved across several harmonics, which is what the firmware's own
              algorithm has to do.
            </p>
          </Panel>

          {surface ? (
            <Panel
              title={`Lag by time, pair ${PAIRS[surface.pair]![0] + 1}-${PAIRS[surface.pair]![1] + 1}`}
              actions={
                <Badge>
                  {surface.columns} columns × {surface.span} lags
                </Badge>
              }
              note="Each column is one correlation, brightest at its peak. Parallel ridges are grating lobes; a single sharp ridge is an unambiguous delay."
            >
              <Heatmap
                data={surface.surface}
                columns={surface.columns}
                rows={surface.span}
                height={260}
                colormap="inferno"
                yTicks={[
                  { unit: 0, label: `${-surface.maxLag}` },
                  { unit: 0.25, label: `${Math.round(-surface.maxLag / 2)}` },
                  { unit: 0.5, label: "0" },
                  { unit: 0.75, label: `${Math.round(surface.maxLag / 2)}` },
                  { unit: 1, label: `${surface.maxLag}` },
                ]}
                xTicks={[0, 0.25, 0.5, 0.75, 1].map((u) => ({
                  unit: u,
                  label: `${(
                    (surface.times[Math.min(surface.columns - 1, Math.floor(u * surface.columns))] ?? 0)
                  ).toFixed(1)} s`,
                }))}
                overlay={{
                  values: surface.peaks.map((p) => p.peakLag + surface.maxLag),
                  colour: "#f3f6f8",
                }}
              />
              <Readout
                rows={[
                  ["lag axis", `±${surface.maxLag} samples = ±${(surface.maxLag * lagQuantumMm).toFixed(1)} mm`],
                  [
                    "median runner-up ratio",
                    (() => {
                      const arr = surface.peaks.map((p) => p.peakRatio).sort((a, b) => a - b);
                      return arr.length > 0 ? arr[arr.length >> 1]!.toFixed(3) : "—";
                    })(),
                  ],
                  [
                    "columns with a close runner-up",
                    `${surface.peaks.filter((p) => p.peakRatio > 0.8).length} of ${surface.peaks.length}`,
                  ],
                ]}
              />
            </Panel>
          ) : null}

          {coherence ? (
            <div className="grid-2">
              <Panel
                title={`Coherence, pair ${PAIRS[coherence.pair]![0] + 1}-${PAIRS[coherence.pair]![1] + 1}`}
                note="Welch-averaged magnitude-squared coherence. One means the two microphones see the same thing at that frequency; zero means they do not, and no delay estimate from that region is worth keeping."
              >
                <LinePlot
                  series={[
                    {
                      label: "MSC",
                      colour: "#22d3ee",
                      data: coherence.msc,
                      xFrom: 0,
                      xStep: coherence.binHz,
                    },
                  ]}
                  height={180}
                  yMin={0}
                  yMax={1}
                  xLabel="Hz"
                  yLabel="MSC"
                  fmtX={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0))}
                  markers={
                    environment
                      ? [
                          {
                            x: environment.geometry.gratingLongHz,
                            label: "grating",
                            colour: "#ef4444",
                          },
                        ]
                      : []
                  }
                />
                <Readout
                  rows={coherence.bands.map((b) => [
                    bands.find((x) => x.id === b.bandId)?.label ?? b.bandId,
                    b.msc.toFixed(3),
                  ])}
                />
                <p className="panel-note">
                  Averaged over {coherence.frames} blocks. Fewer than about eight blocks
                  biases coherence upward towards one, so a short selection will look
                  more coherent than it is.
                </p>
              </Panel>

              <Panel
                title="Levels across channels"
                actions={
                  <Button disabled={!audio} onClick={() => void runHealth()}>
                    Measure
                  </Button>
                }
                note="The whole array should hear a distant source at nearly the same level. Differences here are gain and mounting, and there is no per-channel correction anywhere in the project, so they have to be known."
              >
                {health ? (
                  <table className="data">
                    <thead>
                      <tr>
                        <th>channel</th>
                        <th>RMS dBFS</th>
                        <th>peak dBFS</th>
                        <th>crest dB</th>
                      </tr>
                    </thead>
                    <tbody>
                      {health.stats.map((s, i) => (
                        <tr key={i}>
                          <td style={{ color: channelColour(i) }}>mic {i + 1}</td>
                          <td>{s.rmsDb.toFixed(1)}</td>
                          <td>{s.peakDb.toFixed(1)}</td>
                          <td>{s.crestDb.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="panel-note">Not measured yet.</p>
                )}
              </Panel>
            </div>
          ) : null}

          {stft ? (
            <SpectralDifference analyzer={analyzer} />
          ) : null}
        </>
      )}
    </>
  );
}

/*
 * Mean spectrum of each channel against a reference channel.
 *
 * Averaged over the whole take this removes the source's own spectrum and leaves the
 * difference between the microphones, which is the response mismatch. A tilt of a few
 * dB across the band is normal for cheap MEMS parts; a notch or a step is a mounting
 * problem, and either will bias every level-based comparison the detector makes.
 */
function SpectralDifference({ analyzer }: { analyzer: Analyzer }) {
  const { stft, spectrogramChannels } = analyzer;
  const [reference, setReference] = useState(0);

  const means = useMemo(() => {
    if (!stft) return [];
    return spectrogramChannels.map((c) => {
      const mean = new Float32Array(c.bins);
      for (let f = 0; f < c.frames; f++) {
        const base = f * c.bins;
        for (let b = 0; b < c.bins; b++) mean[b]! += c.db[base + b]!;
      }
      for (let b = 0; b < c.bins; b++) mean[b] = mean[b]! / Math.max(1, c.frames);
      return mean;
    });
  }, [stft, spectrogramChannels]);

  if (!stft || means.length === 0) return null;
  const ref = means[reference];
  if (!ref) return null;

  return (
    <Panel
      title="Spectral difference against a reference channel"
      note="Mean dB per bin over the whole take, minus the reference. What remains is the microphones' relative response, because the source is common to all six."
    >
      <NumberField
        label="Reference channel"
        value={reference + 1}
        min={1}
        max={means.length}
        onChange={(v) => setReference(Math.max(0, Math.min(means.length - 1, v - 1)))}
      />
      <LinePlot
        series={means.map((m, i) => {
          const diff = new Float32Array(m.length);
          for (let b = 0; b < m.length; b++) diff[b] = m[b]! - ref[b]!;
          return {
            label: `mic ${i + 1}`,
            colour: channelColour(i),
            data: diff,
            xFrom: 0,
            xStep: stft.metrics.binHz,
          };
        })}
        height={200}
        xLabel="Hz"
        yLabel="dB"
        markers={[{ y: 0, colour: "#6b7a89", dashed: false }]}
        fmtX={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0))}
      />
    </Panel>
  );
}
