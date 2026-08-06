/*
 * Where the audio comes from: a recording, an annotation file, or the synthetic scene
 * generator.
 *
 * The generator is not a convenience. There are no recordings of the aircraft yet, so
 * it is the only source of data with known truth, and it is what the whole chain is
 * validated against before the first flight: whether GCC-PHAT returns the azimuth it
 * was given, whether aliasing appears where the theory says it must, and whether the
 * comb tracker holds f0 through a throttle ramp.
 */

import { useRef, useState } from "react";
import { NEO2, type SynthParams } from "@het68/dsp-core";
import { Button, NumberField, Panel, Toggle } from "@het68/ui";
import type { Analyzer } from "../state/analyzer.js";

interface SceneSettings {
  durationSec: number;
  azDeg: number;
  elDeg: number;
  distanceM: number;
  rpm: number;
  rpmSpreadPct: number;
  rpmRampPct: number;
  windLevelDb: number;
  backgroundLevelDb: number;
  toneHz: number;
  toneLevelDb: number;
  seed: number;
  airAbsorption: boolean;
}

const DEFAULT_SCENE: SceneSettings = {
  durationSec: 6,
  azDeg: 37,
  elDeg: 18,
  distanceM: 25,
  // Middle of the range the thrust estimate gives for a hovering Neo 2.
  rpm: 27000,
  rpmSpreadPct: 2.5,
  rpmRampPct: 0,
  windLevelDb: -60,
  backgroundLevelDb: -70,
  toneHz: 0,
  toneLevelDb: -20,
  seed: 1,
  airAbsorption: true,
};

export function SourcePanel({ analyzer }: { analyzer: Analyzer }) {
  const wavInput = useRef<HTMLInputElement | null>(null);
  const annInput = useRef<HTMLInputElement | null>(null);
  const [scene, setScene] = useState(DEFAULT_SCENE);
  const [dragging, setDragging] = useState(false);

  const {
    audio,
    loadWavFile,
    loadAnnotationFile,
    generateScene,
    edgeMm,
    tempC,
    humidityPct,
    pressurePa,
    annotations,
  } = analyzer;

  const set = <K extends keyof SceneSettings>(key: K, value: SceneSettings[K]) =>
    setScene((s) => ({ ...s, [key]: value }));

  const buildParams = (): SynthParams => {
    const sampleRate = 48000;
    const nSamples = Math.round(scene.durationSec * sampleRate);
    // Four rotors spread symmetrically about the nominal rate. Equal rates would
    // remove the beating between combs, which is the most distinctive thing a
    // multirotor does and the thing the tracker has to cope with.
    const spread = scene.rpm * (scene.rpmSpreadPct / 100);
    const rpm = [
      scene.rpm - spread / 2,
      scene.rpm - spread / 6,
      scene.rpm + spread / 6,
      scene.rpm + spread / 2,
    ];
    return {
      sampleRate,
      nSamples,
      edgeMm,
      tempC,
      humidityPct,
      pressurePa,
      airAbsorption: scene.airAbsorption,
      azDeg: scene.azDeg,
      elDeg: scene.elDeg,
      distanceM: scene.distanceM,
      rpm,
      nRotors: 4,
      blades: NEO2.blades,
      rpmJitterPct: 0.4,
      rpmRampPct: scene.rpmRampPct,
      nHarmonics: NEO2.nHarmonics,
      harmonicRolloffDb: 6,
      tonalLevelDb: -24,
      broadbandLevelDb: -34,
      broadbandLoHz: 900,
      broadbandHiHz: 9000,
      windLevelDb: scene.windLevelDb,
      windCutoffHz: 250,
      backgroundLevelDb: scene.backgroundLevelDb,
      toneHz: scene.toneHz,
      toneLevelDb: scene.toneLevelDb,
      seed: scene.seed,
    };
  };

  return (
    <>
      <Panel
        title="Source"
        note={
          audio?.warnings.length
            ? `${audio.warnings.length} warning(s) about this file — see the debug tab.`
            : undefined
        }
      >
        <div
          className="dropzone"
          data-active={dragging}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const files = Array.from(e.dataTransfer.files);
            for (const f of files) {
              if (/\.wav$/i.test(f.name)) void loadWavFile(f);
              else if (/\.(txt|labels|log|csv)$/i.test(f.name)) void loadAnnotationFile(f);
            }
          }}
        >
          Drop a 6-channel WAV here, or an annotation file with one event per line.
        </div>

        <div className="btn-row">
          <Button primary onClick={() => wavInput.current?.click()}>
            Open WAV
          </Button>
          <Button onClick={() => annInput.current?.click()}>
            Annotations{annotations.length > 0 ? ` (${annotations.length})` : ""}
          </Button>
        </div>

        <input
          ref={wavInput}
          type="file"
          accept=".wav,audio/wav"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadWavFile(f);
            e.target.value = "";
          }}
        />
        <input
          ref={annInput}
          type="file"
          accept=".txt,.labels,.log,.csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadAnnotationFile(f);
            e.target.value = "";
          }}
        />
      </Panel>

      <Panel
        title="Synthetic scene"
        note="Four rotors on independent speeds, propagated to the six microphones from the exact geometry. The only source of known truth until real recordings exist."
      >
        <NumberField
          label="Duration (s)"
          value={scene.durationSec}
          min={0.5}
          max={120}
          step={0.5}
          onChange={(v) => set("durationSec", v)}
        />
        <NumberField
          label="Azimuth (deg)"
          value={scene.azDeg}
          step={1}
          onChange={(v) => set("azDeg", v)}
          hint="0 is microphone 1, increasing anticlockwise."
        />
        <NumberField
          label="Elevation (deg)"
          value={scene.elDeg}
          min={-90}
          max={90}
          step={1}
          onChange={(v) => set("elDeg", v)}
        />
        <NumberField
          label="Distance (m)"
          value={scene.distanceM}
          min={1}
          max={300}
          step={1}
          onChange={(v) => set("distanceM", v)}
        />
        <NumberField
          label="Rotor speed (rpm)"
          value={scene.rpm}
          min={5000}
          max={45000}
          step={500}
          onChange={(v) => set("rpm", v)}
          hint={`Blade pass = rpm/60 × ${NEO2.blades} → ${((scene.rpm / 60) * NEO2.blades).toFixed(0)} Hz`}
        />
        <NumberField
          label="Rotor spread (%)"
          value={scene.rpmSpreadPct}
          min={0}
          max={20}
          step={0.5}
          onChange={(v) => set("rpmSpreadPct", v)}
          hint="How far apart the four rotors run. Around 10 Hz of separation needs 4096 or more."
        />
        <NumberField
          label="Speed ramp (%)"
          value={scene.rpmRampPct}
          min={-50}
          max={50}
          step={1}
          onChange={(v) => set("rpmRampPct", v)}
          hint="Sweeps the speed across the take, for testing whether the tracker holds through a manoeuvre."
        />
        <NumberField
          label="Wind level (dBFS)"
          value={scene.windLevelDb}
          min={-120}
          max={0}
          step={1}
          onChange={(v) => set("windLevelDb", v)}
        />
        <NumberField
          label="Background (dBFS)"
          value={scene.backgroundLevelDb}
          min={-120}
          max={0}
          step={1}
          onChange={(v) => set("backgroundLevelDb", v)}
        />
        <NumberField
          label="Pure tone (Hz)"
          value={scene.toneHz}
          min={0}
          max={20000}
          step={100}
          onChange={(v) => set("toneHz", v)}
          hint="Set 3000 to reproduce grating lobes: a single tone above c/(2·edge) admits several delays."
        />
        <NumberField
          label="Seed"
          value={scene.seed}
          min={0}
          step={1}
          onChange={(v) => set("seed", v)}
          hint="Same seed, same noise, byte for byte."
        />
        <Toggle
          label="Air absorption"
          checked={scene.airAbsorption}
          onChange={(v) => set("airAbsorption", v)}
        />

        <div className="btn-row">
          <Button
            primary
            onClick={() =>
              void generateScene(
                buildParams(),
                `synth az=${scene.azDeg} el=${scene.elDeg} d=${scene.distanceM}m rpm=${scene.rpm}`,
              )
            }
          >
            Generate
          </Button>
          <Button
            title="A single 3 kHz tone from a known direction, which is the cleanest way to see grating lobes."
            onClick={() => {
              const params = buildParams();
              void generateScene(
                {
                  ...params,
                  tonalLevelDb: -200,
                  broadbandLevelDb: -200,
                  windLevelDb: -200,
                  backgroundLevelDb: -90,
                  toneHz: 3000,
                  toneLevelDb: -12,
                },
                `synth 3 kHz tone az=${scene.azDeg} el=${scene.elDeg}`,
              );
            }}
          >
            Aliasing test
          </Button>
        </div>
      </Panel>
    </>
  );
}
