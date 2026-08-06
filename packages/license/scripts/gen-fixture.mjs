#!/usr/bin/env node
/**
 * Generate a signed H68P fixture.
 *
 * Private key sources (first match wins):
 *   1. H68P_TEST_PRIV env (64 hex chars)
 *   2. packages/license/.test-keys/test-priv.hex (gitignored)
 *   3. well-known test key 1 (generator) — analyzer CI only
 *
 * Usage: node scripts/gen-fixture.mjs
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  H68P_FEAT,
  MOCK_CHIPID,
  bytesToHex,
  signH68p,
} from "../src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = join(root, ".test-keys", "test-priv.hex");

function loadPriv() {
  if (process.env.H68P_TEST_PRIV) return process.env.H68P_TEST_PRIV.trim();
  if (existsSync(keyPath)) return readFileSync(keyPath, "utf8").trim();
  return "0000000000000000000000000000000000000000000000000000000000000001";
}

const flat = Float32Array.from([
  384, 343000, 2.5, 0.38, 12, 5.5, 0.28, 6.5, 2.2, 3.0, 0, 1,
]);

const blob = signH68p(
  {
    chipId: MOCK_CHIPID,
    expiryEpoch: 0,
    featureFlags:
      H68P_FEAT.PARAM_IMPORT | H68P_FEAT.DOA_SWEEP | H68P_FEAT.ADVANCED_THRESHOLDS,
    doaParamsFlat: flat,
  },
  loadPriv(),
);

const fixtures = join(root, "src", "__fixtures__");
mkdirSync(fixtures, { recursive: true });
const hex = bytesToHex(blob);
writeFileSync(join(fixtures, "license-valid.hex"), hex + "\n");
console.log("wrote", join(fixtures, "license-valid.hex"), `(${blob.length} bytes)`);
