/**
 * H68P — signed het68 parameter / feature license blob.
 *
 * Layout (little-endian):
 *   magic[4]        = "H68P"
 *   version u16     = 1
 *   chipId[8]       = device CHIPID (or mock in analyzer)
 *   expiryEpoch u32 = unix seconds; 0 = no expiry
 *   featureFlags u32
 *   reserved u16    = 0 (aligns doaParams to a 4-byte boundary)
 *   doaParams[12] f32 — flat layout matching doa_params_t host encoding
 *   signature[64]   = secp256k1 compact signature over the preceding bytes
 *
 * The production signing key never lives in this repo. Tests and CI use a
 * dedicated test keypair; the private half is gitignored.
 */

export const H68P_MAGIC = "H68P";
export const H68P_VERSION = 1;
/** Bytes before the signature (floats start at offset 24). */
export const H68P_PAYLOAD_BYTES = 4 + 2 + 8 + 4 + 4 + 2 + 12 * 4; // 72
export const H68P_TOTAL_BYTES = H68P_PAYLOAD_BYTES + 64; // 136
export const H68P_PARAMS_OFFSET = 24;

/** Feature flag bits. */
export const H68P_FEAT = {
  PARAM_IMPORT: 1 << 0,
  DOA_SWEEP: 1 << 1,
  ADVANCED_THRESHOLDS: 1 << 2,
} as const;

export interface H68pLicense {
  version: number;
  chipId: Uint8Array;
  chipIdHex: string;
  expiryEpoch: number;
  featureFlags: number;
  /** Flat 12 floats matching doa host encoding. */
  doaParamsFlat: Float32Array;
  signature: Uint8Array;
  raw: Uint8Array;
}

export interface H68pUnsigned {
  chipId: Uint8Array;
  expiryEpoch: number;
  featureFlags: number;
  doaParamsFlat: Float32Array;
}

/** Analyzer-side mock CHIPID used when no hardware is attached. */
export const MOCK_CHIPID = new Uint8Array([
  0x68, 0x68, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef,
]);

/** Analyzer-side mock RANDID placeholder (not used in verify, documented for firmware). */
export const MOCK_RANDID = new Uint8Array([
  0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18,
]);

/**
 * Test / CI verifying public key (secp256k1 uncompressed, 65 bytes 0x04||X||Y).
 * Paired with packages/license/.test-keys/test-priv.hex (gitignored).
 * Generated once for fixtures — not a production key.
 */
export const H68P_TEST_PUBLIC_KEY_HEX =
  "04" +
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
  "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
