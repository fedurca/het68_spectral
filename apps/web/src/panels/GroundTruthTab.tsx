/*
 * Ground truth from the Dronetag Mini.
 *
 * The aircraft's own Remote ID cannot be enabled in the Czech Republic, so position
 * truth comes from an external 32 g module, and that fact shapes everything here. The
 * module adds 21 percent to a 151 g airframe, so every recording with truth has rotor
 * speed roughly 10 percent above stock — which is why signatures must not key on
 * absolute f0, and why this panel states the shift rather than hiding it.
 *
 * The second thing this panel exists to make unavoidable: GNSS is not better than the
 * array. Three metres of horizontal error subtends 17 degrees at 10 m and 1.7 degrees
 * at 100 m, against an angular resolution of about 1.07 degrees. So the accuracy
 * ceiling is drawn on the same axis as every error, and below roughly 30 m an
 * "error" here is a statement about GNSS rather than about the microphones. Close-range
 * truth has to come from a tape measure and a marked stand.
 */

import { useMemo, useRef, useState } from "react";
import { Heatmap, LinePlot } from "@het68/ui";
import {
  Badge,
  Button,
  DataTable,
  Empty,
  NumberField,
  Panel,
  Readout,
} from "@het68/ui";
import {
  angularErrorSeries,
  decodeAdvRecords,
  downloadCsv,
  fixesToTrack,
  gnssAngularCeilingDeg,
  interpolateTrack,
  parseAdvPayloadsNdjson,
  seriesToCsv,
  type AzElPoint,
  type CubeReference,
  type ErrorSummary,
  type OdidDecodeResult,
} from "@het68/io";
import { NEO2 } from "@het68/dsp-core";
import type { Analyzer } from "../state/analyzer.js";

export function GroundTruthTab({ analyzer }: { analyzer: Analyzer }) {
  const { audio, timeSyncEpoch, setTimeSyncEpoch, appendLog, hopSec, stft } = analyzer;
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [decoded, setDecoded] = useState<OdidDecodeResult | null>(null);
  const [cube, setCube] = useState<CubeReference>({
    latDeg: 50.0755,
    lonDeg: 14.4378,
    heightAboveTakeoffM: 1.2,
    micOneBearingDeg: 0,
  });
  const [assumedAccuracyM, setAssumedAccuracyM] = useState(3);
  const [maxGapSec, setMaxGapSec] = useState(3);

  const track = useMemo<AzElPoint[]>(
    () => (decoded ? fixesToTrack(decoded.fixes, cube) : []),
    [decoded, cube],
  );

  // Truth resampled onto the analysis frame rate. The array would produce a direction
  // about five times a second; the Mini advertises at 1 to 4 Hz, so the comparison
  // only exists after interpolation.
  const resampled = useMemo(() => {
    if (track.length === 0 || !audio || timeSyncEpoch === null || hopSec <= 0) return null;
    const frames = stft?.frames ?? Math.floor(audio.durationSec / hopSec);
    const az = new Float32Array(frames);
    const el = new Float32Array(frames);
    const range = new Float32Array(frames);
    const ceiling = new Float32Array(frames);
    let covered = 0;
    for (let f = 0; f < frames; f++) {
      const p = interpolateTrack(track, timeSyncEpoch + f * hopSec, maxGapSec);
      if (!p) {
        az[f] = Number.NaN;
        el[f] = Number.NaN;
        range[f] = Number.NaN;
        ceiling[f] = Number.NaN;
        continue;
      }
      covered++;
      az[f] = p.azDeg;
      el[f] = p.elDeg;
      range[f] = p.slantRangeM;
      ceiling[f] = p.angularCeilingDeg;
    }
    return { az, el, range, ceiling, frames, covered };
  }, [track, audio, timeSyncEpoch, hopSec, maxGapSec, stft?.frames]);

  // Until the DOA estimator exists there is nothing to compare against, so the error
  // machinery is exercised against the truth itself. That verifies the plumbing and
  // the ceiling arithmetic, and the panel says as much rather than presenting it as a
  // result.
  const selfCheck = useMemo<ErrorSummary | null>(() => {
    if (track.length === 0) return null;
    return angularErrorSeries(
      track.map((p) => ({ epochSec: p.epochSec, azDeg: p.azDeg, elDeg: p.elDeg })),
      track,
      maxGapSec,
    );
  }, [track, maxGapSec]);

  const loadFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseAdvPayloadsNdjson(text);
    for (const w of parsed.warnings) appendLog(`ndjson: ${w}`);
    const dec = decodeAdvRecords(parsed.records);
    for (const w of dec.warnings) appendLog(`odid: ${w}`);
    setDecoded(dec);
    appendLog(
      `${file.name}: ${parsed.records.length} advertisements, ${dec.fixes.length} position fixes, ${dec.droppedFrames} frames missing by counter`,
    );
    if (dec.fixes.length > 0 && timeSyncEpoch === null) {
      // Without a TIME SYNC line the recording's start is unknown, so the first fix is
      // offered as a starting point and clearly marked as a guess.
      setTimeSyncEpoch(dec.fixes[0]!.epochSec);
      appendLog(
        "No TIME SYNC was loaded, so the recording start is assumed to be the first fix. Correct it below or load the annotation file that carries TIME SYNC.",
      );
    }
  };

  // Azimuth against time as an image, which shows a pass through the array better than
  // a line: a target crossing overhead sweeps azimuth quickly while elevation peaks.
  const polar = useMemo(() => {
    if (!resampled) return null;
    const bins = 72;
    const data = new Float32Array(resampled.frames * bins);
    for (let f = 0; f < resampled.frames; f++) {
      const a = resampled.az[f]!;
      if (!Number.isFinite(a)) continue;
      const b = Math.min(bins - 1, Math.floor((a / 360) * bins));
      data[f * bins + b] = 1;
    }
    return { data, bins };
  }, [resampled]);

  return (
    <>
      <Panel
        title="Dronetag Mini"
        actions={
          <Button primary onClick={() => fileInput.current?.click()}>
            Open adv_payloads.ndjson
          </Button>
        }
        note={`The aircraft's native Remote ID cannot be enabled here, so the external module is mandatory for truth. It weighs ${NEO2.ridModuleMassG} g on a ${NEO2.massG} g airframe, which lifts rotor speed by roughly ${NEO2.ridRpmShiftPct} percent — every take with truth is acoustically the instrumented aircraft, not the stock one.`}
      >
        <input
          ref={fileInput}
          type="file"
          accept=".ndjson,.jsonl,.json,.txt"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadFile(f);
            e.target.value = "";
          }}
        />

        {decoded ? (
          <>
            <Readout
              rows={[
                ["position fixes", decoded.fixes.length],
                ["frames decoded", decoded.frames.length],
                [
                  "missing by counter",
                  decoded.droppedFrames > 0 ? (
                    `${decoded.droppedFrames} (BLE is lossy; gaps are dropouts, not stationary flight)`
                  ) : (
                    "none"
                  ),
                ],
                [
                  "framing seen",
                  Object.entries(decoded.framingCounts)
                    .map(([k, v]) => `${k}×${v}`)
                    .join(", ") || "—",
                ],
                [
                  "aircraft id",
                  decoded.basicIds.map((b) => `${b.uasId} (${b.idTypeName})`).join(", ") ||
                    "not advertised",
                ],
                [
                  "fixes without own timestamp",
                  decoded.fixes.filter((f) => f.timeFromHost).length,
                ],
                [
                  "median horizontal accuracy",
                  (() => {
                    const acc = decoded.fixes
                      .map((f) => f.horizontalAccuracyM)
                      .filter((v): v is number => v !== null)
                      .sort((a, b) => a - b);
                    return acc.length > 0 ? `${acc[acc.length >> 1]!.toFixed(1)} m` : "not reported";
                  })(),
                ],
              ]}
            />
            {decoded.fixes.length === 0 ? (
              <div className="finding" data-severity="warn">
                <span>
                  Advertisements decoded but no Location messages among them. The scanner
                  may have captured only Basic ID, or the payload column in the file is
                  not the raw advertisement.
                </span>
              </div>
            ) : null}
          </>
        ) : (
          <p className="panel-note">
            The file is re-parsed from the raw hex here rather than trusting the fields
            the scanner wrote, so that timestamp and height carry the same meaning as
            the standard gives them.
          </p>
        )}
      </Panel>

      <Panel
        title="Cube reference"
        note="Where the cube was and which way it faced. Array azimuth 0 is microphone 1, so a cube set down facing anywhere but the recorded bearing rotates every angle the comparison produces."
      >
        <NumberField
          label="Latitude"
          value={cube.latDeg}
          step={0.000001}
          onChange={(v) => setCube((c) => ({ ...c, latDeg: v }))}
        />
        <NumberField
          label="Longitude"
          value={cube.lonDeg}
          step={0.000001}
          onChange={(v) => setCube((c) => ({ ...c, lonDeg: v }))}
        />
        <NumberField
          label="Cube above take-off point (m)"
          value={cube.heightAboveTakeoffM}
          step={0.1}
          onChange={(v) => setCube((c) => ({ ...c, heightAboveTakeoffM: v }))}
          hint="Height above take-off is preferred over geodetic altitude: it cancels most of the vertical GNSS error, provided this offset was measured."
        />
        <NumberField
          label="Microphone 1 bearing (deg true)"
          value={cube.micOneBearingDeg}
          min={0}
          max={360}
          step={1}
          onChange={(v) => setCube((c) => ({ ...c, micOneBearingDeg: v }))}
        />
        <NumberField
          label="Recording start (epoch s)"
          value={timeSyncEpoch ?? 0}
          step={0.001}
          onChange={(v) => setTimeSyncEpoch(v)}
          hint="From the firmware's TIME SYNC line. Everything downstream is only as good as this: one second of error at 12 m/s is 12 m of position."
        />
        <NumberField
          label="Assumed accuracy when unreported (m)"
          value={assumedAccuracyM}
          min={0.5}
          max={30}
          step={0.5}
          onChange={setAssumedAccuracyM}
        />
        <NumberField
          label="Largest gap to interpolate (s)"
          value={maxGapSec}
          min={0.5}
          max={30}
          step={0.5}
          onChange={setMaxGapSec}
          hint="Longer holes are dropouts, and a straight line drawn through one is fiction."
        />

        <Readout
          rows={[
            ["ceiling at 10 m", `${gnssAngularCeilingDeg(10, assumedAccuracyM).toFixed(1)}°`],
            ["ceiling at 30 m", `${gnssAngularCeilingDeg(30, assumedAccuracyM).toFixed(1)}°`],
            ["ceiling at 100 m", `${gnssAngularCeilingDeg(100, assumedAccuracyM).toFixed(2)}°`],
            ["array angular resolution", "about 1.07° at a 384 mm edge"],
            [
              "range where truth becomes useful",
              `${(assumedAccuracyM / Math.tan(1.07 * (Math.PI / 180))).toFixed(0)} m and beyond`,
            ],
          ]}
        />
      </Panel>

      {track.length === 0 ? (
        <Empty>
          Load the ndjson dump to see the track. Without recordings and without truth the
          synthetic scene generator is the only source of known geometry, and it is exact
          rather than approximate.
        </Empty>
      ) : (
        <>
          <Panel title="Track as the array would see it">
            <LinePlot
              series={[
                {
                  label: "azimuth",
                  colour: "#1fbfa0",
                  data: track.map((p) => p.azDeg),
                  xFrom: 0,
                  xStep: 1,
                },
                {
                  label: "elevation",
                  colour: "#3b82f6",
                  data: track.map((p) => p.elDeg),
                  xFrom: 0,
                  xStep: 1,
                },
              ]}
              height={190}
              xLabel="fix"
              yLabel="deg"
              fmtX={(v) => v.toFixed(0)}
            />
            <LinePlot
              series={[
                {
                  label: "slant range",
                  colour: "#f59e0b",
                  data: track.map((p) => p.slantRangeM),
                  xFrom: 0,
                  xStep: 1,
                },
                {
                  label: "height above cube",
                  colour: "#a78bfa",
                  data: track.map((p) => p.heightAboveCubeM),
                  xFrom: 0,
                  xStep: 1,
                },
              ]}
              height={170}
              xLabel="fix"
              yLabel="m"
              fmtX={(v) => v.toFixed(0)}
            />
            <LinePlot
              series={[
                {
                  label: "GNSS angular ceiling",
                  colour: "#ef4444",
                  data: track.map((p) => p.angularCeilingDeg),
                  xFrom: 0,
                  xStep: 1,
                },
              ]}
              height={150}
              xLabel="fix"
              yLabel="deg"
              logY
              markers={[
                { y: 1.07, label: "array resolution", colour: "#1fbfa0" },
              ]}
              fmtX={(v) => v.toFixed(0)}
            />
            <p className="panel-note">
              Where the red line is above the green one, the truth is coarser than the
              instrument. Any angular error measured there is dominated by GNSS.
            </p>
          </Panel>

          {resampled && polar ? (
            <Panel
              title="Truth on the analysis timeline"
              actions={
                <>
                  <Badge tone={resampled.covered === resampled.frames ? "ok" : "warn"}>
                    {resampled.covered} of {resampled.frames} frames covered
                  </Badge>
                  <Button
                    onClick={() =>
                      downloadCsv(
                        "truth-resampled.csv",
                        seriesToCsv(
                          ["time_s", "az_deg", "el_deg", "range_m", "ceiling_deg"],
                          Array.from({ length: resampled.frames }, (_, f) => [
                            f * hopSec,
                            resampled.az[f]!,
                            resampled.el[f]!,
                            resampled.range[f]!,
                            resampled.ceiling[f]!,
                          ]),
                        ),
                      )
                    }
                  >
                    Export CSV
                  </Button>
                </>
              }
              note="Interpolated to the STFT frame rate so it lines up with everything else. Gaps are BLE dropouts, left empty rather than bridged."
            >
              <Heatmap
                data={polar.data}
                columns={resampled.frames}
                rows={polar.bins}
                height={180}
                colormap="viridis"
                vMin={0}
                vMax={1}
                yTicks={[0, 0.25, 0.5, 0.75, 1].map((u) => ({
                  unit: u,
                  label: `${Math.round(u * 360)}°`,
                }))}
                xTicks={[0, 0.5, 1].map((u) => ({
                  unit: u,
                  label: `${(u * resampled.frames * hopSec).toFixed(1)} s`,
                }))}
              />
              <LinePlot
                series={[
                  {
                    label: "azimuth",
                    colour: "#1fbfa0",
                    data: resampled.az,
                    xFrom: 0,
                    xStep: hopSec,
                  },
                  {
                    label: "elevation",
                    colour: "#3b82f6",
                    data: resampled.el,
                    xFrom: 0,
                    xStep: hopSec,
                  },
                ]}
                height={170}
                xLabel="s"
                yLabel="deg"
              />
            </Panel>
          ) : (
            <p className="panel-note">
              Set the recording start to place the truth on the recording's timeline.
            </p>
          )}

          {selfCheck ? (
            <Panel
              title="Error metric, exercised against the truth itself"
              note="There is no direction-of-arrival estimator yet, so this compares the track with itself. It confirms the interpolation and the ceiling arithmetic; it is not a measurement of the array."
            >
              <Readout
                rows={[
                  ["comparisons", selfCheck.errors.length],
                  ["unmatched", selfCheck.unmatched],
                  ["median total error", `${selfCheck.medianTotalDeg.toFixed(4)}°`],
                  ["90th percentile", `${selfCheck.p90TotalDeg.toFixed(4)}°`],
                  ["mean ceiling", `${selfCheck.meanCeilingDeg.toFixed(2)}°`],
                  [
                    "inside the ceiling",
                    `${(selfCheck.withinCeilingFraction * 100).toFixed(0)} %`,
                  ],
                ]}
              />
            </Panel>
          ) : null}

          <Panel title="Fixes">
            <DataTable
              columns={[
                {
                  key: "t",
                  label: "time",
                  render: (p: AzElPoint) =>
                    timeSyncEpoch !== null
                      ? `${(p.epochSec - timeSyncEpoch).toFixed(2)} s`
                      : new Date(p.epochSec * 1000).toISOString().slice(11, 23),
                },
                { key: "az", label: "az array", render: (p) => `${p.azDeg.toFixed(1)}°` },
                { key: "bearing", label: "bearing", render: (p) => `${p.bearingDeg.toFixed(1)}°` },
                { key: "el", label: "el", render: (p) => `${p.elDeg.toFixed(1)}°` },
                { key: "range", label: "slant m", render: (p) => p.slantRangeM.toFixed(1) },
                { key: "h", label: "height m", render: (p) => p.heightAboveCubeM.toFixed(1) },
                {
                  key: "ceiling",
                  label: "ceiling",
                  render: (p) =>
                    p.angularCeilingDeg > 1.07 ? (
                      <Badge tone="warn" title="Coarser than the array's own resolution.">
                        {p.angularCeilingDeg.toFixed(2)}°
                      </Badge>
                    ) : (
                      `${p.angularCeilingDeg.toFixed(2)}°`
                    ),
                },
                {
                  key: "clock",
                  label: "clock",
                  render: (p) =>
                    p.timeFromHost ? <Badge tone="warn">host</Badge> : "message",
                },
              ]}
              rows={track}
              keyOf={(p) => String(p.epochSec)}
              maxHeight="20rem"
            />
          </Panel>
        </>
      )}
    </>
  );
}
