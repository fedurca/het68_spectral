/*
 * Array health.
 *
 * This runs before anything else is believed. A dead microphone, a clipped one, or a
 * pair of swapped channels does not produce an obviously broken result — it produces a
 * plausible one that is wrong, and a rotated azimuth looks exactly like a correct
 * azimuth to everything downstream. Clipping is the worst of them, because a clipped
 * sine fabricates a harmonic series that is indistinguishable from a rotor comb by
 * every metric this application computes.
 *
 * The mapping check replays the same calibration signal the firmware repository uses
 * (1 kHz for 100 ms into each channel in turn), because a channel swap cannot be seen
 * in a spectrogram and cannot be inferred from a flight recording.
 */

import { useMemo, useState } from "react";
import { channelColour, Heatmap, LinePlot } from "@het68/ui";
import {
  Badge,
  Button,
  Empty,
  NumberField,
  Panel,
  Readout,
} from "@het68/ui";
import { downloadJson } from "@het68/io";
import type { Analyzer } from "../state/analyzer.js";

export function HealthTab({ analyzer }: { analyzer: Analyzer }) {
  const { audio, health, runHealth, mapping, runMapping, bandsResult, bands, hopSec } =
    analyzer;
  const [toneHz, setToneHz] = useState(1000);
  const [slotMs, setSlotMs] = useState(100);

  const correlationTicks = useMemo(
    () =>
      Array.from({ length: 6 }, (_, i) => ({
        unit: (i + 0.5) / 6,
        label: `${i + 1}`,
      })),
    [],
  );

  if (!audio) {
    return (
      <Empty>
        Load a recording. For the mapping check this should be the calibration take, not
        a flight: 1 kHz for 100 ms into each channel in turn.
      </Empty>
    );
  }

  return (
    <>
      <Panel
        title="Channel statistics"
        actions={
          <>
            <Button primary onClick={() => void runHealth()}>
              Measure
            </Button>
            {health ? (
              <Button onClick={() => downloadJson("health.json", health)}>Export</Button>
            ) : null}
          </>
        }
        note="Measured over the whole recording. The noise floor is a low percentile of frame energy, so on a background take it is the array's self-noise and on a flight it is the quietest moment."
      >
        {health ? (
          <>
            <table className="data">
              <thead>
                <tr>
                  <th>channel</th>
                  <th>RMS dBFS</th>
                  <th>peak dBFS</th>
                  <th>crest dB</th>
                  <th>DC</th>
                  <th>clipped</th>
                  <th>silent</th>
                  <th>floor dBFS</th>
                  <th>ZCR</th>
                  <th>verdict</th>
                </tr>
              </thead>
              <tbody>
                {health.stats.map((s, i) => (
                  <tr key={i}>
                    <td style={{ color: channelColour(i) }}>mic {i + 1}</td>
                    <td>{s.rmsDb.toFixed(1)}</td>
                    <td>{s.peakDb.toFixed(1)}</td>
                    <td>{s.crestDb.toFixed(1)}</td>
                    <td>{s.dc.toFixed(5)}</td>
                    <td>{s.clippedSamples}</td>
                    <td>{s.silentSamples}</td>
                    <td>{s.noiseFloorDb.toFixed(1)}</td>
                    <td>{s.zeroCrossingRate.toFixed(4)}</td>
                    <td>
                      {s.dead ? (
                        <Badge tone="error">dead</Badge>
                      ) : s.saturated ? (
                        <Badge tone="error">saturated</Badge>
                      ) : s.clippedSamples > 0 ? (
                        <Badge tone="warn">clipping</Badge>
                      ) : (
                        <Badge tone="ok">ok</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {health.findings.length === 0 ? (
              <div className="finding">
                <Badge tone="ok">clear</Badge>
                <span>
                  Nothing wrong with the array in this recording. Levels are within 6 dB
                  of the median, no clipping, no significant DC.
                </span>
              </div>
            ) : (
              health.findings.map((f, i) => (
                <div key={i} className="finding" data-severity={f.severity}>
                  <Badge tone={f.severity === "error" ? "error" : "warn"}>
                    mic {f.channel + 1}
                  </Badge>
                  <span>{f.message}</span>
                </div>
              ))
            )}
          </>
        ) : (
          <p className="panel-note">Not measured yet.</p>
        )}
      </Panel>

      {health ? (
        <div className="grid-2">
          <Panel
            title="Cross-correlation between channels"
            note="On a background recording the microphones should be nearly uncorrelated: their self-noise is independent. A high value off the diagonal means one channel is being duplicated into another, or a wiring fault has them sharing a signal."
          >
            <Heatmap
              data={health.correlations}
              columns={6}
              rows={6}
              height={200}
              colormap="magma"
              vMin={-1}
              vMax={1}
              xTicks={correlationTicks}
              yTicks={correlationTicks}
            />
            <div className="scroll-y" style={{ maxHeight: "12rem" }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>pair</th>
                    <th>correlation</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 6 }, (_, i) =>
                    Array.from({ length: 6 }, (_, j) => ({ i, j })),
                  )
                    .flat()
                    .filter(({ i, j }) => j > i)
                    .map(({ i, j }) => {
                      const v = health.correlations[i * 6 + j]!;
                      return (
                        <tr key={`${i}-${j}`}>
                          <td>
                            {i + 1}-{j + 1}
                          </td>
                          <td>
                            {Math.abs(v) > 0.9 ? (
                              <Badge tone="error">{v.toFixed(3)}</Badge>
                            ) : Math.abs(v) > 0.6 ? (
                              <Badge tone="warn">{v.toFixed(3)}</Badge>
                            ) : (
                              v.toFixed(3)
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel
            title="Channel mapping"
            actions={
              <Button onClick={() => void runMapping()}>Check</Button>
            }
            note="Expects the calibration sequence from the firmware repository: a tone into channel 1, then 2, and so on. A swapped pair rotates every azimuth the array will ever report, and nothing else in this application can detect that."
          >
            <NumberField
              label="Tone (Hz)"
              value={toneHz}
              min={100}
              max={10000}
              step={100}
              onChange={setToneHz}
            />
            <NumberField
              label="Slot (ms)"
              value={slotMs}
              min={20}
              max={2000}
              step={10}
              onChange={setSlotMs}
            />

            {mapping ? (
              <>
                <table className="data">
                  <thead>
                    <tr>
                      <th>slot</th>
                      <th>expected</th>
                      <th>found</th>
                      <th>margin dB</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(mapping.active).map((ch, slot) => {
                      const expected = slot % 6;
                      const ok = ch === expected;
                      return (
                        <tr key={slot}>
                          <td>{slot}</td>
                          <td>mic {expected + 1}</td>
                          <td style={{ color: channelColour(ch) }}>
                            {ok ? `mic ${ch + 1}` : <Badge tone="error">mic {ch + 1}</Badge>}
                          </td>
                          <td>
                            {mapping.marginDb[slot]! < 12 ? (
                              <Badge tone="warn">{mapping.marginDb[slot]!.toFixed(1)}</Badge>
                            ) : (
                              mapping.marginDb[slot]!.toFixed(1)
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {mapping.problems.length === 0 ? (
                  <div className="finding">
                    <Badge tone="ok">mapping correct</Badge>
                    <span>Every slot carried the tone on the channel it should have.</span>
                  </div>
                ) : (
                  mapping.problems.map((p, i) => (
                    <div key={i} className="finding" data-severity="error">
                      <span>{p}</span>
                    </div>
                  ))
                )}
              </>
            ) : (
              <p className="panel-note">Not checked yet.</p>
            )}
          </Panel>
        </div>
      ) : null}

      {bandsResult ? (
        <Panel
          title="Self-noise per band"
          note="From the background recording this is the floor every detection threshold has to clear. Run the band metrics on a take with nothing flying to read it."
        >
          <LinePlot
            series={bands
              .filter((b) => b.enabled)
              .map((b) => {
                const s = bandsResult.series.filter((x) => x.bandId === b.id);
                const data = new Float32Array(s.length);
                s.sort((x, y) => x.channel - y.channel).forEach((x, i) => {
                  data[i] = x.noiseFloorDb;
                });
                return {
                  label: b.label,
                  colour: b.colour,
                  data,
                  xFrom: 1,
                  xStep: 1,
                };
              })}
            height={170}
            xLabel="channel"
            yLabel="dBFS"
            fmtX={(v) => v.toFixed(0)}
          />
          <Readout
            rows={[
              ["frames measured", bandsResult.frames],
              ["frame length", `${(hopSec * 1000).toFixed(1)} ms`],
            ]}
          />
        </Panel>
      ) : null}
    </>
  );
}
