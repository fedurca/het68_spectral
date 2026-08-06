import { describe, expect, it } from "vitest";
import {
  ODID_APP_CODE,
  ODID_MESSAGE_SIZE,
  ODID_SERVICE_UUID,
  OdidMessageType,
  bytesToHex,
  decodeOdidPayload,
  decodeVendorType13,
  resolveOdidTimestamp,
  type OdidBasicId,
  type OdidLocation,
} from "./odid.js";

const LAT = 50.0755;
const LON = 14.4378;

/** Builds a Location message the way ASTM F3411 lays one out. */
function locationMessage(opts: {
  latDeg?: number;
  lonDeg?: number;
  heightM?: number;
  geodeticM?: number;
  speedMps?: number;
  trackDeg?: number;
  timestampTenths?: number;
} = {}): Uint8Array {
  const b = new Uint8Array(ODID_MESSAGE_SIZE);
  const v = new DataView(b.buffer);
  b[0] = (OdidMessageType.Location << 4) | 2;

  const body = 1;
  // Airborne, height above take-off, no direction segment, fine speed scale.
  b[body] = (2 << 4) | 0;
  b[body + 1] = opts.trackDeg ?? 45;
  b[body + 2] = Math.round((opts.speedMps ?? 5) / 0.25);
  b[body + 3] = 0;
  v.setInt32(body + 4, Math.round((opts.latDeg ?? LAT) * 1e7), true);
  v.setInt32(body + 8, Math.round((opts.lonDeg ?? LON) * 1e7), true);
  v.setUint16(body + 12, Math.round((0 + 1000) / 0.5), true);
  v.setUint16(body + 14, Math.round(((opts.geodeticM ?? 250) + 1000) / 0.5), true);
  v.setUint16(body + 16, Math.round(((opts.heightM ?? 30) + 1000) / 0.5), true);
  // Vertical accuracy code 5 (3 m), horizontal accuracy code 10 (10 m).
  b[body + 18] = (5 << 4) | 10;
  b[body + 19] = (3 << 4) | 2;
  v.setUint16(body + 20, opts.timestampTenths ?? 12345, true);
  b[body + 22] = 3;
  return b;
}

function basicIdMessage(id = "1596F3AB2C4D5E6F"): Uint8Array {
  const b = new Uint8Array(ODID_MESSAGE_SIZE);
  b[0] = (OdidMessageType.BasicId << 4) | 2;
  b[1] = (1 << 4) | 2; // serial number, multirotor
  for (let i = 0; i < id.length && i < 20; i++) b[2 + i] = id.charCodeAt(i);
  return b;
}

function appCodeFrame(msg: Uint8Array, counter = 7): Uint8Array {
  const out = new Uint8Array(2 + msg.length);
  out[0] = ODID_APP_CODE;
  out[1] = counter;
  out.set(msg, 2);
  return out;
}

function adStructures(serviceData: Uint8Array): Uint8Array {
  const flags = [0x02, 0x01, 0x06];
  const sd = [1 + 2 + serviceData.length, 0x16, ODID_SERVICE_UUID & 0xff, ODID_SERVICE_UUID >> 8];
  return Uint8Array.from([...flags, ...sd, ...serviceData]);
}

describe("Location message", () => {
  const frame = decodeOdidPayload(appCodeFrame(locationMessage()));
  const loc = frame.messages[0] as OdidLocation;

  it("recognises the app code framing rather than reading it as a message type", () => {
    expect(frame.framing).toBe("app-code");
    expect(frame.messageCounter).toBe(7);
    expect(frame.protocolVersion).toBe(2);
  });

  it("recovers position", () => {
    expect(loc.type).toBe(OdidMessageType.Location);
    expect(loc.latDeg).toBeCloseTo(LAT, 6);
    expect(loc.lonDeg).toBeCloseTo(LON, 6);
  });

  it("keeps the altitude and height that the existing scanner discards", () => {
    expect(loc.heightM).toBeCloseTo(30, 3);
    expect(loc.heightIsAboveTakeoff).toBe(true);
    expect(loc.altitudeGeodeticM).toBeCloseTo(250, 3);
  });

  it("keeps the message timestamp, which is the whole point for ground truth", () => {
    expect(loc.timestampTenths).toBe(12345);
    expect(loc.timestampAccuracySec).toBeCloseTo(0.3, 6);
  });

  it("decodes velocity and accuracy", () => {
    expect(loc.speedMps).toBeCloseTo(5, 3);
    expect(loc.trackDeg).toBe(45);
    expect(loc.horizontalAccuracyM).toBe(10);
    expect(loc.verticalAccuracyM).toBe(3);
    expect(loc.statusName).toBe("airborne");
  });
});

describe("framing", () => {
  it("finds the payload inside a full AD structure list", () => {
    const frame = decodeOdidPayload(adStructures(appCodeFrame(locationMessage())));
    expect(frame.framing).toBe("ad-structures");
    expect((frame.messages[0] as OdidLocation).latDeg).toBeCloseTo(LAT, 6);
  });

  it("accepts hex as written into the ndjson", () => {
    const hex = bytesToHex(appCodeFrame(locationMessage()));
    const frame = decodeOdidPayload(hex);
    expect((frame.messages[0] as OdidLocation).latDeg).toBeCloseTo(LAT, 6);
  });

  it("unpacks a message pack into its parts", () => {
    const a = basicIdMessage();
    const b = locationMessage();
    const pack = new Uint8Array(3 + 2 * ODID_MESSAGE_SIZE);
    pack[0] = (OdidMessageType.MessagePack << 4) | 2;
    pack[1] = ODID_MESSAGE_SIZE;
    pack[2] = 2;
    pack.set(a, 3);
    pack.set(b, 3 + ODID_MESSAGE_SIZE);

    const frame = decodeOdidPayload(appCodeFrame(pack));
    expect(frame.framing).toBe("message-pack");
    expect(frame.messages).toHaveLength(2);
    expect((frame.messages[0] as OdidBasicId).uasId).toBe("1596F3AB2C4D5E6F");
    expect((frame.messages[1] as OdidLocation).latDeg).toBeCloseTo(LAT, 6);
  });
});

describe("Basic ID", () => {
  it("reads the serial number and aircraft type", () => {
    const frame = decodeOdidPayload(appCodeFrame(basicIdMessage()));
    const id = frame.messages[0] as OdidBasicId;
    expect(id.uasId).toBe("1596F3AB2C4D5E6F");
    expect(id.idTypeName).toContain("serial number");
    expect(id.uaTypeName).toBe("multirotor");
  });
});

describe("the interpretation dronetag.py arrived at", () => {
  it("lands on different bytes, which is why it is kept for comparison", () => {
    const payload = appCodeFrame(locationMessage());
    const canonical = decodeOdidPayload(payload).messages[0] as OdidLocation;
    const vendor = decodeVendorType13(payload)!;
    // The vendor reading starts two bytes early, so it cannot agree except by luck.
    expect(vendor.latDeg).not.toBeCloseTo(canonical.latDeg!, 3);
  });
});

describe("timestamp resolution", () => {
  const hourStart = Math.floor(1712345678 / 3600) * 3600;

  it("puts the hour back on an hour-relative stamp", () => {
    expect(resolveOdidTimestamp(300, hourStart + 30)).toBe(hourStart + 30);
  });

  it("takes a frame that crossed the hour boundary to the right hour", () => {
    // Message says 5 s past the hour, received 10 s before it.
    const received = hourStart - 10;
    expect(resolveOdidTimestamp(50, received)).toBeCloseTo(hourStart + 5, 6);
  });

  it("does not jump an hour forward for a stamp near the end of one", () => {
    const received = hourStart + 3595;
    expect(resolveOdidTimestamp(35950, received)).toBeCloseTo(hourStart + 3595, 6);
  });
});
