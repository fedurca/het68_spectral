import * as secp from "@noble/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import {
  H68P_MAGIC,
  H68P_PARAMS_OFFSET,
  H68P_PAYLOAD_BYTES,
  H68P_TEST_PUBLIC_KEY_HEX,
  H68P_TOTAL_BYTES,
  H68P_VERSION,
  type H68pLicense,
  type H68pUnsigned,
} from "./schema.js";

// noble-secp256k1 v2 leaves sync HMAC unset until the host wires hashes.
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
secp.etc.hmacSha256Async = async (k, ...m) =>
  hmac(sha256, k, secp.etc.concatBytes(...m));

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "").replace(/^0x/i, "");
  if (clean.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function writeU16LE(view: DataView, offset: number, v: number): void {
  view.setUint16(offset, v, true);
}

function writeU32LE(view: DataView, offset: number, v: number): void {
  view.setUint32(offset, v, true);
}

function readU16LE(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** Encode the unsigned payload (no signature). */
export function encodeH68pPayload(u: H68pUnsigned): Uint8Array {
  if (u.chipId.length !== 8) throw new Error("chipId must be 8 bytes");
  if (u.doaParamsFlat.length !== 12) throw new Error("doaParamsFlat must be 12 floats");
  const buf = new Uint8Array(H68P_PAYLOAD_BYTES);
  const view = new DataView(buf.buffer);
  buf[0] = H68P_MAGIC.charCodeAt(0);
  buf[1] = H68P_MAGIC.charCodeAt(1);
  buf[2] = H68P_MAGIC.charCodeAt(2);
  buf[3] = H68P_MAGIC.charCodeAt(3);
  writeU16LE(view, 4, H68P_VERSION);
  buf.set(u.chipId, 6);
  writeU32LE(view, 14, u.expiryEpoch >>> 0);
  writeU32LE(view, 18, u.featureFlags >>> 0);
  writeU16LE(view, 22, 0); // reserved / alignment
  const floats = new Float32Array(buf.buffer, H68P_PARAMS_OFFSET, 12);
  floats.set(u.doaParamsFlat);
  return buf;
}

export function parseH68pBytes(raw: Uint8Array): H68pLicense {
  if (raw.length < H68P_TOTAL_BYTES) {
    throw new Error(`H68P blob too short (${raw.length} < ${H68P_TOTAL_BYTES})`);
  }
  const magic = String.fromCharCode(raw[0]!, raw[1]!, raw[2]!, raw[3]!);
  if (magic !== H68P_MAGIC) throw new Error(`bad magic "${magic}"`);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = readU16LE(view, 4);
  if (version !== H68P_VERSION) throw new Error(`unsupported H68P version ${version}`);
  const chipId = raw.slice(6, 14);
  const expiryEpoch = readU32LE(view, 14);
  const featureFlags = readU32LE(view, 18);
  const doaParamsFlat = new Float32Array(12);
  doaParamsFlat.set(
    new Float32Array(raw.buffer, raw.byteOffset + H68P_PARAMS_OFFSET, 12),
  );
  const signature = raw.slice(H68P_PAYLOAD_BYTES, H68P_TOTAL_BYTES);
  return {
    version,
    chipId,
    chipIdHex: bytesToHex(chipId),
    expiryEpoch,
    featureFlags,
    doaParamsFlat,
    signature,
    raw: raw.slice(0, H68P_TOTAL_BYTES),
  };
}

export function decodeH68pInput(text: string): Uint8Array {
  const t = text.trim();
  if (!t) throw new Error("empty license");
  const hexBody = t.replace(/[\s]/g, "").replace(/^0x/i, "");
  if (/^[0-9a-fA-F]+$/.test(hexBody) && hexBody.length % 2 === 0) {
    return hexToBytes(hexBody);
  }
  const bin = atob(t.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type VerifyResult =
  | { ok: true; license: H68pLicense }
  | { ok: false; error: string };

/**
 * Verify an H68P blob against the analyzer test/public key.
 * Production firmware will use the OTP-provisioned verifying key instead.
 */
export function verifyH68p(
  input: string | Uint8Array,
  opts?: { publicKeyHex?: string; nowEpoch?: number },
): VerifyResult {
  try {
    const raw = typeof input === "string" ? decodeH68pInput(input) : input;
    const license = parseH68pBytes(raw);
    const payload = raw.slice(0, H68P_PAYLOAD_BYTES);
    const pub = hexToBytes(opts?.publicKeyHex ?? H68P_TEST_PUBLIC_KEY_HEX);
    const digest = sha256(payload);
    const ok = secp.verify(license.signature, digest, pub);
    if (!ok) return { ok: false, error: "secp256k1 signature invalid" };
    const now = opts?.nowEpoch ?? Math.floor(Date.now() / 1000);
    if (license.expiryEpoch !== 0 && license.expiryEpoch < now) {
      return { ok: false, error: `license expired at ${license.expiryEpoch}` };
    }
    return { ok: true, license };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Sign an unsigned payload. Private key must be 32-byte hex.
 * Never commit production private keys. Tests use the well-known key
 * `…0001` (generator) or a gitignored file via scripts/gen-fixture.mjs.
 */
export function signH68p(u: H68pUnsigned, privateKeyHex: string): Uint8Array {
  const payload = encodeH68pPayload(u);
  const priv = hexToBytes(privateKeyHex);
  const digest = sha256(payload);
  const sig = secp.sign(digest, priv);
  const out = new Uint8Array(H68P_TOTAL_BYTES);
  out.set(payload, 0);
  out.set(sig.toCompactRawBytes(), H68P_PAYLOAD_BYTES);
  return out;
}

export { bytesToHex, hexToBytes };
