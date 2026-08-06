/*
 * Open Drone ID (ASTM F3411) decoder, working from the raw hex that dronetag.py
 * writes to adv_payloads.ndjson.
 *
 * The scanner in het68 already parses enough for a live table, but not enough for
 * ground truth: it keeps latitude and longitude and discards altitude, speed and —
 * most importantly — the message's own timestamp. Without altitude there is no
 * elevation angle, which is half of what we are trying to validate, and without the
 * message timestamp every fix carries the jitter of a BLE scan window, which at
 * 12 m/s is metres of position error.
 *
 * The framing is also worth getting right rather than reverse-engineering. `0x0D`
 * at the head of a payload is not a message type, it is the ODID application code
 * for BLE; a counter follows it and only then the message header. Decoding it as a
 * message type puts every field one or two bytes out, which looks plausible for
 * latitude and quietly wrong for everything else.
 */

export enum OdidMessageType {
  BasicId = 0,
  Location = 1,
  Authentication = 2,
  SelfId = 3,
  System = 4,
  OperatorId = 5,
  MessagePack = 0xf,
}

/** How the bytes were wrapped, so a surprising file can be diagnosed. */
export type OdidFraming =
  | "ad-structures"
  | "service-data"
  | "app-code"
  | "bare-message"
  | "message-pack";

export const ODID_SERVICE_UUID = 0xfffa;
export const ODID_APP_CODE = 0x0d;
export const ODID_MESSAGE_SIZE = 25;

export interface OdidBasicId {
  type: OdidMessageType.BasicId;
  idType: number;
  idTypeName: string;
  uaType: number;
  uaTypeName: string;
  uasId: string;
}

export interface OdidLocation {
  type: OdidMessageType.Location;
  statusName: string;
  status: number;
  /** Degrees true, or null when the aircraft reported it unknown. */
  trackDeg: number | null;
  speedMps: number | null;
  verticalSpeedMps: number | null;
  latDeg: number | null;
  lonDeg: number | null;
  /** Metres above the WGS84 ellipsoid, null when unknown. */
  altitudeGeodeticM: number | null;
  altitudePressureM: number | null;
  /**
   * Height above take-off or ground, per `heightIsAboveTakeoff`. Preferred over
   * geodetic altitude for elevation, since GNSS vertical error is 1.5 to 2 times
   * the horizontal figure while the take-off reference cancels most of it.
   */
  heightM: number | null;
  heightIsAboveTakeoff: boolean;
  horizontalAccuracyM: number | null;
  verticalAccuracyM: number | null;
  speedAccuracyMps: number | null;
  /** Tenths of a second since the last full hour, as carried in the message. */
  timestampTenths: number | null;
  timestampAccuracySec: number | null;
}

export interface OdidSystem {
  type: OdidMessageType.System;
  operatorLatDeg: number | null;
  operatorLonDeg: number | null;
  operatorAltitudeM: number | null;
  areaCount: number;
  areaRadiusM: number;
  /** Seconds since 2019-01-01T00:00:00Z, as the standard defines it. */
  timestampEpoch2019: number;
  timestampEpochSec: number;
}

export interface OdidSelfId {
  type: OdidMessageType.SelfId;
  descriptionType: number;
  description: string;
}

export interface OdidOperatorId {
  type: OdidMessageType.OperatorId;
  operatorIdType: number;
  operatorId: string;
}

export interface OdidUnknown {
  type: number;
  raw: string;
}

export type OdidMessage =
  | OdidBasicId
  | OdidLocation
  | OdidSystem
  | OdidSelfId
  | OdidOperatorId
  | OdidUnknown;

export interface OdidFrame {
  framing: OdidFraming;
  protocolVersion: number;
  /** Present on BLE frames; increments per message and exposes dropped packets. */
  messageCounter: number | null;
  messages: OdidMessage[];
  warnings: string[];
}

const ID_TYPES = [
  "none",
  "serial number (CTA-2063-A)",
  "CAA registration",
  "UTM assigned UUID",
  "specific session ID",
];

const UA_TYPES = [
  "none",
  "aeroplane",
  "multirotor",
  "gyroplane",
  "hybrid lift",
  "ornithopter",
  "glider",
  "kite",
  "free balloon",
  "captive balloon",
  "airship",
  "free fall parachute",
  "rocket",
  "tethered powered aircraft",
  "ground obstacle",
  "other",
];

const STATUS_NAMES = [
  "undeclared",
  "ground",
  "airborne",
  "emergency",
  "remote ID system failure",
];

/** ODID accuracy enumerations, in metres. Index 0 means unknown. */
const HORIZONTAL_ACCURACY_M = [
  null, 18520, 7408, 3704, 1852, 926, 555.6, 185.2, 92.6, 30, 10, 3, 1, null, null,
  null,
] as const;
const VERTICAL_ACCURACY_M = [null, 150, 45, 25, 10, 3, 1, null] as const;
const SPEED_ACCURACY_MPS = [null, 10, 3, 1, 0.3] as const;

/** ODID counts seconds from 2019-01-01T00:00:00Z rather than the Unix epoch. */
export const ODID_EPOCH_OFFSET_SEC = 1546300800;

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2 !== 0) {
    throw new Error(`Hex payload has an odd number of digits (${clean.length})`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function ascii(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    if (b === 0) break;
    out += b >= 32 && b < 127 ? String.fromCharCode(b) : "";
  }
  return out.trim();
}

function int32le(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(o, true);
}

function uint16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

/** ODID altitudes are unsigned half-metres biased by 1000 m. 0 means unknown. */
function altitude(raw: number): number | null {
  return raw === 0 ? null : raw * 0.5 - 1000;
}

function coordinate(raw: number): number | null {
  if (raw === 0) return null;
  const deg = raw * 1e-7;
  return Math.abs(deg) > 180 ? null : deg;
}

function decodeLocation(b: Uint8Array): OdidLocation {
  const status = (b[0]! >> 4) & 0x0f;
  const heightIsAboveTakeoff = ((b[0]! >> 2) & 1) === 0;
  const ewSegment = (b[0]! >> 1) & 1;
  const speedMultiplier = b[0]! & 1;

  const trackRaw = b[1]!;
  const trackDeg = trackRaw === 361 ? null : (trackRaw + (ewSegment ? 180 : 0)) % 360;

  const speedRaw = b[2]!;
  // Two scales share one byte: fine below 63.75 m/s, coarse above it. 255 is unknown.
  const speedMps =
    speedRaw === 255
      ? null
      : speedMultiplier === 0
        ? speedRaw * 0.25
        : speedRaw * 0.75 + 255 * 0.25;

  const vsRaw = new Int8Array([b[3]!])[0]!;
  const verticalSpeedMps = vsRaw === 63 ? null : vsRaw * 0.5;

  const hAcc = b[18]! & 0x0f;
  const vAcc = (b[18]! >> 4) & 0x0f;
  const sAcc = b[19]! & 0x0f;
  const tsRaw = uint16le(b, 20);

  return {
    type: OdidMessageType.Location,
    status,
    statusName: STATUS_NAMES[status] ?? `reserved (${status})`,
    trackDeg,
    speedMps,
    verticalSpeedMps,
    latDeg: coordinate(int32le(b, 4)),
    lonDeg: coordinate(int32le(b, 8)),
    altitudePressureM: altitude(uint16le(b, 12)),
    altitudeGeodeticM: altitude(uint16le(b, 14)),
    heightM: altitude(uint16le(b, 16)),
    heightIsAboveTakeoff,
    horizontalAccuracyM: HORIZONTAL_ACCURACY_M[hAcc] ?? null,
    verticalAccuracyM: VERTICAL_ACCURACY_M[vAcc & 0x07] ?? null,
    speedAccuracyMps: SPEED_ACCURACY_MPS[sAcc & 0x07] ?? null,
    // 36000 tenths is one hour; anything at or past it is the "unknown" code.
    timestampTenths: tsRaw >= 36000 ? null : tsRaw,
    timestampAccuracySec: (b[22]! & 0x0f) === 0 ? null : (b[22]! & 0x0f) * 0.1,
  };
}

function decodeMessage(b: Uint8Array): { message: OdidMessage; version: number } {
  const type = (b[0]! >> 4) & 0x0f;
  const version = b[0]! & 0x0f;
  const body = b.subarray(1, ODID_MESSAGE_SIZE);

  switch (type) {
    case OdidMessageType.BasicId: {
      const idType = (body[0]! >> 4) & 0x0f;
      const uaType = body[0]! & 0x0f;
      return {
        version,
        message: {
          type: OdidMessageType.BasicId,
          idType,
          idTypeName: ID_TYPES[idType] ?? `reserved (${idType})`,
          uaType,
          uaTypeName: UA_TYPES[uaType] ?? `reserved (${uaType})`,
          uasId: ascii(body.subarray(1, 21)),
        },
      };
    }
    case OdidMessageType.Location:
      return { version, message: decodeLocation(body) };
    case OdidMessageType.SelfId:
      return {
        version,
        message: {
          type: OdidMessageType.SelfId,
          descriptionType: body[0]!,
          description: ascii(body.subarray(1, 24)),
        },
      };
    case OdidMessageType.System: {
      const ts = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(
        19,
        true,
      );
      return {
        version,
        message: {
          type: OdidMessageType.System,
          operatorLatDeg: coordinate(int32le(body, 1)),
          operatorLonDeg: coordinate(int32le(body, 5)),
          operatorAltitudeM: altitude(uint16le(body, 17)),
          areaCount: uint16le(body, 9),
          areaRadiusM: body[11]! * 10,
          timestampEpoch2019: ts,
          timestampEpochSec: ts + ODID_EPOCH_OFFSET_SEC,
        },
      };
    }
    case OdidMessageType.OperatorId:
      return {
        version,
        message: {
          type: OdidMessageType.OperatorId,
          operatorIdType: body[0]!,
          operatorId: ascii(body.subarray(1, 21)),
        },
      };
    default:
      return {
        version,
        message: { type, raw: bytesToHex(b.subarray(0, ODID_MESSAGE_SIZE)) },
      };
  }
}

function decodeMessagesFrom(
  bytes: Uint8Array,
  warnings: string[],
): { messages: OdidMessage[]; version: number; framing: OdidFraming } {
  const type = (bytes[0]! >> 4) & 0x0f;
  if (type === OdidMessageType.MessagePack) {
    const msgSize = bytes[1]!;
    const count = bytes[2]!;
    if (msgSize !== ODID_MESSAGE_SIZE) {
      warnings.push(
        `Message pack declares ${msgSize}-byte messages; the standard says ${ODID_MESSAGE_SIZE}.`,
      );
    }
    const messages: OdidMessage[] = [];
    let version = bytes[0]! & 0x0f;
    for (let i = 0; i < count; i++) {
      const start = 3 + i * msgSize;
      if (start + msgSize > bytes.length) {
        warnings.push(
          `Message pack claims ${count} messages but only ${i} fit in ${bytes.length} bytes.`,
        );
        break;
      }
      const d = decodeMessage(bytes.subarray(start, start + msgSize));
      messages.push(d.message);
      version = d.version;
    }
    return { messages, version, framing: "message-pack" };
  }

  if (bytes.length < ODID_MESSAGE_SIZE) {
    warnings.push(
      `Payload is ${bytes.length} bytes, shorter than one ${ODID_MESSAGE_SIZE}-byte message.`,
    );
  }
  const d = decodeMessage(bytes);
  return { messages: [d.message], version: d.version, framing: "bare-message" };
}

/**
 * Decodes one advertisement payload, working out how it was wrapped.
 *
 * Accepts the whole AD structure list, just the service data body, an app-code
 * frame, or a bare message, because which of those ends up in the ndjson depends on
 * the BLE backend rather than on anything in the standard.
 */
export function decodeOdidPayload(input: Uint8Array | string): OdidFrame {
  const bytes = typeof input === "string" ? hexToBytes(input) : input;
  const warnings: string[] = [];
  if (bytes.length === 0) {
    return {
      framing: "bare-message",
      protocolVersion: 0,
      messageCounter: null,
      messages: [],
      warnings: ["Empty payload"],
    };
  }

  // A full AD structure list: [len][type][data...] repeated. Look for service data
  // (0x16) carrying UUID 0xFFFA.
  let p = 0;
  while (p + 1 < bytes.length) {
    const len = bytes[p]!;
    if (len === 0 || p + 1 + len > bytes.length) break;
    const adType = bytes[p + 1]!;
    if (adType === 0x16 && len >= 3) {
      const uuid = uint16le(bytes, p + 2);
      if (uuid === ODID_SERVICE_UUID) {
        const body = bytes.subarray(p + 4, p + 1 + len);
        const inner = decodeOdidServiceData(body);
        return { ...inner, framing: "ad-structures", warnings: [...warnings, ...inner.warnings] };
      }
    }
    p += 1 + len;
  }

  // Service data body still carrying its UUID.
  if (bytes.length >= 3 && uint16le(bytes, 0) === ODID_SERVICE_UUID) {
    const inner = decodeOdidServiceData(bytes.subarray(2));
    return { ...inner, framing: "service-data", warnings: [...warnings, ...inner.warnings] };
  }

  const inner = decodeOdidServiceData(bytes);
  return { ...inner, warnings: [...warnings, ...inner.warnings] };
}

/** The service data body: either `[0x0D][counter][message...]` or a bare message. */
export function decodeOdidServiceData(bytes: Uint8Array): OdidFrame {
  const warnings: string[] = [];
  if (bytes.length === 0) {
    return {
      framing: "bare-message",
      protocolVersion: 0,
      messageCounter: null,
      messages: [],
      warnings: ["Empty service data"],
    };
  }

  if (bytes[0] === ODID_APP_CODE && bytes.length >= 3) {
    const counter = bytes[1]!;
    const rest = bytes.subarray(2);
    const { messages, version, framing } = decodeMessagesFrom(rest, warnings);
    return {
      framing: framing === "message-pack" ? "message-pack" : "app-code",
      protocolVersion: version,
      messageCounter: counter,
      messages,
      warnings,
    };
  }

  const { messages, version, framing } = decodeMessagesFrom(bytes, warnings);
  return {
    framing,
    protocolVersion: version,
    messageCounter: null,
    messages,
    warnings,
  };
}

/**
 * The interpretation dronetag.py arrived at by staring at real payloads, kept so the
 * two can be compared on the same file rather than argued about. It reads `0x0D` as
 * a message type and takes latitude from bytes 4..8, which is what you get if the
 * app code and counter are mistaken for a message header.
 */
export function decodeVendorType13(
  input: Uint8Array | string,
): { latDeg: number | null; lonDeg: number | null } | null {
  const bytes = typeof input === "string" ? hexToBytes(input) : input;
  if (bytes.length < 12 || bytes[0] !== ODID_APP_CODE) return null;
  return {
    latDeg: coordinate(int32le(bytes, 4)),
    lonDeg: coordinate(int32le(bytes, 8)),
  };
}

/**
 * Turns the message's own hour-relative timestamp into an absolute one.
 *
 * The message carries tenths of a second since the last full hour, so the hour has
 * to come from the receiver. Anything more than half an hour away from the host's
 * clock is taken as belonging to the neighbouring hour, which handles a frame that
 * crossed the boundary while it was in flight.
 */
export function resolveOdidTimestamp(
  timestampTenths: number,
  receivedEpochSec: number,
): number {
  const hourStart = Math.floor(receivedEpochSec / 3600) * 3600;
  let t = hourStart + timestampTenths / 10;
  if (t - receivedEpochSec > 1800) t -= 3600;
  else if (receivedEpochSec - t > 1800) t += 3600;
  return t;
}
