/*
 * Export helpers.
 *
 * Everything the application computes has to be recoverable outside it. A number on
 * screen that cannot be re-derived in a spreadsheet or a notebook is not evidence,
 * and this is a tool for deciding what the detector should do, so evidence is the
 * whole product.
 */

export type CsvValue = string | number | boolean | null | undefined;

function csvCell(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return v > 0 ? "inf" : Number.isNaN(v) ? "nan" : "-inf";
    return String(v);
  }
  if (typeof v === "boolean") return v ? "1" : "0";
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(
  rows: ReadonlyArray<Record<string, CsvValue>>,
  columns?: readonly string[],
): string {
  if (rows.length === 0) return columns ? columns.join(",") + "\n" : "";
  const cols = columns ?? Object.keys(rows[0]!);
  const out: string[] = [cols.map(csvCell).join(",")];
  for (const row of rows) out.push(cols.map((c) => csvCell(row[c])).join(","));
  return out.join("\n") + "\n";
}

/**
 * Columns of equal-length numeric series, one row per sample. Used for anything that
 * is a set of time series rather than a spectrogram: band metrics, pair delays,
 * match scores.
 */
export function seriesToCsv(
  columns: readonly string[],
  rows: ReadonlyArray<readonly number[]>,
  digits = 6,
): string {
  const out: string[] = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    out.push(
      row
        .map((v) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : csvCell(v)))
        .join(","),
    );
  }
  return out.join("\n") + "\n";
}

/**
 * A frames-by-bins matrix with real axis values in the header row and first column,
 * rather than indices. Bin 137 means nothing six months later; 1605.5 Hz does.
 */
export function matrixToCsv(
  data: Float32Array,
  frames: number,
  bins: number,
  opts: {
    binHz: number;
    hopSec: number;
    startSec?: number;
    /** Bin range to write; the full 8193 bins of a 16k FFT is rarely what is wanted. */
    binFrom?: number;
    binTo?: number;
    digits?: number;
  },
): string {
  const from = Math.max(0, opts.binFrom ?? 0);
  const to = Math.min(bins, opts.binTo ?? bins);
  const digits = opts.digits ?? 3;
  const start = opts.startSec ?? 0;

  const header = ["time_s"];
  for (let b = from; b < to; b++) header.push((b * opts.binHz).toFixed(1));
  const out: string[] = [header.join(",")];

  for (let f = 0; f < frames; f++) {
    const row: string[] = [(start + f * opts.hopSec).toFixed(6)];
    const base = f * bins;
    for (let b = from; b < to; b++) row.push(data[base + b]!.toFixed(digits));
    out.push(row.join(","));
  }
  return out.join("\n") + "\n";
}

/** Typed arrays as plain arrays, so a debug dump survives JSON.stringify. */
export function jsonSafe(value: unknown): unknown {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>);
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

export function toJson(value: unknown, pretty = true): string {
  return JSON.stringify(jsonSafe(value), null, pretty ? 2 : 0);
}

export interface ExportEnvelope<T> {
  kind: string;
  exportedAt: string;
  /** Commit and version of the build, so a saved result traces to the code. */
  producedBy?: { version: string; commit: string };
  payload: T;
}

export function envelope<T>(
  kind: string,
  payload: T,
  producedBy?: { version: string; commit: string },
): ExportEnvelope<T> {
  return {
    kind,
    exportedAt: new Date().toISOString(),
    producedBy,
    payload,
  };
}

/**
 * Saves text as a file. In Electron the renderer is the same code, and a blob
 * download lands in the configured download directory there too, so there is no need
 * for a second path through the main process.
 */
export function downloadText(
  filename: string,
  text: string,
  mime = "text/plain;charset=utf-8",
): void {
  if (typeof document === "undefined") {
    throw new Error("downloadText needs a document; call it from the UI thread");
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download in some browsers, so this waits
  // for the click to have been handled.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadCsv(filename: string, csv: string): void {
  downloadText(filename, csv, "text/csv;charset=utf-8");
}

export function downloadJson(filename: string, value: unknown): void {
  downloadText(filename, toJson(value), "application/json;charset=utf-8");
}
