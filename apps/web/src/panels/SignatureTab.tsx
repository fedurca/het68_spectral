/*
 * Drone signatures: blade-pass frequency, the harmonic comb over time, several rotors
 * at once, and templates extracted from a marked selection.
 *
 * The whole design rests on one constraint. Ground truth needs a 32 g Dronetag Mini on
 * a 151 g airframe, which is 21 percent more mass and, since thrust goes with the
 * square of rotor speed, roughly 10 percent more RPM. Every recording with position
 * truth therefore carries a shifted fundamental, and a template keyed to an absolute f0
 * would describe the instrumented aircraft rather than the stock one it is meant to
 * detect. So a signature here stores relative harmonic levels, band ratios, the
 * harmonic-to-noise ratio, and the ratios between the rotors — never f0 itself, which
 * appears only as a wide acceptance gate.
 *
 * Four rotors trimmed slightly apart is the other half. One rotor is a fan; four
 * independent combs beating against each other is a multirotor, and nothing in a
 * natural background does that.
 */

import { useEffect, useState } from "react";
import { channelColour, LinePlot } from "@het68/ui";
import {
  Badge,
  Button,
  DataTable,
  Empty,
  NumberField,
  Panel,
  Readout,
} from "@het68/ui";
import { downloadJson, envelope } from "@het68/io";
import { NEO2, type Signature } from "@het68/dsp-core";
import type { Analyzer, SignatureEntry } from "../state/analyzer.js";
import type { CepstrumResult, F0FrameResult } from "../dsp/protocol.js";

export function SignatureTab({ analyzer }: { analyzer: Analyzer }) {
  const {
    stft,
    audio,
    harmonic,
    setHarmonic,
    f0,
    runF0,
    selection,
    extractSignature,
    matchSignature,
    matchScore,
    library,
    setLibrary,
    hopSec,
    client,
    appendLog,
  } = analyzer;

  const [label, setLabel] = useState("Neo 2 hover");
  const [ridFitted, setRidFitted] = useState(true);
  const [distanceM, setDistanceM] = useState(25);
  const [azimuthDeg, setAzimuthDeg] = useState(0);
  const [conditions, setConditions] = useState("");
  const [inspectFrame, setInspectFrame] = useState<number | null>(null);
  const [frameCandidates, setFrameCandidates] = useState<F0FrameResult | null>(null);
  const [cepstrum, setCepstrum] = useState<CepstrumResult | null>(null);

  // Per-frame candidates and the cepstrum are only fetched for the frame being
  // inspected. Both are cheap for one frame and wasteful for all of them.
  useEffect(() => {
    if (inspectFrame === null || !client.current) {
      setFrameCandidates(null);
      setCepstrum(null);
      return;
    }
    const c = client.current;
    let cancelled = false;
    void c
      .f0Frame({
        channel: harmonic.channel,
        frame: inspectFrame,
        fLoHz: harmonic.fLoHz,
        fHiHz: harmonic.fHiHz,
        nHarmonics: harmonic.nHarmonics,
        blades: harmonic.blades,
      })
      .then((r) => {
        if (!cancelled) setFrameCandidates(r);
      })
      .catch(() => setFrameCandidates(null));
    void c
      .cepstrum(harmonic.channel, inspectFrame)
      .then((r) => {
        if (!cancelled) setCepstrum(r);
      })
      .catch(() => setCepstrum(null));
    return () => {
      cancelled = true;
    };
  }, [inspectFrame, harmonic, client]);

  const importLibrary = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as {
        payload?: { signatures?: SignatureEntry[] };
        signatures?: SignatureEntry[];
      };
      const entries = parsed.payload?.signatures ?? parsed.signatures;
      if (!Array.isArray(entries)) throw new Error("No signature array in that file");
      setLibrary((prev) => [...prev, ...entries]);
      appendLog(`imported ${entries.length} signature(s) from ${file.name}`);
    } catch (err) {
      appendLog(
        `ERROR importing signatures: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  if (!stft) {
    return (
      <Empty>
        Run an STFT first. For the comb to be resolvable the bin width has to be
        comparable with the rotors' separation, which means 4096 at the least and 8192 in
        a steady hover.
      </Empty>
    );
  }

  const lockedTrack = f0
    ? new Float32Array(f0.track.map((p) => (p.locked ? p.f0Hz : Number.NaN)))
    : null;
  const rpmTrack = f0
    ? new Float32Array(f0.track.map((p) => (p.locked ? p.rpm : Number.NaN)))
    : null;
  const combCount = f0 ? Float32Array.from(f0.combsPerFrame) : null;

  return (
    <>
      <Panel
        title="Comb tracking"
        actions={
          <Button primary onClick={() => void runF0()}>
            Track f0
          </Button>
        }
        note={`Blade-pass frequency is rpm/60 × blades. For the Neo 2 with two blades per rotor, hover somewhere between ${NEO2.rpmRangeHover.lo} and ${NEO2.rpmRangeHover.hi} rpm puts f0 between ${NEO2.bpfRangeHz.lo} and ${NEO2.bpfRangeHz.hi} Hz — an estimate from thrust, since DJI publishes no rotor speed. Measuring the real rate from the first recording is a task in its own right.`}
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
            label="Channel"
            value={harmonic.channel + 1}
            min={1}
            max={stft.channels}
            onChange={(v) =>
              setHarmonic((h) => ({ ...h, channel: Math.max(0, Math.min(5, v - 1)) }))
            }
          />
          <NumberField
            label="f0 search low (Hz)"
            value={harmonic.fLoHz}
            min={50}
            step={25}
            onChange={(v) => setHarmonic((h) => ({ ...h, fLoHz: v }))}
          />
          <NumberField
            label="f0 search high (Hz)"
            value={harmonic.fHiHz}
            min={100}
            step={25}
            onChange={(v) => setHarmonic((h) => ({ ...h, fHiHz: v }))}
          />
          <NumberField
            label="Harmonics"
            value={harmonic.nHarmonics}
            min={2}
            max={20}
            onChange={(v) => setHarmonic((h) => ({ ...h, nHarmonics: v }))}
            hint="Six to nine fit below 6 kHz at this spacing."
          />
          <NumberField
            label="Blades"
            value={harmonic.blades}
            min={1}
            max={6}
            onChange={(v) => setHarmonic((h) => ({ ...h, blades: v }))}
          />
          <NumberField
            label="Max jump between frames"
            value={harmonic.maxRelJump}
            min={0.005}
            max={0.5}
            step={0.005}
            onChange={(v) => setHarmonic((h) => ({ ...h, maxRelJump: v }))}
            hint="As a fraction of f0. A real machine cannot change rotor speed faster than this between frames."
          />
          <NumberField
            label="Frames tolerated without a comb"
            value={harmonic.maxMiss}
            min={0}
            max={100}
            onChange={(v) => setHarmonic((h) => ({ ...h, maxMiss: v }))}
          />
        </div>

        {f0 ? (
          <Readout
            rows={[
              ["median f0", `${f0.medianF0Hz.toFixed(1)} Hz`],
              ["median rotor speed", `${f0.medianRpm.toFixed(0)} rpm`],
              ["locked frames", `${(f0.lockedFraction * 100).toFixed(0)} %`],
              [
                "plausible for a Neo 2",
                f0.medianRpm >= NEO2.rpmRangeHover.lo * 0.8 &&
                f0.medianRpm <= NEO2.rpmRangeHover.hi * 1.25
                  ? "yes"
                  : "no, outside the thrust-derived range",
              ],
              [
                "with the RID module fitted",
                `expect about ${(f0.medianF0Hz * (1 + NEO2.ridRpmShiftPct / 100)).toFixed(0)} Hz`,
              ],
            ]}
          />
        ) : null}
      </Panel>

      {f0 && lockedTrack && rpmTrack && combCount ? (
        <>
          <Panel
            title="Fundamental over time"
            note="Gaps are frames where no comb scored well enough to hold the lock. A track that steps by an exact factor is the tracker jumping an octave, which is what the maximum-jump limit exists to prevent."
          >
            <LinePlot
              series={[
                {
                  label: "f0",
                  colour: channelColour(f0.channel),
                  data: lockedTrack,
                  xFrom: 0,
                  xStep: hopSec,
                  width: 1.6,
                },
              ]}
              height={180}
              xLabel="s"
              yLabel="Hz"
              markers={[
                { y: NEO2.bpfRangeHz.lo, label: "thrust-derived range", colour: "#6b7a89" },
                { y: NEO2.bpfRangeHz.hi, colour: "#6b7a89" },
                { y: 800, label: "firmware drone band starts here", colour: "#f59e0b" },
              ]}
              onClick={(x) => setInspectFrame(Math.max(0, Math.round(x / hopSec)))}
              cursorX={inspectFrame !== null ? inspectFrame * hopSec : null}
              selection={
                selection ? { from: selection.startSec, to: selection.endSec } : null
              }
            />
            <p className="panel-note">
              Click the plot to inspect a single frame's candidates and cepstrum.
            </p>
          </Panel>

          <div className="grid-2">
            <Panel
              title="Rotor speed"
              note="The same track in the unit where an implausible answer is obvious. A 55.9 mm ducted propeller cannot turn at 60000 rpm."
            >
              <LinePlot
                series={[
                  {
                    label: "rpm",
                    colour: "#a78bfa",
                    data: rpmTrack,
                    xFrom: 0,
                    xStep: hopSec,
                  },
                ]}
                height={160}
                xLabel="s"
                yLabel="rpm"
                markers={[
                  { y: NEO2.rpmRangeHover.lo, colour: "#6b7a89" },
                  { y: NEO2.rpmRangeHover.hi, label: "hover estimate", colour: "#6b7a89" },
                ]}
                fmtY={(v) => (v / 1000).toFixed(0) + "k"}
              />
            </Panel>

            <Panel
              title="Simultaneous combs"
              note="How many independent rotor combs each frame supports. Four is a quadcopter; one is a fan or a single-rotor source; zero is background. This count, not absolute f0, is what separates a multirotor from everything else."
            >
              <LinePlot
                series={[
                  {
                    label: "combs",
                    colour: "#22d3ee",
                    data: combCount,
                    xFrom: 0,
                    xStep: hopSec,
                  },
                ]}
                height={160}
                yMin={0}
                yMax={6}
                xLabel="s"
                yLabel="count"
                fmtY={(v) => v.toFixed(0)}
              />
            </Panel>
          </div>
        </>
      ) : null}

      {inspectFrame !== null ? (
        <div className="grid-2">
          <Panel
            title={`Candidates in frame ${inspectFrame} (${(inspectFrame * hopSec).toFixed(3)} s)`}
            actions={<Button onClick={() => setInspectFrame(null)}>Close</Button>}
            note="Scored by a harmonic product over the whole spectrum, then filtered to those within 60 % of the best. Sub-multiples and harmonics of the true rate score well by construction, which is why the filter exists."
          >
            {frameCandidates ? (
              frameCandidates.candidates.length === 0 ? (
                <p className="panel-note">No comb in this frame.</p>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>f0 Hz</th>
                      <th>rpm</th>
                      <th>score dB</th>
                      <th>HNR dB</th>
                      <th>harmonics</th>
                    </tr>
                  </thead>
                  <tbody>
                    {frameCandidates.candidates.map((c, i) => (
                      <tr key={i}>
                        <td>{c.f0Hz.toFixed(1)}</td>
                        <td>{c.rpm.toFixed(0)}</td>
                        <td>{c.score.toFixed(1)}</td>
                        <td>{c.hnrDb.toFixed(1)}</td>
                        <td>{c.nHarmonics}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : (
              <p className="panel-note">Loading.</p>
            )}
          </Panel>

          <Panel
            title="Cepstrum of the same frame"
            note="A peak at quefrency 1/f0 is an independent check on the comb: it comes from the periodicity of the whole harmonic series rather than from any one harmonic, so it survives a missing fundamental."
          >
            {cepstrum ? (
              <>
                <LinePlot
                  series={[
                    {
                      label: "cepstrum",
                      colour: "#f59e0b",
                      data: cepstrum.cepstrum,
                      xFrom: 0,
                      xStep: (cepstrum.quefrencySec[1] ?? 1 / 48000) * 1000,
                    },
                  ]}
                  height={170}
                  xLabel="ms"
                  yLabel="amplitude"
                  xMin={0}
                  xMax={4}
                  markers={
                    f0 && f0.track[inspectFrame]?.locked
                      ? [
                          {
                            x: 1000 / f0.track[inspectFrame]!.f0Hz,
                            label: "1/f0 from the tracker",
                            colour: "#1fbfa0",
                          },
                        ]
                      : []
                  }
                  fmtX={(v) => v.toFixed(2)}
                />
                <p className="panel-note">
                  The window shown is 0 to 4 ms, which covers fundamentals from 250 Hz
                  upward.
                </p>
              </>
            ) : (
              <p className="panel-note">Loading.</p>
            )}
          </Panel>
        </div>
      ) : null}

      <Panel
        title="Extract a template"
        note="Shift-drag on the spectrogram to mark a steady section, then extract. A hover is the right choice: the template is built from what is common across the frames, and a manoeuvre contributes spread rather than signal."
      >
        {selection ? (
          <Readout
            rows={[
              [
                "selection",
                `${selection.startSec.toFixed(3)} – ${selection.endSec.toFixed(3)} s (${Math.round((selection.endSec - selection.startSec) / hopSec)} frames)`,
              ],
            ]}
          />
        ) : (
          <p className="panel-note">Nothing selected.</p>
        )}

        <div className="field">
          <label>Label</label>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={ridFitted}
            onChange={(e) => setRidFitted(e.target.checked)}
          />
          <span>
            Dronetag Mini fitted (adds {NEO2.ridModuleMassG} g, about{" "}
            {NEO2.ridRpmShiftPct} % more rotor speed)
          </span>
        </label>
        <NumberField label="Distance (m)" value={distanceM} min={0} step={1} onChange={setDistanceM} />
        <NumberField
          label="Azimuth (deg)"
          value={azimuthDeg}
          step={1}
          onChange={setAzimuthDeg}
        />
        <div className="field">
          <label>Conditions</label>
          <input
            type="text"
            value={conditions}
            onChange={(e) => setConditions(e.target.value)}
            placeholder="wind, surface, background"
          />
        </div>

        <div className="btn-row">
          <Button
            primary
            disabled={!selection}
            onClick={() =>
              void extractSignature(label, {
                ridModuleFitted: ridFitted,
                distanceM,
                azimuthDeg,
                conditions,
              })
            }
          >
            Extract from selection
          </Button>
          <Button
            disabled={library.length === 0}
            onClick={() =>
              downloadJson(
                "signatures.json",
                envelope("het68-signature-library", {
                  signatures: library,
                  note: "Relative quantities only. Absolute f0 is deliberately absent: ground truth requires a 32 g module that lifts rotor speed by about 10 percent.",
                }),
              )
            }
          >
            Export library
          </Button>
          <label className="btn" style={{ cursor: "pointer" }}>
            Import
            <input
              type="file"
              accept=".json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importLibrary(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </Panel>

      {library.length > 0 ? (
        <Panel title="Signature library">
          <DataTable
            columns={[
              { key: "label", label: "label", render: (e: SignatureEntry) => e.label },
              {
                key: "rotors",
                label: "rotors",
                render: (e) => e.signature.combRatios.length,
              },
              {
                key: "ratios",
                label: "rate ratios",
                render: (e) =>
                  e.signature.combRatios.map((r) => r.toFixed(3)).join(" / ") || "—",
              },
              {
                key: "hnr",
                label: "HNR dB",
                render: (e) =>
                  `${e.signature.hnrDb.toFixed(1)} ± ${e.signature.hnrSdDb.toFixed(1)}`,
              },
              { key: "frames", label: "frames", render: (e) => e.signature.nFrames },
              {
                key: "rid",
                label: "RID module",
                render: (e) =>
                  e.meta.ridModuleFitted ? (
                    <Badge tone="warn" title="Rotor speed is shifted upward in this take.">
                      fitted
                    </Badge>
                  ) : (
                    "stock"
                  ),
              },
              {
                key: "gate",
                label: "f0 gate",
                render: (e) =>
                  `${e.signature.f0GateLoHz.toFixed(0)}–${e.signature.f0GateHiHz.toFixed(0)} Hz`,
              },
              {
                key: "actions",
                label: "",
                render: (e) => (
                  <Button onClick={() => void matchSignature(e)}>Match</Button>
                ),
              },
            ]}
            rows={library}
            keyOf={(e) => e.id}
            selectedKey={matchScore?.signatureId}
            maxHeight="16rem"
          />

          {library.map((e) => (
            <SignatureDetail key={e.id} entry={e} />
          ))}
        </Panel>
      ) : null}

      {matchScore ? (
        <Panel
          title={`Match against ${library.find((e) => e.id === matchScore.signatureId)?.label ?? "template"}`}
          note="Scored frame by frame, zero to one. This is the detector, evaluated on the same recording it can be judged against, and its value is in seeing where it fails rather than where it succeeds."
        >
          <LinePlot
            series={[
              {
                label: "match",
                colour: "#1fbfa0",
                data: matchScore.score,
                xFrom: 0,
                xStep: hopSec,
              },
            ]}
            height={180}
            yMin={0}
            yMax={1}
            xLabel="s"
            yLabel="score"
            markers={[{ y: 0.7, label: "a plausible threshold", colour: "#f59e0b" }]}
            selection={selection ? { from: selection.startSec, to: selection.endSec } : null}
          />
          <Readout
            rows={[
              [
                "frames above 0.7",
                `${Array.from(matchScore.score).filter((v) => v > 0.7).length} of ${matchScore.score.length}`,
              ],
              [
                "best score",
                Math.max(...Array.from(matchScore.score)).toFixed(3),
              ],
              [
                "f0 where matched",
                (() => {
                  const hits = Array.from(matchScore.f0).filter(
                    (v, i) => v > 0 && matchScore.score[i]! > 0.7,
                  );
                  if (hits.length === 0) return "—";
                  hits.sort((a, b) => a - b);
                  return `${hits[hits.length >> 1]!.toFixed(1)} Hz median`;
                })(),
              ],
            ]}
          />
          {audio?.kind === "synthetic" ? (
            <p className="panel-note">
              This is a synthetic scene, so a high score confirms the chain is
              self-consistent and nothing more. The template and the signal come from
              the same model of a rotor.
            </p>
          ) : null}
        </Panel>
      ) : null}
    </>
  );
}

function SignatureDetail({ entry }: { entry: SignatureEntry }) {
  const [open, setOpen] = useState(false);
  const s: Signature = entry.signature;
  return (
    <div>
      <Button onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} {entry.label}
      </Button>
      {open ? (
        <div className="grid-2" style={{ marginTop: "0.5rem" }}>
          <LinePlot
            series={[
              {
                label: "harmonic level",
                colour: "#1fbfa0",
                data: s.harmonicRelDb,
                xFrom: 1,
                xStep: 1,
              },
              {
                label: "+1 sd",
                colour: "#6b7a89",
                dashed: true,
                data: s.harmonicRelDb.map((v, i) => v + (s.harmonicSdDb[i] ?? 0)),
                xFrom: 1,
                xStep: 1,
              },
              {
                label: "-1 sd",
                colour: "#6b7a89",
                dashed: true,
                data: s.harmonicRelDb.map((v, i) => v - (s.harmonicSdDb[i] ?? 0)),
                xFrom: 1,
                xStep: 1,
              },
            ]}
            height={160}
            xLabel="harmonic"
            yLabel="dB below f0"
            fmtX={(v) => v.toFixed(0)}
          />
          <div>
            <Readout
              rows={[
                ["version", s.version],
                ["blades", s.blades],
                ["frames", s.nFrames],
                ["HNR", `${s.hnrDb.toFixed(1)} ± ${s.hnrSdDb.toFixed(1)} dB`],
                ["f0 drift in the take", `${s.f0DriftPct.toFixed(2)} %`],
                ["modulation depth", `${s.modDepthDb.toFixed(2)} dB`],
                ["band levels", s.bandRelDb.map((v) => v.toFixed(1)).join(" / ")],
                ["source", `${entry.meta.sourceFile} ch ${entry.meta.channel + 1}`],
                [
                  "range",
                  `${entry.meta.startSec.toFixed(2)} – ${entry.meta.endSec.toFixed(2)} s`,
                ],
                ["conditions", entry.meta.conditions || "—"],
              ]}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
