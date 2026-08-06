/*
 * Canvas 2D plots for everything that is not the spectrogram: band energy over time,
 * pair delays, coherence, the lag-by-time surface, cepstra, match scores.
 *
 * These are drawn rather than assembled from SVG elements because several of them
 * carry one point per STFT frame, and a few thousand DOM nodes per plot makes the
 * page unusable long before the data gets interesting.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { colormapLut, type ColormapName } from "./colormap.js";

export interface Series {
  label: string;
  colour: string;
  /** One value per x step. NaN and non-finite values break the line rather than being drawn at zero. */
  data: ArrayLike<number>;
  xFrom?: number;
  xStep?: number;
  dashed?: boolean;
  width?: number;
}

export interface Marker {
  /** Horizontal rule at this y value. */
  y?: number;
  /** Vertical rule at this x value. */
  x?: number;
  label?: string;
  colour?: string;
  dashed?: boolean;
}

function useDevicePixelCanvas(
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  deps: unknown[],
  height: number,
) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => setWidth(parent.clientWidth));
    ro.observe(parent);
    setWidth(parent.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || width === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = Math.max(1, Math.floor(width * dpr));
    el.height = Math.max(1, Math.floor(height * dpr));
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    draw(ctx, width, height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, ...deps]);

  return { ref, width };
}

const PAD = { left: 52, right: 8, top: 8, bottom: 20 };

function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

export function LinePlot({
  series,
  height = 130,
  xLabel,
  yLabel,
  yMin,
  yMax,
  xMin,
  xMax,
  markers = [],
  cursorX,
  selection,
  onHover,
  onClick,
  logY = false,
  fmtY = (v: number) => v.toFixed(1),
  fmtX = (v: number) => v.toFixed(2),
}: {
  series: Series[];
  height?: number;
  xLabel?: string;
  yLabel?: string;
  yMin?: number;
  yMax?: number;
  xMin?: number;
  xMax?: number;
  markers?: Marker[];
  cursorX?: number | null;
  selection?: { from: number; to: number } | null;
  onHover?: (x: number | null) => void;
  onClick?: (x: number) => void;
  logY?: boolean;
  fmtY?: (v: number) => string;
  fmtX?: (v: number) => string;
}) {
  const bounds = (() => {
    let x0 = xMin ?? Infinity;
    let x1 = xMax ?? -Infinity;
    let y0 = yMin ?? Infinity;
    let y1 = yMax ?? -Infinity;
    for (const s of series) {
      const from = s.xFrom ?? 0;
      const step = s.xStep ?? 1;
      if (xMin === undefined) x0 = Math.min(x0, from);
      if (xMax === undefined) x1 = Math.max(x1, from + step * Math.max(s.data.length - 1, 0));
      if (yMin === undefined || yMax === undefined) {
        for (let i = 0; i < s.data.length; i++) {
          const v = s.data[i]!;
          if (!Number.isFinite(v)) continue;
          if (yMin === undefined) y0 = Math.min(y0, v);
          if (yMax === undefined) y1 = Math.max(y1, v);
        }
      }
    }
    for (const m of markers) {
      if (m.y !== undefined && yMax === undefined) y1 = Math.max(y1, m.y);
      if (m.y !== undefined && yMin === undefined) y0 = Math.min(y0, m.y);
    }
    if (!Number.isFinite(x0)) x0 = 0;
    if (!Number.isFinite(x1) || x1 <= x0) x1 = x0 + 1;
    if (!Number.isFinite(y0)) y0 = 0;
    if (!Number.isFinite(y1) || y1 <= y0) y1 = y0 + 1;
    const padY = (y1 - y0) * 0.06;
    return {
      x0,
      x1,
      y0: yMin ?? y0 - padY,
      y1: yMax ?? y1 + padY,
    };
  })();

  const { ref } = useDevicePixelCanvas(
    (ctx, w, h) => {
      const plotW = w - PAD.left - PAD.right;
      const plotH = h - PAD.top - PAD.bottom;
      if (plotW <= 0 || plotH <= 0) return;

      const toX = (v: number) =>
        PAD.left + ((v - bounds.x0) / (bounds.x1 - bounds.x0)) * plotW;
      const toY = (v: number) => {
        if (logY) {
          const lo = Math.log10(Math.max(bounds.y0, 1e-6));
          const hi = Math.log10(Math.max(bounds.y1, 1e-5));
          const t = (Math.log10(Math.max(v, 1e-6)) - lo) / (hi - lo);
          return PAD.top + (1 - t) * plotH;
        }
        return (
          PAD.top + (1 - (v - bounds.y0) / (bounds.y1 - bounds.y0)) * plotH
        );
      };

      const style = getComputedStyle(document.documentElement);
      const line = style.getPropertyValue("--line").trim() || "rgba(148,163,184,0.14)";
      const dim = style.getPropertyValue("--dim").trim() || "#6b7a89";
      const text = style.getPropertyValue("--muted").trim() || "#9aa8b5";

      ctx.font = "10px ui-monospace, monospace";
      ctx.strokeStyle = line;
      ctx.fillStyle = text;
      ctx.lineWidth = 1;

      for (const v of niceTicks(bounds.y0, bounds.y1)) {
        const y = Math.round(toY(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(w - PAD.right, y);
        ctx.stroke();
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(fmtY(v), PAD.left - 4, y);
      }

      for (const v of niceTicks(bounds.x0, bounds.x1, 6)) {
        const x = Math.round(toX(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, h - PAD.bottom);
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(fmtX(v), x, h - PAD.bottom + 3);
      }

      if (yLabel) {
        ctx.save();
        ctx.translate(10, PAD.top + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = dim;
        ctx.fillText(yLabel, 0, 0);
        ctx.restore();
      }
      if (xLabel) {
        ctx.fillStyle = dim;
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillText(xLabel, w - PAD.right, h - 2);
      }

      if (selection && selection.to > selection.from) {
        ctx.fillStyle = "rgba(31, 191, 160, 0.14)";
        const a = toX(selection.from);
        const b = toX(selection.to);
        ctx.fillRect(a, PAD.top, b - a, plotH);
      }

      for (const m of markers) {
        ctx.save();
        ctx.strokeStyle = m.colour ?? "#f59e0b";
        ctx.setLineDash(m.dashed === false ? [] : [4, 3]);
        ctx.beginPath();
        if (m.y !== undefined) {
          const y = toY(m.y);
          ctx.moveTo(PAD.left, y);
          ctx.lineTo(w - PAD.right, y);
        }
        if (m.x !== undefined) {
          const x = toX(m.x);
          ctx.moveTo(x, PAD.top);
          ctx.lineTo(x, h - PAD.bottom);
        }
        ctx.stroke();
        if (m.label) {
          ctx.fillStyle = m.colour ?? "#f59e0b";
          ctx.setLineDash([]);
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          const lx = m.x !== undefined ? toX(m.x) + 3 : PAD.left + 3;
          const ly = m.y !== undefined ? toY(m.y) - 2 : PAD.top + 10;
          ctx.fillText(m.label, lx, ly);
        }
        ctx.restore();
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.left, PAD.top, plotW, plotH);
      ctx.clip();
      for (const s of series) {
        const from = s.xFrom ?? 0;
        const step = s.xStep ?? 1;
        ctx.strokeStyle = s.colour;
        ctx.lineWidth = s.width ?? 1.25;
        ctx.setLineDash(s.dashed ? [4, 3] : []);
        ctx.beginPath();
        let drawing = false;
        // At more points than pixels, several samples share a column. Drawing all of
        // them is wasted work but drawing only every nth would hide a single-frame
        // spike, so the min and max of each column are both stroked.
        const perPixel = s.data.length / Math.max(plotW, 1);
        if (perPixel > 2) {
          for (let px = 0; px < plotW; px++) {
            const i0 = Math.floor((px * s.data.length) / plotW);
            const i1 = Math.min(s.data.length, Math.floor(((px + 1) * s.data.length) / plotW));
            let lo = Infinity;
            let hi = -Infinity;
            for (let i = i0; i < i1; i++) {
              const v = s.data[i]!;
              if (!Number.isFinite(v)) continue;
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
            if (!Number.isFinite(lo)) {
              drawing = false;
              continue;
            }
            const x = PAD.left + px + 0.5;
            if (!drawing) {
              ctx.moveTo(x, toY(hi));
              drawing = true;
            }
            ctx.lineTo(x, toY(hi));
            ctx.lineTo(x, toY(lo));
          }
        } else {
          for (let i = 0; i < s.data.length; i++) {
            const v = s.data[i]!;
            if (!Number.isFinite(v)) {
              drawing = false;
              continue;
            }
            const x = toX(from + i * step);
            const y = toY(v);
            if (!drawing) {
              ctx.moveTo(x, y);
              drawing = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
        }
        ctx.stroke();
      }
      ctx.restore();

      if (cursorX !== null && cursorX !== undefined) {
        ctx.strokeStyle = "rgba(243,246,248,0.7)";
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        const x = Math.round(toX(cursorX)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, h - PAD.bottom);
        ctx.stroke();
      }
    },
    [series, bounds.x0, bounds.x1, bounds.y0, bounds.y1, markers, cursorX, selection, logY],
    height,
  );

  const toValue = (clientX: number, el: HTMLCanvasElement) => {
    const rect = el.getBoundingClientRect();
    const plotW = rect.width - PAD.left - PAD.right;
    const u = (clientX - rect.left - PAD.left) / plotW;
    return bounds.x0 + Math.max(0, Math.min(1, u)) * (bounds.x1 - bounds.x0);
  };

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <canvas
        ref={ref}
        onMouseMove={(e) => onHover?.(toValue(e.clientX, e.currentTarget))}
        onMouseLeave={() => onHover?.(null)}
        onClick={(e) => onClick?.(toValue(e.clientX, e.currentTarget))}
        style={{ display: "block", cursor: onClick ? "crosshair" : "default" }}
      />
      {series.length > 1 ? (
        <div className="legend" style={{ padding: "0 0 0 52px" }}>
          {series.map((s) => (
            <span key={s.label}>
              <span className="swatch" style={{ background: s.colour }} />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A columns-by-rows matrix as an image. Used for the lag-by-time surface, which is
 * where a delay hopping between grating lobes becomes obvious, and for coherence
 * against frequency.
 */
export function Heatmap({
  data,
  columns,
  rows,
  height = 200,
  colormap = "viridis",
  vMin,
  vMax,
  yTicks = [],
  xTicks = [],
  overlay,
  cursorX,
  onHover,
  onClick,
}: {
  data: Float32Array;
  columns: number;
  rows: number;
  height?: number;
  colormap?: ColormapName;
  vMin?: number;
  vMax?: number;
  /** Label positions as a fraction from the bottom of the plot. */
  yTicks?: { unit: number; label: string }[];
  xTicks?: { unit: number; label: string }[];
  /** Per-column row index to trace, for example the peak lag. */
  overlay?: { values: ArrayLike<number>; colour: string } | null;
  cursorX?: number | null;
  onHover?: (col: number | null, row: number | null) => void;
  onClick?: (col: number, row: number) => void;
}) {
  const { ref } = useDevicePixelCanvas(
    (ctx, w, h) => {
      const plotW = w - PAD.left - PAD.right;
      const plotH = h - PAD.top - PAD.bottom;
      if (plotW <= 0 || plotH <= 0 || columns <= 0 || rows <= 0) return;

      let lo = vMin ?? Infinity;
      let hi = vMax ?? -Infinity;
      if (vMin === undefined || vMax === undefined) {
        for (let i = 0; i < data.length; i++) {
          const v = data[i]!;
          if (!Number.isFinite(v)) continue;
          if (vMin === undefined && v < lo) lo = v;
          if (vMax === undefined && v > hi) hi = v;
        }
      }
      if (!Number.isFinite(lo)) lo = 0;
      if (!Number.isFinite(hi) || hi <= lo) hi = lo + 1;

      const lut = colormapLut(colormap);
      const img = ctx.createImageData(Math.floor(plotW), Math.floor(plotH));
      for (let py = 0; py < img.height; py++) {
        // Row 0 of the data is drawn at the bottom, which is how every axis in this
        // application is oriented.
        const r0 = Math.floor(((img.height - 1 - py) * rows) / img.height);
        const r1 = Math.max(r0 + 1, Math.floor(((img.height - py) * rows) / img.height));
        for (let px = 0; px < img.width; px++) {
          const c0 = Math.floor((px * columns) / img.width);
          const c1 = Math.max(c0 + 1, Math.floor(((px + 1) * columns) / img.width));
          let best = -Infinity;
          for (let c = c0; c < c1 && c < columns; c++) {
            for (let r = r0; r < r1 && r < rows; r++) {
              const v = data[c * rows + r]!;
              if (v > best) best = v;
            }
          }
          const t = Math.max(0, Math.min(1, (best - lo) / (hi - lo)));
          const li = Math.round(t * 255) * 4;
          const o = (py * img.width + px) * 4;
          img.data[o] = lut[li]!;
          img.data[o + 1] = lut[li + 1]!;
          img.data[o + 2] = lut[li + 2]!;
          img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, PAD.left, PAD.top);

      const style = getComputedStyle(document.documentElement);
      ctx.fillStyle = style.getPropertyValue("--muted").trim() || "#9aa8b5";
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const t of yTicks) {
        ctx.fillText(t.label, PAD.left - 4, PAD.top + (1 - t.unit) * plotH);
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const t of xTicks) {
        ctx.fillText(t.label, PAD.left + t.unit * plotW, h - PAD.bottom + 3);
      }

      if (overlay) {
        ctx.strokeStyle = overlay.colour;
        ctx.lineWidth = 1;
        ctx.beginPath();
        let drawing = false;
        for (let c = 0; c < Math.min(columns, overlay.values.length); c++) {
          const r = overlay.values[c]!;
          if (!Number.isFinite(r)) {
            drawing = false;
            continue;
          }
          const x = PAD.left + ((c + 0.5) / columns) * plotW;
          const y = PAD.top + (1 - (r + 0.5) / rows) * plotH;
          if (!drawing) {
            ctx.moveTo(x, y);
            drawing = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      if (cursorX !== null && cursorX !== undefined) {
        ctx.strokeStyle = "rgba(243,246,248,0.7)";
        const x = Math.round(PAD.left + cursorX * plotW) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, h - PAD.bottom);
        ctx.stroke();
      }
    },
    [data, columns, rows, colormap, vMin, vMax, yTicks, xTicks, overlay, cursorX],
    height,
  );

  const locate = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const plotW = rect.width - PAD.left - PAD.right;
    const plotH = rect.height - PAD.top - PAD.bottom;
    const u = (e.clientX - rect.left - PAD.left) / plotW;
    const v = 1 - (e.clientY - rect.top - PAD.top) / plotH;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return {
      col: Math.min(columns - 1, Math.floor(u * columns)),
      row: Math.min(rows - 1, Math.floor(v * rows)),
    };
  };

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <canvas
        ref={ref}
        onMouseMove={(e) => {
          const p = locate(e);
          onHover?.(p?.col ?? null, p?.row ?? null);
        }}
        onMouseLeave={() => onHover?.(null, null)}
        onClick={(e) => {
          const p = locate(e);
          if (p) onClick?.(p.col, p.row);
        }}
        style={{ display: "block", cursor: onClick ? "crosshair" : "default" }}
      />
    </div>
  );
}
