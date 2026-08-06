/*
 * Cube geometry and the medium.
 *
 * Edge length is an input, not a constant, and everything downstream moves with it:
 * the maximum lag the firmware would allow, the angular resolution, and the grating
 * frequency that decides whether a single harmonic can be located at all. At the
 * chosen 384 mm the grating frequency is 447 Hz on the long baseline and about
 * 632 Hz on the short ones, so the entire drone band from 800 Hz up is aliased. That
 * is not a defect to be fixed but a fact the analysis has to work around, which is
 * why these numbers are on screen rather than buried in a constant.
 */

import { NumberField, Panel, Readout } from "@het68/ui";
import type { Analyzer } from "../state/analyzer.js";

export function GeometryPanel({ analyzer }: { analyzer: Analyzer }) {
  const {
    edgeMm,
    setEdgeMm,
    tempC,
    setTempC,
    humidityPct,
    setHumidityPct,
    pressurePa,
    setPressurePa,
    environment,
  } = analyzer;

  const g = environment?.geometry;

  return (
    <Panel title="Cube and medium">
      <NumberField
        label="Edge (mm)"
        value={edgeMm}
        min={100}
        max={800}
        step={1}
        onChange={setEdgeMm}
        hint="Measured, not nominal. 384 mm is the chosen default; 350–400 is the design range."
      />
      <NumberField
        label="Temperature (°C)"
        value={tempC}
        min={-40}
        max={50}
        step={0.5}
        onChange={setTempC}
      />
      <NumberField
        label="Humidity (%)"
        value={humidityPct}
        min={0}
        max={100}
        step={1}
        onChange={setHumidityPct}
      />
      <NumberField
        label="Pressure (Pa)"
        value={pressurePa}
        min={80000}
        max={110000}
        step={100}
        onChange={setPressurePa}
      />

      {g ? (
        <Readout
          rows={[
            ["sound speed", `${g.soundSpeed.toFixed(2)} m/s`],
            ["long baseline", `${g.longBaselineMm.toFixed(1)} mm`],
            ["short baseline", `${g.shortBaselineMm.toFixed(1)} mm`],
            ["grating, long", `${g.gratingLongHz.toFixed(0)} Hz`],
            ["grating, short", `${g.gratingShortHz.toFixed(0)} Hz`],
            ["angular resolution", `${g.angularResolutionDeg.toFixed(2)}°`],
            ["lag quantum", `${g.lagQuantumMm.toFixed(2)} mm`],
            ["firmware maxlag", `${g.firmwareMaxLag} samples`],
            ["firmware span", `${g.firmwareSpan} samples`],
            [
              "span duration",
              `${((g.firmwareSpan / g.sampleRate) * 1000).toFixed(2)} ms`,
            ],
            ["far field at 6 kHz", `${g.farField6kHzM.toFixed(1)} m`],
          ]}
        />
      ) : (
        <p className="panel-note">Waiting for the DSP core.</p>
      )}

      {environment ? (
        <>
          <p className="panel-note">
            Air absorption, which sets how much of the top of the band survives to
            range:
          </p>
          <Readout
            rows={environment.absorptionDbPerM.map((a) => [
              `${(a.freqHz / 1000).toFixed(1)} kHz`,
              `${a.dbPerM.toFixed(3)} dB/m → ${(a.dbPerM * 100).toFixed(1)} dB at 100 m`,
            ])}
          />
        </>
      ) : null}
    </Panel>
  );
}
