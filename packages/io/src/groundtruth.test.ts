import { describe, expect, it } from "vitest";
import {
  angularErrorSeries,
  bearingDeg,
  decodeAdvRecords,
  fixToAzEl,
  fixesToTrack,
  gnssAngularCeilingDeg,
  haversineM,
  interpolateTrack,
  parseAdvPayloadsNdjson,
  separationDeg,
  type CubeReference,
  type OdidFix,
} from "./groundtruth.js";
import { ODID_APP_CODE, ODID_MESSAGE_SIZE, OdidMessageType } from "./odid.js";

const CUBE: CubeReference = {
  latDeg: 50.0,
  lonDeg: 14.0,
  heightAboveTakeoffM: 1.5,
  micOneBearingDeg: 0,
};

function fix(partial: Partial<OdidFix>): OdidFix {
  return {
    epochSec: 1000,
    timeFromHost: false,
    receivedEpochSec: 1000,
    latDeg: 50.0,
    lonDeg: 14.0,
    heightM: 30,
    heightIsAboveTakeoff: true,
    altitudeGeodeticM: 250,
    speedMps: 0,
    verticalSpeedMps: 0,
    trackDeg: 0,
    horizontalAccuracyM: 3,
    verticalAccuracyM: 3,
    statusName: "airborne",
    address: null,
    rssiDbm: null,
    ...partial,
  };
}

describe("geodesy", () => {
  it("measures a short baseline to the metre", () => {
    // 0.001 degrees of latitude is about 111 m anywhere.
    expect(haversineM(50, 14, 50.001, 14)).toBeCloseTo(111.2, 0);
  });

  it("gives north as zero and east as ninety", () => {
    expect(bearingDeg(50, 14, 50.01, 14)).toBeCloseTo(0, 1);
    expect(bearingDeg(50, 14, 50, 14.01)).toBeCloseTo(90, 1);
  });
});

describe("azimuth and elevation at the cube", () => {
  it("turns a compass bearing into the array frame", () => {
    // Due north of the cube. The array counts anticlockwise from microphone 1, so a
    // cube facing north sees this at azimuth 0.
    const north = fixToAzEl(fix({ latDeg: 50.001, heightM: 1.5 }), CUBE);
    expect(north.bearingDeg).toBeCloseTo(0, 1);
    expect(north.azDeg).toBeCloseTo(0, 1);

    // Due east becomes azimuth 270 in the anticlockwise frame.
    const east = fixToAzEl(fix({ lonDeg: 14.001, heightM: 1.5 }), CUBE);
    expect(east.bearingDeg).toBeCloseTo(90, 1);
    expect(east.azDeg).toBeCloseTo(270, 1);
  });

  it("rotates with the cube's own orientation", () => {
    const rotated = fixToAzEl(fix({ latDeg: 50.001, heightM: 1.5 }), {
      ...CUBE,
      micOneBearingDeg: 90,
    });
    // Microphone 1 now faces east, so a target due north is 90 degrees round.
    expect(rotated.azDeg).toBeCloseTo(90, 1);
  });

  it("takes elevation from height above take-off, minus the cube's own height", () => {
    const p = fixToAzEl(fix({ latDeg: 50.001, heightM: 30 }), CUBE);
    expect(p.heightAboveCubeM).toBeCloseTo(28.5, 3);
    expect(p.elDeg).toBeCloseTo((Math.atan2(28.5, p.groundRangeM) * 180) / Math.PI, 3);
  });

  it("reports the accuracy ceiling that applies at this range", () => {
    const near = fixToAzEl(fix({ latDeg: 50.0001, heightM: 1.5 }), CUBE);
    const far = fixToAzEl(fix({ latDeg: 50.001, heightM: 1.5 }), CUBE);
    // Ground truth is worse close in, which is the opposite of the acoustics.
    expect(near.angularCeilingDeg).toBeGreaterThan(far.angularCeilingDeg);
  });
});

describe("the GNSS ceiling", () => {
  it("is worse than the array below about 30 m", () => {
    // The plan's figures: 17 degrees at 10 m, 1.7 at 100, against 1.07 resolution.
    expect(gnssAngularCeilingDeg(10)).toBeCloseTo(16.7, 0);
    expect(gnssAngularCeilingDeg(30)).toBeCloseTo(5.7, 0);
    expect(gnssAngularCeilingDeg(100)).toBeCloseTo(1.7, 1);
    expect(gnssAngularCeilingDeg(10)).toBeGreaterThan(1.07);
  });
});

describe("interpolation onto the DOA rate", () => {
  const track = fixesToTrack(
    [
      fix({ epochSec: 100, latDeg: 50.001, lonDeg: 14.0 }),
      fix({ epochSec: 101, latDeg: 50.0, lonDeg: 14.001 }),
    ],
    CUBE,
  );

  it("lands between the two fixes", () => {
    const mid = interpolateTrack(track, 100.5)!;
    expect(mid).not.toBeNull();
    expect(mid.epochSec).toBe(100.5);
    // North (0) to east (270 in the anticlockwise array frame) is 90 degrees the
    // short way, so halfway is 315 rather than 135.
    expect(track[0]!.azDeg).toBeCloseTo(0, 1);
    expect(track[1]!.azDeg).toBeCloseTo(270, 1);
    expect(mid.azDeg).toBeCloseTo(315, 1);
  });

  it("goes the short way round the wrap point", () => {
    const wrap = [
      { ...track[0]!, azDeg: 350, epochSec: 0 },
      { ...track[1]!, azDeg: 10, epochSec: 1 },
    ];
    expect(interpolateTrack(wrap, 0.5)!.azDeg).toBeCloseTo(0, 3);
  });

  it("refuses to draw a line across a dropout", () => {
    const gapped = [
      { ...track[0]!, epochSec: 0 },
      { ...track[1]!, epochSec: 30 },
    ];
    expect(interpolateTrack(gapped, 15, 3)).toBeNull();
  });
});

describe("angular error against truth", () => {
  const track = fixesToTrack(
    [
      fix({ epochSec: 100, latDeg: 50.0005, heightM: 21.5 }),
      fix({ epochSec: 101, latDeg: 50.0005, heightM: 21.5 }),
    ],
    CUBE,
  );

  it("scores a perfect measurement as zero and marks it inside the ceiling", () => {
    const truth = track[0]!;
    const s = angularErrorSeries(
      [{ epochSec: 100.5, azDeg: truth.azDeg, elDeg: truth.elDeg }],
      track,
    );
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]!.totalErrorDeg).toBeCloseTo(0, 6);
    expect(s.errors[0]!.withinCeiling).toBe(true);
    expect(s.withinCeilingFraction).toBe(1);
  });

  it("counts a measurement with no truth as unmatched rather than as an error", () => {
    const s = angularErrorSeries([{ epochSec: 500, azDeg: 0, elDeg: 0 }], track);
    expect(s.unmatched).toBe(1);
    expect(s.errors).toHaveLength(0);
  });

  it("measures the great-circle angle, not the sum of two axes", () => {
    // 10 degrees of azimuth at 60 degrees elevation is only 5 degrees of separation.
    expect(separationDeg(0, 60, 10, 60)).toBeLessThan(10);
    expect(separationDeg(0, 0, 10, 0)).toBeCloseTo(10, 6);
  });
});

describe("adv_payloads.ndjson", () => {
  function locationHex(latDeg: number, tenths: number): string {
    const b = new Uint8Array(2 + ODID_MESSAGE_SIZE);
    b[0] = ODID_APP_CODE;
    b[1] = 1;
    const m = b.subarray(2);
    const v = new DataView(b.buffer, b.byteOffset + 2, ODID_MESSAGE_SIZE);
    m[0] = (OdidMessageType.Location << 4) | 2;
    m[1] = 2 << 4;
    v.setInt32(5, Math.round(latDeg * 1e7), true);
    v.setInt32(9, Math.round(14.0 * 1e7), true);
    v.setUint16(17, Math.round((30 + 1000) / 0.5), true);
    m[19] = (5 << 4) | 10;
    v.setUint16(21, tenths, true);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  const hourStart = Math.floor(1712345678 / 3600) * 3600;
  const text = [
    JSON.stringify({ t: hourStart + 10.4, addr: "AA:BB", rssi: -70, payload: locationHex(50.001, 100) }),
    JSON.stringify({ t: hourStart + 11.4, addr: "AA:BB", rssi: -71, payload: locationHex(50.002, 110) }),
    "not json at all",
    JSON.stringify({ t: hourStart + 12.4, addr: "AA:BB", rssi: -72 }),
  ].join("\n");

  const parsed = parseAdvPayloadsNdjson(text);

  it("reads the records and reports the ones it skipped", () => {
    expect(parsed.records).toHaveLength(2);
    expect(parsed.skipped).toBe(2);
    expect(parsed.records[0]!.rssiDbm).toBe(-70);
  });

  it("times fixes from the message rather than from reception", () => {
    const decoded = decodeAdvRecords(parsed.records);
    expect(decoded.fixes).toHaveLength(2);
    // 100 tenths past the hour, not the 10.4 s the host happened to notice it.
    expect(decoded.fixes[0]!.epochSec).toBeCloseTo(hourStart + 10, 6);
    expect(decoded.fixes[0]!.timeFromHost).toBe(false);
    expect(decoded.fixes[1]!.epochSec).toBeCloseTo(hourStart + 11, 6);
  });

  it("counts dropped advertisements from the frame counter", () => {
    const withGap = parseAdvPayloadsNdjson(
      [
        JSON.stringify({ t: hourStart, payload: locationHex(50.001, 10) }),
        // Same counter every time in this fixture, so no gap should be claimed.
        JSON.stringify({ t: hourStart + 1, payload: locationHex(50.001, 20) }),
      ].join("\n"),
    );
    expect(decodeAdvRecords(withGap.records).droppedFrames).toBe(0);
  });
});
