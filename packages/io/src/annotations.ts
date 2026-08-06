/*
 * Annotations, one event per line.
 *
 * Two things arrive in this shape and they are deliberately handled by the same
 * parser: a hand-written label file that says when the drone was audible, and the
 * firmware's own serial output. Being able to overlay `DET class=drone` lines on the
 * spectrogram next to your own labels is most of the point of the application.
 *
 * The accepted syntax is loose on purpose. Anything written in a field notebook at
 * a flying site should load, and whatever cannot be understood is reported by line
 * number rather than dropped.
 */

import type { Annotation } from "./session.js";

export interface ParsedLine {
  lineNumber: number;
  raw: string;
}

export type SerialKind = "DET" | "SRC" | "TRACK" | "TIME" | "OTHER";

/** A firmware serial line, kept in its original form as well as parsed. */
export interface SerialEvent {
  lineNumber: number;
  raw: string;
  kind: SerialKind;
  /** Seconds from the start of the recording, once a TIME SYNC has been seen. */
  timeSec: number | null;
  /** Wall-clock epoch seconds, when the line carried one. */
  epochSec: number | null;
  fields: Record<string, string>;
}

export interface AnnotationParseResult {
  annotations: Annotation[];
  serial: SerialEvent[];
  /** Epoch seconds of sample zero, from `TIME SYNC`. */
  timeSyncEpoch: number | null;
  warnings: string[];
  /** Lines that matched nothing, so a malformed file is visible rather than silent. */
  unparsed: ParsedLine[];
}

export interface AnnotationParseOptions {
  /**
   * Epoch seconds of sample zero. Lets absolute timestamps in the file be placed on
   * the recording's timeline. A `TIME SYNC` line in the file overrides it.
   */
  recordingStartEpoch?: number;
  /** Length of the recording, used to clamp and to flag events that fall outside. */
  durationSec?: number;
  /** Zero-length events become this long so they are visible on the timeline. */
  defaultDurationSec?: number;
}

/**
 * Accepts `12.5`, `1:23.5`, `01:02:03.250` and bare epoch seconds. Epochs are told
 * apart by magnitude: anything past 10^9 is a date, not an offset into a recording
 * that would have to be 31 years long.
 */
const EPOCH_THRESHOLD = 1e9;

export function parseTimestamp(
  token: string,
  recordingStartEpoch?: number,
): number | null {
  const t = token.trim();
  if (t === "") return null;

  if (t.includes(":")) {
    const parts = t.split(":");
    if (parts.length > 3) return null;
    let sec = 0;
    for (const p of parts) {
      const v = Number(p);
      if (!Number.isFinite(v)) return null;
      sec = sec * 60 + v;
    }
    return sec;
  }

  // ISO 8601, as written by any tool that logs a real clock.
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(t)) {
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) return null;
    if (recordingStartEpoch === undefined) return null;
    return ms / 1000 - recordingStartEpoch;
  }

  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  if (v >= EPOCH_THRESHOLD) {
    if (recordingStartEpoch === undefined) return null;
    return v - recordingStartEpoch;
  }
  return v;
}

/** Pulls `key=value` pairs out of a tail, leaving the rest as the label. */
function splitMeta(tokens: string[]): { label: string; meta: Record<string, string> } {
  const meta: Record<string, string> = {};
  const words: string[] = [];
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq > 0 && eq < tok.length - 1) {
      meta[tok.slice(0, eq)] = tok.slice(eq + 1);
    } else {
      words.push(tok);
    }
  }
  return { label: words.join(" "), meta };
}

function classifySerial(head: string): SerialKind {
  switch (head) {
    case "DET":
      return "DET";
    case "SRC":
      return "SRC";
    case "TRACK":
    case "TRACKS":
      return "TRACK";
    case "TIME":
      return "TIME";
    default:
      return "OTHER";
  }
}

/**
 * Reads a label or serial log.
 *
 * Recognised forms, in the order they are tried:
 *   `# comment`
 *   `TIME SYNC 1712345678`
 *   `DET class=drone az=31.2 el=12.0 conf=0.81`   (any firmware line with key=value)
 *   `12.5  18.0  drone hover  dist=20 wind=3`      (start, end, label, metadata)
 *   `12.5  drone hover`                            (instant, given a default length)
 *   Audacity label files, which are the three-field form separated by tabs.
 */
export function parseAnnotations(
  text: string,
  opts: AnnotationParseOptions = {},
): AnnotationParseResult {
  const annotations: Annotation[] = [];
  const serial: SerialEvent[] = [];
  const warnings: string[] = [];
  const unparsed: ParsedLine[] = [];
  const defaultDuration = opts.defaultDurationSec ?? 0.25;

  let startEpoch = opts.recordingStartEpoch;
  let timeSyncEpoch: number | null = null;
  let counter = 0;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    const lineNumber = i + 1;
    if (line === "" || line.startsWith("#") || line.startsWith("//")) continue;

    const tokens = line.split(/[\t ]+/);
    const head = tokens[0]!;

    if (head === "TIME" && tokens[1] === "SYNC") {
      const epoch = Number(tokens[2]);
      if (Number.isFinite(epoch)) {
        timeSyncEpoch = epoch;
        // A TIME SYNC in the file is authoritative: it was written by the machine
        // that started the recording, unlike anything supplied from outside.
        startEpoch = epoch;
        serial.push({
          lineNumber,
          raw,
          kind: "TIME",
          timeSec: 0,
          epochSec: epoch,
          fields: {},
        });
      } else {
        warnings.push(`Line ${lineNumber}: TIME SYNC without a usable epoch.`);
        unparsed.push({ lineNumber, raw });
      }
      continue;
    }

    const kind = classifySerial(head);
    if (kind !== "OTHER" && kind !== "TIME") {
      const fields: Record<string, string> = {};
      for (const tok of tokens.slice(1)) {
        const eq = tok.indexOf("=");
        if (eq > 0) fields[tok.slice(0, eq)] = tok.slice(eq + 1);
      }
      const tField = fields.t ?? fields.time ?? fields.ts;
      let timeSec: number | null = null;
      let epochSec: number | null = null;
      if (tField !== undefined) {
        const v = Number(tField);
        if (Number.isFinite(v)) {
          if (v >= EPOCH_THRESHOLD) {
            epochSec = v;
            timeSec = startEpoch !== undefined ? v - startEpoch : null;
          } else {
            timeSec = v;
            epochSec = startEpoch !== undefined ? startEpoch + v : null;
          }
        }
      }
      serial.push({ lineNumber, raw, kind, timeSec, epochSec, fields });
      continue;
    }

    const first = parseTimestamp(head, startEpoch);
    if (first === null) {
      unparsed.push({ lineNumber, raw });
      continue;
    }

    const second = tokens.length > 1 ? parseTimestamp(tokens[1]!, startEpoch) : null;
    // A second numeric field is only an end time if it comes after the start. This
    // is what tells `12.5 18.0 drone` apart from `12.5 4 rotors audible`.
    const hasEnd = second !== null && second >= first;
    const rest = tokens.slice(hasEnd ? 2 : 1);
    const { label, meta } = splitMeta(rest);

    let startSec = first;
    let endSec = hasEnd ? second : first + defaultDuration;

    if (startSec < 0) {
      warnings.push(
        `Line ${lineNumber}: starts ${(-startSec).toFixed(3)} s before the recording; clamped to 0.`,
      );
      startSec = 0;
    }
    if (opts.durationSec !== undefined && startSec > opts.durationSec) {
      warnings.push(
        `Line ${lineNumber}: at ${startSec.toFixed(3)} s, past the end of a ${opts.durationSec.toFixed(3)} s recording.`,
      );
    }
    if (opts.durationSec !== undefined && endSec > opts.durationSec) {
      endSec = opts.durationSec;
    }

    annotations.push({
      id: `a-${lineNumber}-${counter++}`,
      startSec,
      endSec,
      label: label === "" ? "event" : label,
      meta,
    });
  }

  annotations.sort((a, b) => a.startSec - b.startSec);
  return { annotations, serial, timeSyncEpoch, warnings, unparsed };
}

/** Writes the canonical three-field form, which this parser reads back exactly. */
export function formatAnnotations(annotations: Annotation[]): string {
  return annotations
    .map((a) => {
      const meta = Object.entries(a.meta)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      return `${a.startSec.toFixed(3)}\t${a.endSec.toFixed(3)}\t${a.label}${
        meta ? ` ${meta}` : ""
      }`;
    })
    .join("\n");
}

/** Annotations overlapping a time window, for "what was happening here". */
export function annotationsAt(
  annotations: Annotation[],
  startSec: number,
  endSec: number,
): Annotation[] {
  return annotations.filter((a) => a.endSec >= startSec && a.startSec <= endSec);
}

/**
 * Incremental reader for a live serial port, which delivers arbitrary chunks rather
 * than lines. Holds a partial trailing line until the rest of it arrives.
 */
export class SerialLineReader {
  private buffer = "";
  private lineNumber = 0;
  private startEpoch: number | undefined;

  constructor(recordingStartEpoch?: number) {
    this.startEpoch = recordingStartEpoch;
  }

  get timeSyncEpoch(): number | undefined {
    return this.startEpoch;
  }

  push(chunk: string): SerialEvent[] {
    this.buffer += chunk;
    const out: SerialEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      this.lineNumber++;
      const ev = this.parseLine(line, this.lineNumber);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** Call at end of stream to release a last line that had no newline. */
  flush(): SerialEvent[] {
    if (this.buffer === "") return [];
    const line = this.buffer;
    this.buffer = "";
    this.lineNumber++;
    const ev = this.parseLine(line, this.lineNumber);
    return ev ? [ev] : [];
  }

  private parseLine(raw: string, lineNumber: number): SerialEvent | null {
    const line = raw.trim();
    if (line === "") return null;
    const result = parseAnnotations(line, { recordingStartEpoch: this.startEpoch });
    if (result.timeSyncEpoch !== null) this.startEpoch = result.timeSyncEpoch;
    if (result.serial.length > 0) {
      return { ...result.serial[0]!, lineNumber, raw };
    }
    // Anything else is kept verbatim; a firmware log line nobody parses is still
    // worth showing next to the spectrogram.
    return {
      lineNumber,
      raw,
      kind: "OTHER",
      timeSec: null,
      epochSec: null,
      fields: {},
    };
  }
}
