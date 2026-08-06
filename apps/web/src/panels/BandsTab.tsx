/*
 * Watched frequency bands and their metrics over time.
 *
 * The firmware classifies by band energy, so this is where its band edges get
 * questioned. The drone band starts at 800 Hz, and the Neo 2's blade-pass frequency
 * sits somewhere around 900 Hz at hover and falls below 800 Hz off throttle — so an
 * edge chosen for larger aircraft can lose the fundamental of this one exactly when
 * it is descending. Rather than assert that, the panel plots the band's energy, its
 * signal-to-noise against its own floor, and its tonality, and marks the grating
 * frequency and the drone band on the same axis.
 *
 * Tonality is the metric that separates a rotor from wind. Wind has energy and no
 * structure; a rotor has a comb. Energy alone confuses the two, which is the failure
 * mode a purely energy-based classifier cannot escape.
 */

import { useMemo, useState } from "react";
import { channelColour, LinePlot } from "@het68/ui";
import {
  Badge,
  Button,
  Empty,
  NumberField,
  Panel,
  Readout,
  Segmented,
  Toggle,
} from "@het68/ui";
import { downloadCsv, seriesToCsv } from "@het68/io";
import type { Analyzer, BandDefinition } from "../state/analyzer.js";

type Metric = "energyDb" | "snrDb" | "tonality";

const METRICS: ReadonlyArray<{ value: Metric; label: string; title: string }> = [
  { value: "energyDb", label: "Energy", title: "Mean power in the band, dBFS." },
  {
    value: "snrDb",
    label: "SNR",
    title:
      "Band energy above its own 10th-percentile floor, which is what a threshold detector actually sees.",
  },
  {
    value: "tonality",
    label: "Tonality",
    title:
      "Peak against the band's geometric mean. High means a comb, low means broadband. This is what tells a rotor from wind.",
  },
];

export function BandsTab({ analyzer }: { analyzer: Analyzer }) {
  const {
    bands,
    setBands,
    bandsResult,
    runBands,
    stft,
    hopSec,
    audio,
    environment,
    view,
    selection,
  } = analyzer;
  const [metric, setMetric] = useState<Metric>("snrDb");
  const [perChannel, setPerChannel] = useState(false);
  const [channel, setChannel] = useState(0);
  const [hoverSec, setHoverSec] = useState<number | null>(null);

  const nyquist = (audio?.sampleRate ?? 48000) / 2;

  const update = (id: string, patch: Partial<BandDefinition>) =>
    setBands((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  const addBand = () =>
    setBands((prev) => [
      ...prev,
      {
        id: `band-${Date.now().toString(36)}`,
        label: "New band",
        loHz: 1000,
        hiHz: 2000,
        colour: "#94a3b8",
        firmware: false,
        enabled: true,
      },
    ]);

  const activeBands = bands.filter((b) => b.enabled);

  // Plot series: either every band on one channel, or one band across all six.
  const series = useMemo(() => {
    if (!bandsResult) return [];
    if (perChannel) {
      const band = activeBands[0];
      if (!band) return [];
      return bandsResult.series
        .filter((s) => s.bandId === band.id)
        .map((s) => ({
          label: `mic ${s.channel + 1}`,
          colour: channelColour(s.channel),
          data: s[metric],
          xFrom: 0,
          xStep: hopSec,
        }));
    }
    return bandsResult.series
      .filter((s) => s.channel === channel)
      .map((s) => ({
        label: bands.find((b) => b.id === s.bandId)?.label ?? s.bandId,
        colour: bands.find((b) => b.id === s.bandId)?.colour ?? "#94a3b8",
        data: s[metric],
        xFrom: 0,
        xStep: hopSec,
      }));
  }, [bandsResult, perChannel, activeBands, metric, channel, bands, hopSec]);

  const hoverFrame =
    hoverSec !== null && hopSec > 0 ? Math.round(hoverSec / hopSec) : null;

  const exportCsv = () => {
    if (!bandsResult) return;
    const columns = bandsResult.series.map(
      (s) => `mic${s.channel + 1}_${s.bandId}_${metric}`,
    );
    const rows: number[][] = [];
    for (let f = 0; f < bandsResult.frames; f++) {
      rows.push([f * hopSec, ...bandsResult.series.map((s) => s[metric][f] ?? Number.NaN)]);
    }
    downloadCsv(`bands-${metric}.csv`, seriesToCsv(["time_s", ...columns], rows));
  };

  return (
    <>
      <Panel
        title="Watched bands"
        actions={
          <>
            <Button onClick={addBand}>Add band</Button>
            <Button primary disabled={!stft || activeBands.length === 0} onClick={() => void runBands()}>
              Compute
            </Button>
          </>
        }
        note="The firmware's own edges are shown for context. Only the drone band is being worked on; the rest are here so it is visible whether energy is landing where some other detector would claim it."
      >
        <table className="data">
          <thead>
            <tr>
              <th>on</th>
              <th>band</th>
              <th>low Hz</th>
              <th>high Hz</th>
              <th>width</th>
              <th>bins</th>
              <th>source</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => {
              const binCount = stft
                ? Math.max(0, Math.round((b.hiHz - b.loHz) / stft.metrics.binHz))
                : 0;
              return (
                <tr key={b.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={b.enabled}
                      onChange={(e) => update(b.id, { enabled: e.target.checked })}
                    />
                  </td>
                  <td style={{ color: b.colour }}>
                    {b.firmware ? (
                      b.label
                    ) : (
                      <input
                        type="text"
                        value={b.label}
                        onChange={(e) => update(b.id, { label: e.target.value })}
                        style={{ width: "10rem" }}
                      />
                    )}
                  </td>
                  <td>
                    <input
                      type="number"
                      value={b.loHz}
                      min={0}
                      max={nyquist}
                      step={10}
                      style={{ width: "5.5rem" }}
                      onChange={(e) => update(b.id, { loHz: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      value={b.hiHz}
                      min={0}
                      max={nyquist}
                      step={10}
                      style={{ width: "5.5rem" }}
                      onChange={(e) => update(b.id, { hiHz: Number(e.target.value) })}
                    />
                  </td>
                  <td>{(b.hiHz - b.loHz).toFixed(0)} Hz</td>
                  <td>
                    {binCount < 4 && stft ? (
                      <Badge tone="warn" title="Too few bins for a stable estimate at this FFT size.">
                        {binCount}
                      </Badge>
                    ) : (
                      binCount
                    )}
                  </td>
                  <td>{b.firmware ? "firmware" : "custom"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {environment ? (
          <p className="panel-note">
            The grating frequency on the long baseline is{" "}
            {environment.geometry.gratingLongHz.toFixed(0)} Hz. Every watched band that
            matters for drones lies entirely above it, so band energy can say something
            is there while the delay between microphones cannot say where without
            resolving the ambiguity across several harmonics.
          </p>
        ) : null}
      </Panel>

      {!bandsResult ? (
        <Empty>
          {stft
            ? "Press “Compute” to measure the enabled bands frame by frame."
            : "Run an STFT first: band metrics come from the same frames."}
        </Empty>
      ) : (
        <>
          <Panel
            title="Band metrics over time"
            actions={
              <>
                <Segmented value={metric} options={METRICS} onChange={setMetric} />
                <Button onClick={exportCsv}>Export CSV</Button>
              </>
            }
          >
            <div className="btn-row">
              <Toggle
                label="Compare channels instead of bands"
                checked={perChannel}
                onChange={setPerChannel}
              />
              {!perChannel ? (
                <NumberField
                  label="Channel"
                  value={channel + 1}
                  min={1}
                  max={stft?.channels ?? 6}
                  onChange={(v) => setChannel(Math.max(0, Math.min(5, v - 1)))}
                />
              ) : (
                <span className="panel-note">
                  Showing {activeBands[0]?.label ?? "no band"} on all six microphones. A
                  spread larger than a couple of dB at the same instant is a gain or
                  mounting difference, not a direction.
                </span>
              )}
            </div>

            <LinePlot
              series={series}
              height={220}
              xLabel="s"
              yLabel={metric === "tonality" ? "dB above flat" : "dB"}
              markers={
                metric === "snrDb"
                  ? [{ y: 6, label: "6 dB, a plausible trigger", colour: "#f59e0b" }]
                  : []
              }
              cursorX={hoverSec}
              selection={
                selection ? { from: selection.startSec, to: selection.endSec } : null
              }
              onHover={setHoverSec}
              fmtX={(v) => `${v.toFixed(1)}`}
            />
          </Panel>

          <div className="grid-2">
            <Panel title="Noise floor per band and channel">
              <p className="panel-note">
                The 10th percentile of each band's own energy over the whole take,
                estimated from a histogram rather than by sorting. On a background
                recording this is the array's self-noise; on a flight it is whatever the
                quietest moment was.
              </p>
              <div className="scroll-y">
                <table className="data">
                  <thead>
                    <tr>
                      <th>band</th>
                      {Array.from({ length: stft?.channels ?? 6 }, (_, i) => (
                        <th key={i} style={{ color: channelColour(i) }}>
                          mic {i + 1}
                        </th>
                      ))}
                      <th>spread</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeBands.map((b) => {
                      const floors = bandsResult.series
                        .filter((s) => s.bandId === b.id)
                        .sort((x, y) => x.channel - y.channel)
                        .map((s) => s.noiseFloorDb);
                      const spread =
                        floors.length > 0 ? Math.max(...floors) - Math.min(...floors) : 0;
                      return (
                        <tr key={b.id}>
                          <td style={{ color: b.colour }}>{b.label}</td>
                          {floors.map((f, i) => (
                            <td key={i}>{f.toFixed(1)}</td>
                          ))}
                          <td>
                            {spread > 6 ? (
                              <Badge tone="warn" title="A large spread in self-noise means the microphones are not matched.">
                                {spread.toFixed(1)} dB
                              </Badge>
                            ) : (
                              `${spread.toFixed(1)} dB`
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title={hoverFrame !== null ? `At ${hoverSec!.toFixed(3)} s` : "At the cursor"}>
              {hoverFrame !== null ? (
                <Readout
                  rows={bandsResult.series
                    .filter((s) => s.channel === channel)
                    .map((s) => {
                      const label = bands.find((b) => b.id === s.bandId)?.label ?? s.bandId;
                      const e = s.energyDb[hoverFrame] ?? Number.NaN;
                      const snr = s.snrDb[hoverFrame] ?? Number.NaN;
                      const t = s.tonality[hoverFrame] ?? Number.NaN;
                      return [
                        label,
                        `${e.toFixed(1)} dBFS · SNR ${snr.toFixed(1)} dB · tonality ${t.toFixed(1)} dB`,
                      ] as [string, string];
                    })}
                />
              ) : (
                <p className="panel-note">Move the pointer over the plot.</p>
              )}
              <p className="panel-note">
                Both frame counts follow the STFT: {bandsResult.frames} frames at{" "}
                {(hopSec * 1000).toFixed(1)} ms, over the same window as the
                spectrogram, so what is read here is exactly what is drawn there.
              </p>
              {view.frameTo - view.frameFrom < bandsResult.frames ? (
                <p className="panel-note">
                  The spectrogram is zoomed to frames {Math.round(view.frameFrom)}–
                  {Math.round(view.frameTo)}; these plots always show the whole take.
                </p>
              ) : null}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
