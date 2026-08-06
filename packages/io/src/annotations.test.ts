import { describe, expect, it } from "vitest";
import {
  SerialLineReader,
  formatAnnotations,
  parseAnnotations,
  parseTimestamp,
} from "./annotations.js";

describe("timestamps", () => {
  it("reads the forms a field notebook produces", () => {
    expect(parseTimestamp("12.5")).toBe(12.5);
    expect(parseTimestamp("1:23.5")).toBe(83.5);
    expect(parseTimestamp("01:02:03.25")).toBeCloseTo(3723.25, 6);
  });

  it("treats a large number as an epoch and needs an anchor for it", () => {
    expect(parseTimestamp("1712345678")).toBeNull();
    expect(parseTimestamp("1712345678", 1712345600)).toBe(78);
  });
});

describe("label files", () => {
  const text = [
    "# session 2026-05-01, Neo 2, no RID module",
    "TIME SYNC 1712345600",
    "12.5\t18.0\tdrone hover dist=20 wind=3",
    "25.0 fast pass",
    "1712345700 1712345710 landing",
    "",
    "nonsense line without a number",
  ].join("\n");

  const r = parseAnnotations(text, { durationSec: 200, defaultDurationSec: 0.5 });

  it("picks up the time sync so absolute stamps land on the timeline", () => {
    expect(r.timeSyncEpoch).toBe(1712345600);
    const landing = r.annotations.find((a) => a.label === "landing");
    expect(landing?.startSec).toBe(100);
    expect(landing?.endSec).toBe(110);
  });

  it("separates metadata from the label", () => {
    const hover = r.annotations.find((a) => a.label === "drone hover");
    expect(hover).toBeDefined();
    expect(hover!.startSec).toBe(12.5);
    expect(hover!.endSec).toBe(18);
    expect(hover!.meta).toEqual({ dist: "20", wind: "3" });
  });

  it("gives an instant event a visible length", () => {
    const pass = r.annotations.find((a) => a.label === "fast pass");
    expect(pass!.startSec).toBe(25);
    expect(pass!.endSec).toBe(25.5);
  });

  it("reports what it could not read instead of dropping it", () => {
    expect(r.unparsed).toHaveLength(1);
    expect(r.unparsed[0]!.raw).toContain("nonsense");
  });

  it("returns events in time order", () => {
    const starts = r.annotations.map((a) => a.startSec);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("round trips through the canonical form", () => {
    const again = parseAnnotations(formatAnnotations(r.annotations));
    expect(again.annotations.map((a) => [a.startSec, a.endSec, a.label])).toEqual(
      r.annotations.map((a) => [a.startSec, a.endSec, a.label]),
    );
  });
});

describe("firmware serial lines", () => {
  it("parses DET and SRC and places them on the recording clock", () => {
    const r = parseAnnotations(
      [
        "TIME SYNC 1000000000",
        "DET t=1000000012.5 class=drone conf=0.81",
        "SRC class=drone az=31.2 el=12.0 conf=0.81 t=15.0",
      ].join("\n"),
    );
    expect(r.serial).toHaveLength(3);
    const det = r.serial.find((s) => s.kind === "DET")!;
    expect(det.timeSec).toBe(12.5);
    expect(det.fields.class).toBe("drone");

    const src = r.serial.find((s) => s.kind === "SRC")!;
    expect(src.timeSec).toBe(15);
    expect(src.epochSec).toBe(1000000015);
    expect(src.fields.az).toBe("31.2");
  });

  it("does not mistake a serial line for an annotation", () => {
    const r = parseAnnotations("DET class=drone conf=0.9");
    expect(r.annotations).toHaveLength(0);
    expect(r.serial).toHaveLength(1);
  });
});

describe("live serial reader", () => {
  it("holds a partial line until the rest arrives", () => {
    const reader = new SerialLineReader();
    expect(reader.push("TIME SYNC 1000000000\nDET class=")).toHaveLength(1);
    const more = reader.push("drone conf=0.5 t=3.0\n");
    expect(more).toHaveLength(1);
    expect(more[0]!.fields.conf).toBe("0.5");
    expect(more[0]!.timeSec).toBe(3);
  });

  it("releases the tail on flush", () => {
    const reader = new SerialLineReader();
    reader.push("SRC az=10");
    const flushed = reader.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.fields.az).toBe("10");
    expect(reader.flush()).toHaveLength(0);
  });

  it("keeps lines it does not understand", () => {
    const reader = new SerialLineReader();
    const evs = reader.push("I2S overrun, dropped 3 frames\n");
    expect(evs[0]!.kind).toBe("OTHER");
    expect(evs[0]!.raw).toContain("overrun");
  });
});
