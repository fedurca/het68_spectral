/*
 * Where a 2 kHz tone is, relative to the microphones.
 *
 * Chromium's getUserMedia downmixes the six-channel sound card to stereo, so a
 * live browser capture can only place the tone on a left/right axis. Six
 * channels (a WAV, or the desktop ALSA capture) name the nearest microphone
 * and, on the nominal cube, an energy-weighted azimuth.
 */

import { useMemo, useState } from "react";
import { Badge, Empty, NumberField, Panel, Readout } from "@het68/ui";
import { locateTone, type ToneFix } from "@het68/io";
import type { Analyzer } from "../state/analyzer.js";

function polar(cx: number, cy: number, r: number, azDeg: number): { x: number; y: number } {
  const rad = (azDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

function PositionPlot({ fix }: { fix: ToneFix }) {
  const cx = 180;
  const cy = 150;
  const r = 108;
  const maxMag = Math.max(...fix.levels.map((l) => l.magnitude), 1e-9);

  if (fix.mode === "stereo" && fix.stereoPan != null) {
    const x = 40 + ((fix.stereoPan + 1) / 2) * 280;
    return (
      <svg viewBox="0 0 360 220" role="img" aria-label="Stereo position of the tone">
        <line x1="40" y1="120" x2="320" y2="120" stroke="currentColor" strokeOpacity="0.35" />
        <text x="40" y="150" fontSize="12">
          ch1
        </text>
        <text x="292" y="150" fontSize="12">
          ch2
        </text>
        <circle cx={x} cy="120" r="10" fill="currentColor" />
      </svg>
    );
  }

  const n = Math.min(fix.levels.length, 6);
  return (
    <svg viewBox="0 0 360 300" role="img" aria-label="Nearest microphone for the tone">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" />
      {fix.nominalAzDeg != null ? (
        <line
          x1={cx}
          y1={cy}
          x2={polar(cx, cy, r * 0.92, fix.nominalAzDeg).x}
          y2={polar(cx, cy, r * 0.92, fix.nominalAzDeg).y}
          stroke="currentColor"
          strokeOpacity="0.45"
          strokeDasharray="4 3"
        />
      ) : null}
      {fix.levels.slice(0, n).map((level) => {
        const az = (360 / n) * (level.channel - 1) - 90;
        const p = polar(cx, cy, r * 0.78, az);
        const dot = 6 + 16 * (level.magnitude / maxMag);
        const hot = level.channel === fix.loudest;
        return (
          <g key={level.channel}>
            <circle cx={p.x} cy={p.y} r={dot} fill="currentColor" opacity={hot ? 1 : 0.35} />
            <text x={p.x + dot + 4} y={p.y + 4} fontSize="12">
              M{level.channel}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function TonePositionTab({ analyzer }: { analyzer: Analyzer }) {
  const { audio } = analyzer;
  const [toneHz, setToneHz] = useState(2000);

  const fix = useMemo<ToneFix | null>(() => {
    if (!audio) return null;
    return locateTone({
      planar: audio.planar,
      channels: audio.channels,
      frames: audio.frames,
      sampleRate: audio.sampleRate,
      toneHz,
    });
  }, [audio, toneHz]);

  if (!audio || !fix) {
    return (
      <Empty>
        Load a WAV or take a live snapshot first. This view looks for a tone near 2000 Hz.
      </Empty>
    );
  }

  const rows: [string, string][] = [
    ["channels in this buffer", String(fix.channels)],
    ["loudest window", "0.5 s with the strongest tone"],
    ["tone", `${fix.toneHz.toFixed(0)} Hz`],
    ["loudest mic", fix.loudest == null ? "none" : `M${fix.loudest}`],
    ["dominance", `${fix.dominanceDb.toFixed(1)} dB above median`],
  ];
  if (fix.nominalAzDeg != null) {
    rows.push(["nominal cube azimuth", `${fix.nominalAzDeg.toFixed(0)}° (only if mics are on the cube)`]);
  }
  if (fix.stereoPan != null && fix.channels < 6) {
    rows.push(["stereo pan", `${fix.stereoPan.toFixed(2)} (−1 ch1, +1 ch2)`]);
  }

  return (
    <div className="stack">
      {fix.channels < 6 ? (
        <div className="finding" data-severity="warn">
          <strong>Only {fix.channels} channels.</strong>
          <span>
            Chromium downmixes this six-channel sound card to stereo, so this plot is a
            left/right axis, not a position on the cube. A six-channel WAV, or the desktop
            build capturing ALSA directly, keeps M1–M6 separate.
          </span>
        </div>
      ) : (
        <div className="finding">
          <strong>Nearest microphone, not a surveyed point.</strong>
          <span>
            2000 Hz is above the cube grating frequency, and a scattered bench array does
            not match the 384 mm model. The filled dot is the mic that hears the tone.
            The dashed ray is an energy-weighted azimuth on the nominal cube.
          </span>
        </div>
      )}

      <Panel title="2 kHz source">
        <NumberField
          label="Tone (Hz)"
          value={toneHz}
          min={100}
          max={12000}
          step={10}
          onChange={setToneHz}
          hint="Drone band is about 800 Hz–6 kHz. 2000 Hz is the test tone."
        />
        <Badge tone={fix.mode === "silent" ? "warn" : "ok"}>
          {fix.mode === "silent"
            ? "no tone"
            : fix.loudest == null
              ? "no tone"
              : `nearest M${fix.loudest}`}
        </Badge>
        <PositionPlot fix={fix} />
        <Readout rows={rows} />
      </Panel>
    </div>
  );
}
