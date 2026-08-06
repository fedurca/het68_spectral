import { H68P_FEAT, type H68pLicense } from "./schema.js";

export type GateResult = { ok: true } | { ok: false; reason: string };

/**
 * PARAM import gate.
 *
 * Cosmetic / geometry keys (edge_mm, c_mm_s, log, pair_mask) always import.
 * Changing classification thresholds requires a verified license with
 * PARAM_IMPORT; values other than the firmware defaults also need
 * ADVANCED_THRESHOLDS.
 */
const DEFAULTS: Record<string, number> = {
  drone_rms: 2.5,
  wind_ratio: 0.38,
  wind_rms_min: 12,
  drone_crest_max: 5.5,
  drone_conf_min: 0.28,
  veh_rms: 6.5,
  bird_rms: 2.2,
  walk_rms: 3.0,
};

const PROTECTED = new Set(Object.keys(DEFAULTS));

function parseProtected(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.replace(/^PARAM\s+/i, "");
    const eq = body.indexOf("=");
    if (eq < 0) continue;
    const key = body.slice(0, eq).trim();
    if (!PROTECTED.has(key)) continue;
    const num = Number(body.slice(eq + 1).trim());
    if (Number.isFinite(num)) out.set(key, num);
  }
  return out;
}

export function gateParamImport(
  paramText: string,
  license: H68pLicense | null,
  opts?: { requireLicenseForProtected?: boolean },
): GateResult {
  const requireLicense = opts?.requireLicenseForProtected ?? true;
  const parsed = parseProtected(paramText);
  if (parsed.size === 0) return { ok: true };
  if (!requireLicense) return { ok: true };

  let nonDefault = false;
  for (const [k, v] of parsed) {
    if (DEFAULTS[k] !== v) nonDefault = true;
  }

  // Re-asserting firmware defaults does not need a license.
  if (!nonDefault) return { ok: true };

  if (!license) {
    return {
      ok: false,
      reason: "PARAM changes protected thresholds; verify an H68P license first",
    };
  }
  if ((license.featureFlags & H68P_FEAT.PARAM_IMPORT) === 0) {
    return { ok: false, reason: "license missing PARAM_IMPORT feature flag" };
  }
  if ((license.featureFlags & H68P_FEAT.ADVANCED_THRESHOLDS) === 0) {
    return {
      ok: false,
      reason: "license missing ADVANCED_THRESHOLDS for non-default thresholds",
    };
  }
  return { ok: true };
}
