/*
 * The six spectrograms, the controls that shape them, and the cursor readout.
 *
 * Overlays are chosen to answer the questions the geometry raises. The grating
 * frequency is drawn because everything above it is spatially ambiguous, and at a
 * 384 mm edge that is the whole drone band. The band edges are drawn because the
 * firmware looks for drones from 800 Hz up while the Neo 2's fundamental sits right on
 * that line and drops below it off throttle. The tracked comb is drawn with its
 * harmonics so a lock can be judged by eye rather than trusted.
 */

import { useEffect, useState } from "react";
import { channelColour, SpectrogramStack, type SpectrogramCursor } from "@het68/ui";
import {
  Badge,
  Button,
  Empty,
  LinePlot,
  NumberField,
  Panel,
  Readout,
  SelectField,
  Toggle,
} from "@het68/ui";
import {
  COLORMAP_OPTIONS,
  SCALE_OPTIONS,
  type Analyzer,
} from "../state/analyzer.js";
import type { SpectrumFrameResult } from "../dsp/protocol.js";

export function SpectrogramTab({
  analyzer,
  onGpuBytes,
}: {
  analyzer: Analyzer;
  onGpuBytes: (bytes: number) => void;
}) {
  const {
    audio,
    stft,
    spectrogramChannels,
    hopSec,
    view,
    setView,
    selection,
    setSelection,
    environment,
    bands,
    f0,
    annotations,
    harmonic,
    client,
  } = analyzer;

  const [cursor, setCursor] = useState<SpectrogramCursor | null>(null);
  const [rowHeight, setRowHeight] = useState(120);
  const [showBands, setShowBands] = useState(true);
  const [showGrating, setShowGrating] = useState(true);
  const [showComb, setShowComb] = useState(true);
  const [frameDetail, setFrameDetail] = useState<SpectrumFrameResult | null>(null);
  const [pinnedFrame, setPinnedFrame] = useState<{ channel: number; frame: number } | null>(
    null,
  );

  // Phase is only fetched for a pinned frame. Computing it for the whole recording
  // would double the STFT cost for a number that is read one point at a time.
  useEffect(() => {
    if (!pinnedFrame || !client.current) {
      setFrameDetail(null);
      return;
    }
    let cancelled = false;
    void client.current
      .spectrumFrame(pinnedFrame.channel, pinnedFrame.frame)
      .then((r) => {
        if (!cancelled) setFrameDetail(r);
      })
      .catch(() => setFrameDetail(null));
    return () => {
      cancelled = true;
    };
  }, [pinnedFrame, client]);

  if (!audio) {
    return (
      <Empty>
        Load a six-channel WAV or generate a synthetic scene to start. Until real
        recordings of the aircraft exist, the generator is the only data with known
        truth.
      </Empty>
    );
  }
  if (!stft) {
    return <Empty>Set the FFT parameters and press “Compute STFT”.</Empty>;
  }

  const horizontalLines = [
    ...(showGrating && environment
      ? [
          {
            hz: environment.geometry.gratingLongHz,
            colour: "#ef4444",
            label: `grating, long baseline ${environment.geometry.gratingLongHz.toFixed(0)} Hz`,
          },
          {
            hz: environment.geometry.gratingShortHz,
            colour: "#f59e0b",
            label: `grating, short baseline ${environment.geometry.gratingShortHz.toFixed(0)} Hz`,
          },
        ]
      : []),
    ...(showBands
      ? bands
          .filter((b) => b.enabled)
          .flatMap((b) => [
            { hz: b.loHz, colour: b.colour, label: `${b.label} lo` },
            { hz: b.hiHz, colour: b.colour },
          ])
          .filter((l) => l.hz > 0)
      : []),
  ];

  const tracks =
    showComb && f0
      ? [
          {
            channel: f0.channel,
            values: f0.track.map((p) => (p.locked ? p.f0Hz : Number.NaN)),
            colour: "#f3f6f8",
            harmonics: Math.min(harmonic.nHarmonics, 10),
          },
        ]
      : [];

  const phaseAtCursor =
    frameDetail && cursor && frameDetail.phase && cursor.bin < frameDetail.phase.length
      ? frameDetail.phase[cursor.bin]!
      : null;

  return (
    <>
      <Panel title="View" tight>
        <div
          className="panel-body"
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))" }}
        >
          <SelectField
            label="Frequency axis"
            value={view.scale}
            options={SCALE_OPTIONS}
            onChange={(v) => setView({ ...view, scale: v })}
          />
          <SelectField
            label="Colour map"
            value={view.colormap}
            options={COLORMAP_OPTIONS}
            onChange={(v) => setView({ ...view, colormap: v })}
          />
          <NumberField
            label="dB max"
            value={view.dbMax}
            step={5}
            onChange={(v) => setView({ ...view, dbMax: v })}
          />
          <NumberField
            label="dB min"
            value={view.dbMin}
            step={5}
            onChange={(v) => setView({ ...view, dbMin: v })}
          />
          <NumberField
            label="f low (Hz)"
            value={Math.round(view.fLoHz)}
            min={0}
            step={50}
            onChange={(v) => setView({ ...view, fLoHz: v })}
          />
          <NumberField
            label="f high (Hz)"
            value={Math.round(view.fHiHz)}
            min={100}
            max={audio.sampleRate / 2}
            step={100}
            onChange={(v) => setView({ ...view, fHiHz: v })}
          />
          <NumberField
            label="Row height (px)"
            value={rowHeight}
            min={48}
            max={400}
            step={8}
            onChange={setRowHeight}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            <Toggle label="Band edges" checked={showBands} onChange={setShowBands} />
            <Toggle label="Grating lines" checked={showGrating} onChange={setShowGrating} />
            <Toggle label="Tracked comb" checked={showComb} onChange={setShowComb} />
          </div>
          <div className="btn-row">
            <Button
              onClick={() =>
                setView({
                  ...view,
                  frameFrom: 0,
                  frameTo: stft.frames,
                  fLoHz: 0,
                  fHiHz: audio.sampleRate / 2,
                })
              }
            >
              Reset view
            </Button>
            <Button
              title="The band the Neo 2 actually occupies, wider than the firmware's."
              onClick={() => setView({ ...view, fLoHz: 400, fHiHz: 9000 })}
            >
              Drone band
            </Button>
            {selection ? (
              <Button onClick={() => setSelection(null)}>Clear selection</Button>
            ) : null}
          </div>
        </div>
      </Panel>

      <Panel
        title="Spectrograms, all six channels"
        note="Wheel zooms time, shift-wheel zooms frequency, drag pans, shift-drag selects a range, double click resets."
        tight
      >
        <SpectrogramStack
          channels={spectrogramChannels}
          binHz={stft.metrics.binHz}
          hopSec={hopSec}
          sampleRate={audio.sampleRate}
          view={view}
          onViewChange={setView}
          rowHeight={rowHeight}
          horizontalLines={horizontalLines}
          tracks={tracks}
          annotations={annotations.map((a) => ({
            id: a.id,
            startSec: a.startSec,
            endSec: a.endSec,
            label: a.label,
          }))}
          selection={selection}
          onSelectionChange={setSelection}
          onCursor={setCursor}
          onGpuBytes={onGpuBytes}
        />
      </Panel>

      <div className="grid-2">
        <Panel
          title="Under the cursor"
          actions={
            cursor ? (
              <Button
                onClick={() =>
                  setPinnedFrame({ channel: cursor.channel, frame: cursor.frame })
                }
                title="Fetches the full spectrum and phase for this frame."
              >
                Pin frame
              </Button>
            ) : undefined
          }
        >
          {cursor ? (
            <Readout
              rows={[
                ["channel", `mic ${cursor.channel + 1}`],
                ["time", `${cursor.timeSec.toFixed(4)} s`],
                ["frame", cursor.frame],
                ["frequency", `${cursor.freqHz.toFixed(1)} Hz`],
                ["bin", cursor.bin],
                [
                  "magnitude",
                  Number.isFinite(cursor.db) ? `${cursor.db.toFixed(2)} dBFS` : "—",
                ],
                [
                  "phase",
                  phaseAtCursor === null
                    ? "pin a frame"
                    : `${phaseAtCursor.toFixed(4)} rad (${((phaseAtCursor * 180) / Math.PI).toFixed(1)}°)`,
                ],
                [
                  "harmonic of tracked f0",
                  f0 && f0.track[cursor.frame]?.locked
                    ? (cursor.freqHz / f0.track[cursor.frame]!.f0Hz).toFixed(2)
                    : "no lock",
                ],
              ]}
            />
          ) : (
            <p className="panel-note">Move the pointer over a spectrogram.</p>
          )}

          {selection ? (
            <Readout
              rows={[
                ["selection from", `${selection.startSec.toFixed(3)} s`],
                ["selection to", `${selection.endSec.toFixed(3)} s`],
                [
                  "length",
                  `${(selection.endSec - selection.startSec).toFixed(3)} s (${Math.round((selection.endSec - selection.startSec) / hopSec)} frames)`,
                ],
              ]}
            />
          ) : null}
        </Panel>

        <Panel title="Levels across channels at this frame">
          {cursor && stft ? (
            <table className="data">
              <thead>
                <tr>
                  <th>channel</th>
                  <th>dBFS at cursor bin</th>
                  <th>vs mic 1</th>
                </tr>
              </thead>
              <tbody>
                {spectrogramChannels.map((c, i) => {
                  const idx = cursor.frame * c.bins + cursor.bin;
                  const v = idx >= 0 && idx < c.db.length ? c.db[idx]! : Number.NaN;
                  const ref =
                    spectrogramChannels[0] &&
                    cursor.frame * spectrogramChannels[0].bins + cursor.bin <
                      spectrogramChannels[0].db.length
                      ? spectrogramChannels[0].db[
                          cursor.frame * spectrogramChannels[0].bins + cursor.bin
                        ]!
                      : Number.NaN;
                  return (
                    <tr key={i}>
                      <td style={{ color: channelColour(i) }}>mic {i + 1}</td>
                      <td>{Number.isFinite(v) ? v.toFixed(2) : "—"}</td>
                      <td>
                        {Number.isFinite(v) && Number.isFinite(ref)
                          ? (v - ref).toFixed(2)
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="panel-note">
              A large spread here at a frequency the whole array should hear equally is
              usually a microphone problem rather than a spatial one.
            </p>
          )}
        </Panel>
      </div>

      {frameDetail ? (
        <Panel
          title={`Pinned frame ${frameDetail.frame} on mic ${frameDetail.channel + 1}`}
          actions={
            <>
              <Badge>{frameDetail.db.length} bins</Badge>
              <Button onClick={() => setPinnedFrame(null)}>Unpin</Button>
            </>
          }
        >
          <PinnedSpectrum detail={frameDetail} fLoHz={view.fLoHz} fHiHz={view.fHiHz} />
        </Panel>
      ) : null}
    </>
  );
}

function PinnedSpectrum({
  detail,
  fLoHz,
  fHiHz,
}: {
  detail: SpectrumFrameResult;
  fLoHz: number;
  fHiHz: number;
}) {
  const from = Math.max(0, Math.floor(fLoHz / detail.binHz));
  const to = Math.min(detail.db.length, Math.ceil(fHiHz / detail.binHz));
  const slice = detail.db.subarray(from, to);
  return (
    <LinePlot
      series={[
        {
          label: `mic ${detail.channel + 1}`,
          colour: channelColour(detail.channel),
          data: slice,
          xFrom: from * detail.binHz,
          xStep: detail.binHz,
        },
      ]}
      height={160}
      xLabel="Hz"
      yLabel="dBFS"
      fmtX={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0))}
    />
  );
}
