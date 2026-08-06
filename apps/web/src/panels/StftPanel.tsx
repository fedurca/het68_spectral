/*
 * FFT parameters and the window's derived metrics.
 *
 * The metrics are the point of this panel. Whether four rotors about 10 Hz apart can
 * be told apart is decided by bin width and by the window's equivalent noise
 * bandwidth, and whether a spool-up is visible is decided by window length in
 * milliseconds. Those two pull in opposite directions, and showing both at once is
 * what makes the trade-off a decision rather than a guess.
 */

import {
  NEO2,
  STFT_PRESETS,
  WindowKind,
} from "@het68/dsp-core";
import { Badge, Button, NumberField, Panel, Readout, SelectField } from "@het68/ui";
import {
  FFT_SIZES,
  WINDOW_OPTIONS,
  type Analyzer,
} from "../state/analyzer.js";

export function StftPanel({ analyzer }: { analyzer: Analyzer }) {
  const { stftSettings, setStftSettings, stft, runStft, audio, environment } = analyzer;
  const m = stft?.metrics;

  const sampleRate = audio?.sampleRate ?? 48000;
  const binHz = sampleRate / stftSettings.fftSize;
  const windowMs = (stftSettings.winLength / sampleRate) * 1000;
  const frames =
    audio && audio.frames >= stftSettings.winLength
      ? Math.floor((audio.frames - stftSettings.winLength) / stftSettings.hop) + 1
      : 0;

  // A quadcopter's rotors are trimmed a couple of percent apart. Whether that shows up
  // as separate combs is a question of bin width against their spacing, so the answer
  // is stated rather than left to be worked out.
  const hoverRpm = (NEO2.rpmRangeHover.lo + NEO2.rpmRangeHover.hi) / 2;
  const expectedBpf = (hoverRpm / 60) * NEO2.blades;
  const rotorSeparationHz = expectedBpf * 0.025;

  return (
    <Panel title="STFT">
      <div className="btn-row">
        {STFT_PRESETS.map((p) => (
          <Button
            key={p.id}
            title={p.rationale}
            onClick={() =>
              setStftSettings((s) => ({
                ...s,
                fftSize: p.fftSize,
                winLength: p.fftSize,
                hop: p.hop,
                windowKind: p.windowKind,
              }))
            }
          >
            {p.label}
          </Button>
        ))}
      </div>

      <SelectField
        label="FFT size"
        value={stftSettings.fftSize}
        options={FFT_SIZES.map((n) => ({ value: n, label: String(n) }))}
        onChange={(v) =>
          setStftSettings((s) => ({
            ...s,
            fftSize: v,
            // Zero padding is deliberate rather than accidental: the window only
            // follows the transform when it was already equal to it.
            winLength: s.winLength === s.fftSize ? v : Math.min(s.winLength, v),
            hop: Math.min(s.hop, s.winLength === s.fftSize ? v : s.winLength),
          }))
        }
        hint={`${binHz.toFixed(2)} Hz per bin`}
      />

      <NumberField
        label="Window length"
        value={stftSettings.winLength}
        min={16}
        max={stftSettings.fftSize}
        step={16}
        onChange={(v) =>
          setStftSettings((s) => ({
            ...s,
            winLength: Math.min(v, s.fftSize),
            hop: Math.min(s.hop, Math.min(v, s.fftSize)),
          }))
        }
        hint={
          stftSettings.winLength < stftSettings.fftSize
            ? `Zero padded by ${stftSettings.fftSize - stftSettings.winLength} samples: more bins, no more resolution.`
            : `${windowMs.toFixed(1)} ms`
        }
      />

      <NumberField
        label="Hop"
        value={stftSettings.hop}
        min={1}
        max={stftSettings.winLength}
        step={16}
        onChange={(v) =>
          setStftSettings((s) => ({ ...s, hop: Math.min(v, s.winLength) }))
        }
        hint={`${(100 * (1 - stftSettings.hop / stftSettings.winLength)).toFixed(0)}% overlap, ${((stftSettings.hop / sampleRate) * 1000).toFixed(1)} ms per frame`}
      />

      <SelectField
        label="Window"
        value={stftSettings.windowKind}
        options={WINDOW_OPTIONS}
        onChange={(v) => setStftSettings((s) => ({ ...s, windowKind: v }))}
      />

      {stftSettings.windowKind === WindowKind.Kaiser ? (
        <NumberField
          label="Kaiser β"
          value={stftSettings.beta}
          min={0}
          max={20}
          step={0.2}
          onChange={(v) => setStftSettings((s) => ({ ...s, beta: v }))}
          hint="Higher β lowers sidelobes and widens the main lobe."
        />
      ) : null}

      <NumberField
        label="Floor (dB)"
        value={stftSettings.floorDb}
        min={-200}
        max={-20}
        step={5}
        onChange={(v) => setStftSettings((s) => ({ ...s, floorDb: v }))}
        hint="Values below this are clamped before display."
      />

      <div className="btn-row">
        <Button primary disabled={!audio} onClick={() => void runStft()}>
          Compute STFT
        </Button>
        {frames > 0 ? <Badge>{frames} frames</Badge> : <Badge tone="warn">no frames</Badge>}
      </div>

      {m ? (
        <Readout
          rows={[
            ["bin width", `${m.binHz.toFixed(3)} Hz`],
            ["window", `${m.windowMs.toFixed(2)} ms`],
            ["hop", `${m.hopMs.toFixed(2)} ms`],
            ["overlap", `${(m.overlap * 100).toFixed(0)} %`],
            ["frames × bins", `${stft!.frames} × ${stft!.bins}`],
            ["ENBW", `${m.enbwBins.toFixed(3)} bins / ${m.enbwHz.toFixed(2)} Hz`],
            ["coherent gain", m.coherentGain.toFixed(4)],
            ["scalloping loss", `${m.scallopDb.toFixed(2)} dB`],
            ["NENBW", m.nenbw.toFixed(4)],
            ["highest sidelobe", `${m.sidelobeDb.toFixed(1)} dB`],
            [
              "memory",
              `${((stft!.frames * stft!.bins * stft!.channels * 4) / 1e6).toFixed(1)} MB`,
            ],
          ]}
        />
      ) : null}

      <p className="panel-note">
        Rotors trimmed 2.5 % apart at {expectedBpf.toFixed(0)} Hz are{" "}
        {rotorSeparationHz.toFixed(1)} Hz apart. At {binHz.toFixed(1)} Hz per bin and an
        equivalent noise bandwidth of {m ? m.enbwHz.toFixed(1) : "—"} Hz they are{" "}
        {m && m.enbwHz < rotorSeparationHz ? "resolvable" : "not resolvable"}.
      </p>

      {environment ? (
        <p className="panel-note">
          Grating frequency {environment.geometry.gratingLongHz.toFixed(0)} Hz sits below
          the drone band, so no single harmonic determines a delay on its own.
        </p>
      ) : null}
    </Panel>
  );
}
