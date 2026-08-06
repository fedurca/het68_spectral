/*
 * Ground truth from a Dronetag Mini.
 *
 * Reads the adv_payloads.ndjson that het68/dronetag.py writes, decodes the raw hex
 * with the ODID decoder in odid.ts, and turns the result into azimuth and elevation
 * as seen from the cube, on the recording's own timeline.
 *
 * The thing worth keeping in mind while reading this: GNSS is never better than the
 * array. Three metres of horizontal error is 17 degrees at 10 m and still 1.7
 * degrees at 100 m, against an angular resolution of 1.07 degrees. So every error
 * figure this module produces is reported alongside the accuracy ceiling that made
 * it, and close-range truth has to come from a tape measure instead.
 */

import {
  OdidMessageType,
  decodeOdidPayload,
  resolveOdidTimestamp,
  type OdidBasicId,
  type OdidFrame,
  type OdidLocation,
} from "./odid.js";

export interface AdvRecord {
  /** Host receive time, epoch seconds. Useful only as a sanity check. */
  receivedEpochSec: number;
  address: string | null;
  rssiDbm: number | null;
  payloadHex: string;
  lineNumber: number;
}

export interface OdidFix {
  /** Epoch seconds from the message's own timestamp where it had one. */
  epochSec: number;
  /** True when epochSec came from the host clock because the message had none. */
  timeFromHost: boolean;
  receivedEpochSec: number;
  latDeg: number;
  lonDeg: number;
  /** Height above take-off where reported, otherwise geodetic altitude. */
  heightM: number | null;
  heightIsAboveTakeoff: boolean;
  altitudeGeodeticM: number | null;
  speedMps: number | null;
  verticalSpeedMps: number | null;
  trackDeg: number | null;
  horizontalAccuracyM: number | null;
  verticalAccuracyM: number | null;
  statusName: string;
  address: string | null;
  rssiDbm: number | null;
}

export interface NdjsonParseResult {
  records: AdvRecord[];
  warnings: string[];
  /** Lines that were not JSON or carried no payload. */
  skipped: number;
}

export interface OdidDecodeResult {
  fixes: OdidFix[];
  basicIds: OdidBasicId[];
  frames: OdidFrame[];
  warnings: string[];
  /** Counter gaps, which is the honest measure of how much BLE was dropped. */
  droppedFrames: number;
  framingCounts: Record<string, number>;
}

const PAYLOAD_KEYS = ["payload", "hex", "data", "adv", "raw", "service_data"];
const TIME_KEYS = ["t", "time", "ts", "timestamp", "epoch", "rx_time"];
const ADDRESS_KEYS = ["addr", "address", "mac", "device", "bdaddr"];
const RSSI_KEYS = ["rssi", "rssi_dbm"];

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (k in obj && obj[k] !== null && obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

/**
 * Reads adv_payloads.ndjson. Key names are matched loosely because the file is a
 * debug dump rather than an interface, and it should not need a schema migration
 * every time the scanner is edited.
 */
export function parseAdvPayloadsNdjson(text: string): NdjsonParseResult {
  const records: AdvRecord[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      skipped++;
      if (warnings.length < 10) warnings.push(`Line ${i + 1} is not valid JSON.`);
      continue;
    }

    const payload = pick(obj, PAYLOAD_KEYS);
    if (typeof payload !== "string" || payload === "") {
      skipped++;
      continue;
    }

    const rawTime = pick(obj, TIME_KEYS);
    let receivedEpochSec = NaN;
    if (typeof rawTime === "number") {
      // Some writers use milliseconds; a plain epoch in seconds cannot be that big
      // until the year 33658.
      receivedEpochSec = rawTime > 1e11 ? rawTime / 1000 : rawTime;
    } else if (typeof rawTime === "string") {
      const ms = Date.parse(rawTime);
      if (!Number.isNaN(ms)) receivedEpochSec = ms / 1000;
    }
    if (!Number.isFinite(receivedEpochSec)) {
      if (warnings.length < 10) {
        warnings.push(`Line ${i + 1} has no usable receive time; message timestamps cannot be resolved.`);
      }
      receivedEpochSec = NaN;
    }

    const addr = pick(obj, ADDRESS_KEYS);
    const rssi = pick(obj, RSSI_KEYS);

    records.push({
      receivedEpochSec,
      address: typeof addr === "string" ? addr : null,
      rssiDbm: typeof rssi === "number" ? rssi : null,
      payloadHex: payload,
      lineNumber: i + 1,
    });
  }

  return { records, warnings, skipped };
}

/** Decodes every record, keeping Location messages as fixes. */
export function decodeAdvRecords(records: AdvRecord[]): OdidDecodeResult {
  const fixes: OdidFix[] = [];
  const basicIds: OdidBasicId[] = [];
  const frames: OdidFrame[] = [];
  const warnings: string[] = [];
  const framingCounts: Record<string, number> = {};
  const seenIds = new Set<string>();

  let lastCounter: number | null = null;
  let droppedFrames = 0;

  for (const rec of records) {
    let frame: OdidFrame;
    try {
      frame = decodeOdidPayload(rec.payloadHex);
    } catch (err) {
      if (warnings.length < 20) {
        warnings.push(`Line ${rec.lineNumber}: ${(err as Error).message}`);
      }
      continue;
    }
    frames.push(frame);
    framingCounts[frame.framing] = (framingCounts[frame.framing] ?? 0) + 1;

    if (frame.messageCounter !== null) {
      if (lastCounter !== null) {
        const gap = (frame.messageCounter - lastCounter + 256) % 256;
        if (gap > 1) droppedFrames += gap - 1;
      }
      lastCounter = frame.messageCounter;
    }

    for (const msg of frame.messages) {
      if (msg.type === OdidMessageType.BasicId) {
        const b = msg as OdidBasicId;
        if (b.uasId && !seenIds.has(b.uasId)) {
          seenIds.add(b.uasId);
          basicIds.push(b);
        }
        continue;
      }
      if (msg.type !== OdidMessageType.Location) continue;

      const loc = msg as OdidLocation;
      if (loc.latDeg === null || loc.lonDeg === null) continue;

      const hasOwnTime =
        loc.timestampTenths !== null && Number.isFinite(rec.receivedEpochSec);
      const epochSec = hasOwnTime
        ? resolveOdidTimestamp(loc.timestampTenths!, rec.receivedEpochSec)
        : rec.receivedEpochSec;
      if (!Number.isFinite(epochSec)) continue;

      fixes.push({
        epochSec,
        timeFromHost: !hasOwnTime,
        receivedEpochSec: rec.receivedEpochSec,
        latDeg: loc.latDeg,
        lonDeg: loc.lonDeg,
        heightM: loc.heightM ?? loc.altitudeGeodeticM,
        heightIsAboveTakeoff: loc.heightM !== null && loc.heightIsAboveTakeoff,
        altitudeGeodeticM: loc.altitudeGeodeticM,
        speedMps: loc.speedMps,
        verticalSpeedMps: loc.verticalSpeedMps,
        trackDeg: loc.trackDeg,
        horizontalAccuracyM: loc.horizontalAccuracyM,
        verticalAccuracyM: loc.verticalAccuracyM,
        statusName: loc.statusName,
        address: rec.address,
        rssiDbm: rec.rssiDbm,
      });
    }
  }

  fixes.sort((a, b) => a.epochSec - b.epochSec);

  const hostTimed = fixes.filter((f) => f.timeFromHost).length;
  if (hostTimed > 0) {
    warnings.push(
      `${hostTimed} of ${fixes.length} fixes had no message timestamp and fall back to host receive time; at 12 m/s the scan jitter alone is several metres.`,
    );
  }

  return { fixes, basicIds, frames, warnings, droppedFrames, framingCounts };
}

// ---- geodesy -------------------------------------------------------------

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees true. */
export function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

export interface CubeReference {
  latDeg: number;
  lonDeg: number;
  /** Height of the cube above the drone's take-off point, metres. */
  heightAboveTakeoffM: number;
  /**
   * Compass bearing microphone 1 faces. Array azimuth 0 is microphone 1, so a cube
   * that was not set down facing north rotates every reported angle.
   */
  micOneBearingDeg: number;
}

export interface AzElPoint {
  epochSec: number;
  /** Degrees in the array's own frame: 0 is microphone 1, increasing anticlockwise. */
  azDeg: number;
  elDeg: number;
  /** Degrees true, before the cube's orientation is taken out. */
  bearingDeg: number;
  slantRangeM: number;
  groundRangeM: number;
  heightAboveCubeM: number;
  /** atan(horizontal accuracy / range), the best the truth can be at this range. */
  angularCeilingDeg: number;
  timeFromHost: boolean;
}

/**
 * Where the aircraft was, as the array would have to see it.
 *
 * Height above take-off is preferred over geodetic altitude because GNSS vertical
 * error is 1.5 to 2 times the horizontal figure, while the take-off reference
 * cancels most of it — provided the height difference between the launch point and
 * the cube has been measured, which is what `heightAboveTakeoffM` is for.
 */
export function fixToAzEl(fix: OdidFix, cube: CubeReference): AzElPoint {
  const groundRangeM = haversineM(cube.latDeg, cube.lonDeg, fix.latDeg, fix.lonDeg);
  const trueBearing = bearingDeg(cube.latDeg, cube.lonDeg, fix.latDeg, fix.lonDeg);

  const droneHeight = fix.heightM ?? 0;
  const heightAboveCubeM = fix.heightIsAboveTakeoff
    ? droneHeight - cube.heightAboveTakeoffM
    : droneHeight - cube.heightAboveTakeoffM;

  const slantRangeM = Math.hypot(groundRangeM, heightAboveCubeM);
  const elDeg = Math.atan2(heightAboveCubeM, groundRangeM) / DEG;

  // Compass bearings run clockwise from north; the array's azimuth runs
  // anticlockwise from microphone 1, so the sign flips as well as the origin.
  const azDeg = (((cube.micOneBearingDeg - trueBearing) % 360) + 360) % 360;

  const accuracy = fix.horizontalAccuracyM ?? 3;
  const angularCeilingDeg =
    slantRangeM > 0 ? Math.atan(accuracy / slantRangeM) / DEG : 90;

  return {
    epochSec: fix.epochSec,
    azDeg,
    elDeg,
    bearingDeg: trueBearing,
    slantRangeM,
    groundRangeM,
    heightAboveCubeM,
    angularCeilingDeg,
    timeFromHost: fix.timeFromHost,
  };
}

export function fixesToTrack(fixes: OdidFix[], cube: CubeReference): AzElPoint[] {
  return fixes.map((f) => fixToAzEl(f, cube));
}

/** Shortest signed difference between two angles, degrees. */
export function angleDiffDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * Track position at an arbitrary time, interpolated.
 *
 * The array produces a direction five times a second and the Mini advertises at 1 to
 * 4 Hz, so comparing them at all means interpolating one onto the other. Azimuth is
 * interpolated the short way round so a track crossing the wrap point does not spin
 * through 359 degrees.
 */
export function interpolateTrack(
  track: AzElPoint[],
  epochSec: number,
  maxGapSec = 3,
): AzElPoint | null {
  if (track.length === 0) return null;
  if (epochSec < track[0]!.epochSec - maxGapSec) return null;
  if (epochSec > track[track.length - 1]!.epochSec + maxGapSec) return null;

  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid]!.epochSec <= epochSec) lo = mid;
    else hi = mid;
  }
  const a = track[lo]!;
  const b = track[hi]!;
  const span = b.epochSec - a.epochSec;
  if (span <= 0) return a;
  if (span > maxGapSec) {
    // A hole this long is a dropout, not a trajectory. Say so by returning nothing
    // rather than drawing a straight line through it.
    return null;
  }
  const u = Math.min(1, Math.max(0, (epochSec - a.epochSec) / span));
  const lerp = (x: number, y: number) => x + (y - x) * u;

  return {
    epochSec,
    azDeg: (((a.azDeg + angleDiffDeg(b.azDeg, a.azDeg) * u) % 360) + 360) % 360,
    elDeg: lerp(a.elDeg, b.elDeg),
    bearingDeg:
      (((a.bearingDeg + angleDiffDeg(b.bearingDeg, a.bearingDeg) * u) % 360) + 360) %
      360,
    slantRangeM: lerp(a.slantRangeM, b.slantRangeM),
    groundRangeM: lerp(a.groundRangeM, b.groundRangeM),
    heightAboveCubeM: lerp(a.heightAboveCubeM, b.heightAboveCubeM),
    angularCeilingDeg: lerp(a.angularCeilingDeg, b.angularCeilingDeg),
    timeFromHost: a.timeFromHost || b.timeFromHost,
  };
}

export interface AngularError {
  epochSec: number;
  measuredAzDeg: number;
  measuredElDeg: number;
  truthAzDeg: number;
  truthElDeg: number;
  azErrorDeg: number;
  elErrorDeg: number;
  /** Great-circle angle between the two directions, which is the honest total. */
  totalErrorDeg: number;
  /** Error this size or below cannot be told from GNSS noise at this range. */
  ceilingDeg: number;
  withinCeiling: boolean;
  rangeM: number;
}

/** Angle between two directions on the sphere. */
export function separationDeg(
  az1: number,
  el1: number,
  az2: number,
  el2: number,
): number {
  const toVec = (az: number, el: number) => {
    const a = az * DEG;
    const e = el * DEG;
    return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
  };
  const [x1, y1, z1] = toVec(az1, el1);
  const [x2, y2, z2] = toVec(az2, el2);
  const dot = Math.min(1, Math.max(-1, x1! * x2! + y1! * y2! + z1! * z2!));
  return Math.acos(dot) / DEG;
}

export interface Measurement {
  epochSec: number;
  azDeg: number;
  elDeg: number;
}

export interface ErrorSummary {
  errors: AngularError[];
  /** Fraction of measurements that fell inside the GNSS ceiling. */
  withinCeilingFraction: number;
  medianTotalDeg: number;
  p90TotalDeg: number;
  meanCeilingDeg: number;
  /** Measurements with no truth to compare against, usually BLE dropouts. */
  unmatched: number;
}

/**
 * Compares what the array said against the track.
 *
 * Every row carries the ceiling that applied at its range, because below about 30 m
 * the ground truth is worse than the thing being measured and an "error" there says
 * more about GNSS than about the array.
 */
export function angularErrorSeries(
  measurements: Measurement[],
  track: AzElPoint[],
  maxGapSec = 3,
): ErrorSummary {
  const errors: AngularError[] = [];
  let unmatched = 0;

  for (const m of measurements) {
    const truth = interpolateTrack(track, m.epochSec, maxGapSec);
    if (!truth) {
      unmatched++;
      continue;
    }
    const total = separationDeg(m.azDeg, m.elDeg, truth.azDeg, truth.elDeg);
    errors.push({
      epochSec: m.epochSec,
      measuredAzDeg: m.azDeg,
      measuredElDeg: m.elDeg,
      truthAzDeg: truth.azDeg,
      truthElDeg: truth.elDeg,
      azErrorDeg: angleDiffDeg(m.azDeg, truth.azDeg),
      elErrorDeg: m.elDeg - truth.elDeg,
      totalErrorDeg: total,
      ceilingDeg: truth.angularCeilingDeg,
      withinCeiling: total <= truth.angularCeilingDeg,
      rangeM: truth.slantRangeM,
    });
  }

  const sorted = errors.map((e) => e.totalErrorDeg).sort((a, b) => a - b);
  const quantile = (q: number) =>
    sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

  return {
    errors,
    withinCeilingFraction:
      errors.length === 0
        ? 0
        : errors.filter((e) => e.withinCeiling).length / errors.length,
    medianTotalDeg: quantile(0.5),
    p90TotalDeg: quantile(0.9),
    meanCeilingDeg:
      errors.length === 0
        ? 0
        : errors.reduce((s, e) => s + e.ceilingDeg, 0) / errors.length,
    unmatched,
  };
}

/** The ceiling on its own, for drawing the "GNSS cannot see this" band on a plot. */
export function gnssAngularCeilingDeg(rangeM: number, accuracyM = 3): number {
  if (rangeM <= 0) return 90;
  return Math.atan(accuracyM / rangeM) / DEG;
}
