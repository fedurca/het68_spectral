/*
 * The six-channel spectrogram view.
 *
 * One WebGL canvas holds all six rows so the time axis and colour scale cannot drift
 * apart, with a 2D canvas over the top for anything vector-shaped: the frequency
 * cursor, band edges, the grating frequency, and the tracked f0 comb.
 *
 * Interaction follows what an audio editor does, because that is what the muscle
 * memory expects: wheel zooms time about the pointer, shift-wheel zooms frequency,
 * drag pans, and shift-drag selects a range for signature extraction.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { channelColour, type ColormapName } from "./colormap.js";
import {
  SpectrogramRenderer,
  type SpectrogramView,
} from "./spectrogram-gl.js";
import {
  clampRange,
  frequencyTicks,
  frequencyToUnit,
  timeTicks,
  unitToFrequency,
  type FrequencyScale,
} from "./scales.js";

export interface ChannelSpectrogram {
  label: string;
  db: Float32Array;
  frames: number;
  bins: number;
}

export interface SpectrogramCursor {
  channel: number;
  timeSec: number;
  freqHz: number;
  frame: number;
  bin: number;
  db: number;
}

export interface HorizontalLine {
  hz: number;
  colour: string;
  label?: string;
  dashed?: boolean;
}

export interface FrequencyTrack {
  channel: number;
  /** One frequency per frame; zero or non-finite means no lock in that frame. */
  values: ArrayLike<number>;
  colour: string;
  /** Draws the harmonics of the tracked value as well, up to this count. */
  harmonics?: number;
}

export interface AnnotationMark {
  id: string;
  startSec: number;
  endSec: number;
  label: string;
}

export interface SpectrogramViewState {
  frameFrom: number;
  frameTo: number;
  fLoHz: number;
  fHiHz: number;
  dbMin: number;
  dbMax: number;
  scale: FrequencyScale;
  colormap: ColormapName;
}

export function SpectrogramStack({
  channels,
  binHz,
  hopSec,
  sampleRate,
  view,
  onViewChange,
  rowHeight = 128,
  horizontalLines = [],
  tracks = [],
  annotations = [],
  selection,
  onSelectionChange,
  onCursor,
  onGpuBytes,
}: {
  channels: (ChannelSpectrogram | null)[];
  binHz: number;
  hopSec: number;
  sampleRate: number;
  view: SpectrogramViewState;
  onViewChange: (v: SpectrogramViewState) => void;
  rowHeight?: number;
  horizontalLines?: HorizontalLine[];
  tracks?: FrequencyTrack[];
  annotations?: AnnotationMark[];
  selection?: { startSec: number; endSec: number } | null;
  onSelectionChange?: (s: { startSec: number; endSec: number } | null) => void;
  onCursor?: (c: SpectrogramCursor | null) => void;
  onGpuBytes?: (bytes: number) => void;
}) {
  const glCanvas = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvas = useRef<HTMLCanvasElement | null>(null);
  const holder = useRef<HTMLDivElement | null>(null);
  const renderer = useRef<SpectrogramRenderer | null>(null);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<SpectrogramCursor | null>(null);
  const drag = useRef<
    | { kind: "pan"; startX: number; frameFrom: number; frameTo: number }
    | { kind: "select"; startSec: number }
    | null
  >(null);

  const rowCount = channels.length;
  const gap = 2;
  const totalHeight = rowCount * rowHeight + (rowCount - 1) * gap;
  const maxFrames = useMemo(
    () => channels.reduce((m, c) => Math.max(m, c?.frames ?? 0), 0),
    [channels],
  );

  useEffect(() => {
    const el = glCanvas.current;
    if (!el) return;
    try {
      renderer.current = new SpectrogramRenderer(el);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const el = holder.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Upload whenever a channel's data object changes identity, which happens once per
  // STFT run rather than per interaction.
  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    channels.forEach((c, i) => {
      if (c) r.setChannel(i, c.db, c.frames, c.bins);
    });
    onGpuBytes?.(r.gpuBytes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels]);

  const dpr = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, 2);

  useEffect(() => {
    const r = renderer.current;
    const el = glCanvas.current;
    if (!r || !el || width === 0) return;
    el.width = Math.max(1, Math.floor(width * dpr));
    el.height = Math.max(1, Math.floor(totalHeight * dpr));
    el.style.width = `${width}px`;
    el.style.height = `${totalHeight}px`;

    const glView: SpectrogramView = {
      frameFrom: view.frameFrom,
      frameTo: view.frameTo,
      fLoHz: view.fLoHz,
      fHiHz: view.fHiHz,
      dbMin: view.dbMin,
      dbMax: view.dbMax,
      scale: view.scale,
      colormap: view.colormap,
      binHz,
    };
    r.draw(glView, rowCount, gap * dpr);
  }, [width, totalHeight, view, binHz, rowCount, dpr, channels]);

  // ---- overlay ----------------------------------------------------------

  useEffect(() => {
    const el = overlayCanvas.current;
    if (!el || width === 0) return;
    el.width = Math.max(1, Math.floor(width * dpr));
    el.height = Math.max(1, Math.floor(totalHeight * dpr));
    el.style.width = `${width}px`;
    el.style.height = `${totalHeight}px`;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, totalHeight);

    const freqToY = (hz: number, row: number) => {
      const u = frequencyToUnit(hz, view.fLoHz, view.fHiHz, view.scale);
      const top = row * (rowHeight + gap);
      return top + (1 - u) * rowHeight;
    };
    const frameToX = (frame: number) =>
      ((frame - view.frameFrom) / Math.max(1, view.frameTo - view.frameFrom)) * width;

    ctx.font = "10px ui-monospace, monospace";
    ctx.lineWidth = 1;

    for (let row = 0; row < rowCount; row++) {
      for (const line of horizontalLines) {
        if (line.hz < view.fLoHz || line.hz > view.fHiHz) continue;
        const y = Math.round(freqToY(line.hz, row)) + 0.5;
        ctx.save();
        ctx.strokeStyle = line.colour;
        ctx.setLineDash(line.dashed === false ? [] : [5, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        if (line.label && row === 0) {
          ctx.setLineDash([]);
          ctx.fillStyle = line.colour;
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.fillText(line.label, 4, y - 2);
        }
        ctx.restore();
      }
    }

    for (const track of tracks) {
      if (track.channel >= rowCount) continue;
      const harmonics = track.harmonics ?? 1;
      for (let h = 1; h <= harmonics; h++) {
        ctx.strokeStyle = track.colour;
        ctx.globalAlpha = h === 1 ? 0.95 : 0.35;
        ctx.lineWidth = h === 1 ? 1.5 : 1;
        ctx.beginPath();
        let drawing = false;
        const n = track.values.length;
        // One line segment per pixel column at most; a long recording has far more
        // frames than columns and stroking every one costs time for nothing.
        const step = Math.max(1, Math.floor((view.frameTo - view.frameFrom) / Math.max(width, 1)));
        for (let f = Math.max(0, view.frameFrom); f < Math.min(n, view.frameTo); f += step) {
          const hz = track.values[f]! * h;
          if (!Number.isFinite(hz) || hz <= 0 || hz < view.fLoHz || hz > view.fHiHz) {
            drawing = false;
            continue;
          }
          const x = frameToX(f);
          const y = freqToY(hz, track.channel);
          if (!drawing) {
            ctx.moveTo(x, y);
            drawing = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    if (selection) {
      const a = frameToX(selection.startSec / hopSec);
      const b = frameToX(selection.endSec / hopSec);
      ctx.fillStyle = "rgba(31,191,160,0.14)";
      ctx.fillRect(Math.min(a, b), 0, Math.abs(b - a), totalHeight);
      ctx.strokeStyle = "#1fbfa0";
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(Math.round(a) + 0.5, 0);
      ctx.lineTo(Math.round(a) + 0.5, totalHeight);
      ctx.moveTo(Math.round(b) + 0.5, 0);
      ctx.lineTo(Math.round(b) + 0.5, totalHeight);
      ctx.stroke();
    }

    if (cursor) {
      const x = Math.round(frameToX(cursor.frame)) + 0.5;
      ctx.strokeStyle = "rgba(243,246,248,0.75)";
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, totalHeight);
      ctx.stroke();

      const y = Math.round(freqToY(cursor.freqHz, cursor.channel)) + 0.5;
      ctx.strokeStyle = "rgba(243,246,248,0.45)";
      const top = cursor.channel * (rowHeight + gap);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      void top;
    }
  }, [
    width,
    totalHeight,
    view,
    horizontalLines,
    tracks,
    selection,
    cursor,
    rowCount,
    rowHeight,
    hopSec,
    dpr,
  ]);

  // ---- interaction ------------------------------------------------------

  const locate = useCallback(
    (clientX: number, clientY: number): SpectrogramCursor | null => {
      const el = holder.current;
      if (!el || width === 0) return null;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (x < 0 || x > rect.width) return null;

      const row = Math.min(rowCount - 1, Math.max(0, Math.floor(y / (rowHeight + gap))));
      const withinRow = y - row * (rowHeight + gap);
      if (withinRow < 0 || withinRow > rowHeight) return null;

      const u = x / rect.width;
      const frame = Math.round(view.frameFrom + u * (view.frameTo - view.frameFrom));
      const v = 1 - withinRow / rowHeight;
      const freqHz = unitToFrequency(v, view.fLoHz, view.fHiHz, view.scale);
      const bin = Math.round(freqHz / binHz);

      const data = channels[row];
      let db = Number.NaN;
      if (data && frame >= 0 && frame < data.frames && bin >= 0 && bin < data.bins) {
        db = data.db[frame * data.bins + bin]!;
      }
      return { channel: row, timeSec: frame * hopSec, freqHz, frame, bin, db };
    },
    [width, view, rowCount, rowHeight, binHz, hopSec, channels],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const el = holder.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(e.deltaY * 0.002);

      if (e.shiftKey) {
        // Frequency zoom about the pointer, so the harmonic under the cursor stays
        // under the cursor.
        const row = Math.min(
          rowCount - 1,
          Math.max(0, Math.floor((e.clientY - rect.top) / (rowHeight + gap))),
        );
        const withinRow = e.clientY - rect.top - row * (rowHeight + gap);
        const v = 1 - Math.max(0, Math.min(1, withinRow / rowHeight));
        const anchor = unitToFrequency(v, view.fLoHz, view.fHiHz, view.scale);
        const lo = anchor - (anchor - view.fLoHz) * factor;
        const hi = anchor + (view.fHiHz - anchor) * factor;
        const nyquist = sampleRate / 2;
        const [fLo, fHi] = clampRange(
          Math.max(0, lo),
          Math.min(nyquist, hi),
          0,
          nyquist,
          binHz * 8,
        );
        onViewChange({ ...view, fLoHz: fLo, fHiHz: fHi });
        return;
      }

      const u = (e.clientX - rect.left) / rect.width;
      const anchorFrame = view.frameFrom + u * (view.frameTo - view.frameFrom);
      const from = anchorFrame - (anchorFrame - view.frameFrom) * factor;
      const to = anchorFrame + (view.frameTo - anchorFrame) * factor;
      const [f0, f1] = clampRange(from, to, 0, maxFrames, 16);
      onViewChange({ ...view, frameFrom: f0, frameTo: f1 });
    },
    [view, onViewChange, rowCount, rowHeight, maxFrames, binHz, sampleRate],
  );

  return (
    <div className="canvas-stack">
      {error ? (
        <div className="finding" data-severity="error">
          {error}
        </div>
      ) : null}

      <div className="canvas-row">
        <div className="axis-y" style={{ height: totalHeight }}>
          {Array.from({ length: rowCount }, (_, row) =>
            frequencyTicks(view.fLoHz, view.fHiHz, view.scale, 5).map((t) => (
              <span
                key={`${row}-${t.value}`}
                style={{ top: row * (rowHeight + gap) + (1 - t.unit) * rowHeight }}
              >
                {t.label}
              </span>
            )),
          )}
        </div>

        <div
          className="canvas-holder"
          ref={holder}
          style={{ height: totalHeight }}
          onWheel={handleWheel}
          onMouseDown={(e) => {
            const c = locate(e.clientX, e.clientY);
            if (e.shiftKey && c) {
              drag.current = { kind: "select", startSec: c.timeSec };
              onSelectionChange?.({ startSec: c.timeSec, endSec: c.timeSec });
            } else {
              drag.current = {
                kind: "pan",
                startX: e.clientX,
                frameFrom: view.frameFrom,
                frameTo: view.frameTo,
              };
            }
          }}
          onMouseMove={(e) => {
            const d = drag.current;
            if (d?.kind === "pan") {
              const rect = e.currentTarget.getBoundingClientRect();
              const perPx = (d.frameTo - d.frameFrom) / rect.width;
              const shift = (d.startX - e.clientX) * perPx;
              const [f0, f1] = clampRange(
                d.frameFrom + shift,
                d.frameTo + shift,
                0,
                maxFrames,
                16,
              );
              onViewChange({ ...view, frameFrom: f0, frameTo: f1 });
              return;
            }
            const c = locate(e.clientX, e.clientY);
            setCursor(c);
            onCursor?.(c);
            if (d?.kind === "select" && c) {
              onSelectionChange?.({
                startSec: Math.min(d.startSec, c.timeSec),
                endSec: Math.max(d.startSec, c.timeSec),
              });
            }
          }}
          onMouseUp={() => {
            drag.current = null;
          }}
          onMouseLeave={() => {
            drag.current = null;
            setCursor(null);
            onCursor?.(null);
          }}
          onDoubleClick={() => onViewChange({ ...view, frameFrom: 0, frameTo: maxFrames })}
        >
          <canvas ref={glCanvas} />
          <canvas
            ref={overlayCanvas}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          />
          {channels.map((c, i) => (
            <span
              key={i}
              className="canvas-label"
              style={{ top: i * (rowHeight + gap) + 2, color: channelColour(i) }}
            >
              {c ? c.label : `${i + 1} (no data)`}
            </span>
          ))}
        </div>
      </div>

      <div className="axis-x">
        <div />
        <div className="ticks">
          {timeTicks(view.frameFrom * hopSec, view.frameTo * hopSec, 10).map((t) => (
            <span key={t.value} style={{ left: `${t.unit * 100}%` }}>
              {t.label}
            </span>
          ))}
        </div>
      </div>

      {annotations.length > 0 ? (
        <div className="annotation-strip">
          {annotations.map((a) => {
            const from = a.startSec / hopSec;
            const to = a.endSec / hopSec;
            const span = Math.max(1, view.frameTo - view.frameFrom);
            const left = ((from - view.frameFrom) / span) * 100;
            const wPct = ((to - from) / span) * 100;
            if (left > 100 || left + wPct < 0) return null;
            return (
              <div
                key={a.id}
                className="ann"
                style={{ left: `${left}%`, width: `${Math.max(wPct, 0.3)}%` }}
                title={`${a.label} (${a.startSec.toFixed(2)}–${a.endSec.toFixed(2)} s)`}
              >
                {a.label}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
