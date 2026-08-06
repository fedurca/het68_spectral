import { describe, expect, it } from "vitest";
import {
  H68P_FEAT,
  MOCK_CHIPID,
  bytesToHex,
  gateParamImport,
  signH68p,
  verifyH68p,
} from "./index.js";

/** Well-known secp256k1 private key = 1; public key is the generator (see schema). */
const TEST_PRIV =
  "0000000000000000000000000000000000000000000000000000000000000001";

const DEFAULT_FLAT = Float32Array.from([
  384, 343000, 2.5, 0.38, 12, 5.5, 0.28, 6.5, 2.2, 3.0, 0, 1,
]);

describe("H68P", () => {
  it("signs and verifies", () => {
    const blob = signH68p(
      {
        chipId: MOCK_CHIPID,
        expiryEpoch: 0,
        featureFlags: H68P_FEAT.PARAM_IMPORT | H68P_FEAT.ADVANCED_THRESHOLDS,
        doaParamsFlat: DEFAULT_FLAT,
      },
      TEST_PRIV,
    );
    const v = verifyH68p(blob);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.license.chipIdHex).toBe(bytesToHex(MOCK_CHIPID));
      expect(v.license.featureFlags & H68P_FEAT.PARAM_IMPORT).toBeTruthy();
    }
  });

  it("rejects tampered payload", () => {
    const blob = signH68p(
      {
        chipId: MOCK_CHIPID,
        expiryEpoch: 0,
        featureFlags: H68P_FEAT.PARAM_IMPORT,
        doaParamsFlat: DEFAULT_FLAT,
      },
      TEST_PRIV,
    );
    blob[22] = (blob[22] ?? 0) ^ 0xff;
    const v = verifyH68p(blob);
    expect(v.ok).toBe(false);
  });

  it("rejects expired licenses", () => {
    const blob = signH68p(
      {
        chipId: MOCK_CHIPID,
        expiryEpoch: 1,
        featureFlags: H68P_FEAT.PARAM_IMPORT,
        doaParamsFlat: DEFAULT_FLAT,
      },
      TEST_PRIV,
    );
    const v = verifyH68p(blob, { nowEpoch: 100 });
    expect(v.ok).toBe(false);
  });
});

describe("PARAM gate", () => {
  it("allows default re-assert without license", () => {
    const g = gateParamImport("PARAM drone_conf_min=0.28\n", null);
    expect(g.ok).toBe(true);
  });

  it("blocks non-default thresholds without license", () => {
    const g = gateParamImport("PARAM drone_conf_min=0.05\n", null);
    expect(g.ok).toBe(false);
  });

  it("allows non-default with full license", () => {
    const blob = signH68p(
      {
        chipId: MOCK_CHIPID,
        expiryEpoch: 0,
        featureFlags: H68P_FEAT.PARAM_IMPORT | H68P_FEAT.ADVANCED_THRESHOLDS,
        doaParamsFlat: DEFAULT_FLAT,
      },
      TEST_PRIV,
    );
    const v = verifyH68p(blob);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const g = gateParamImport("PARAM drone_conf_min=0.05\n", v.license);
    expect(g.ok).toBe(true);
  });
});
