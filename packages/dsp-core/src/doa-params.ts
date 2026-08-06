/** Runtime parameters for the host/WASM DOA engine (mirrors doa_params_t). */
export interface DoaParams {
  edgeMm: number;
  cMmS: number;
  droneRms: number;
  windRatio: number;
  windRmsMin: number;
  droneCrestMax: number;
  droneConfMin: number;
  vehRms: number;
  birdRms: number;
  walkRms: number;
  pairMask: number;
  logEnabled: boolean;
}

export const DEFAULT_DOA_PARAMS: DoaParams = {
  edgeMm: 384,
  cMmS: 343000,
  droneRms: 2.5,
  windRatio: 0.38,
  windRmsMin: 12,
  droneCrestMax: 5.5,
  droneConfMin: 0.28,
  vehRms: 6.5,
  birdRms: 2.2,
  walkRms: 3.0,
  pairMask: 0,
  logEnabled: true,
};

/** Serialize params as firmware-style PARAM key=value lines. */
export function doaParamsToParamText(p: DoaParams): string {
  const rows: [string, string | number][] = [
    ["edge_mm", p.edgeMm],
    ["c_mm_s", p.cMmS],
    ["drone_rms", p.droneRms],
    ["wind_ratio", p.windRatio],
    ["wind_rms_min", p.windRmsMin],
    ["drone_crest_max", p.droneCrestMax],
    ["drone_conf_min", p.droneConfMin],
    ["veh_rms", p.vehRms],
    ["bird_rms", p.birdRms],
    ["walk_rms", p.walkRms],
    ["pair_mask", p.pairMask],
    ["log", p.logEnabled ? 1 : 0],
  ];
  return rows.map(([k, v]) => `PARAM ${k}=${v}`).join("\n") + "\n";
}

/** Parse PARAM lines; unknown keys are ignored. */
export function doaParamsFromParamText(text: string, base = DEFAULT_DOA_PARAMS): DoaParams {
  const p = { ...base };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.replace(/^PARAM\s+/i, "");
    const eq = body.indexOf("=");
    if (eq < 0) continue;
    const key = body.slice(0, eq).trim();
    const val = body.slice(eq + 1).trim();
    const num = Number(val);
    switch (key) {
      case "edge_mm":
        if (Number.isFinite(num)) p.edgeMm = num;
        break;
      case "c_mm_s":
        if (Number.isFinite(num)) p.cMmS = num;
        break;
      case "drone_rms":
        if (Number.isFinite(num)) p.droneRms = num;
        break;
      case "wind_ratio":
        if (Number.isFinite(num)) p.windRatio = num;
        break;
      case "wind_rms_min":
        if (Number.isFinite(num)) p.windRmsMin = num;
        break;
      case "drone_crest_max":
        if (Number.isFinite(num)) p.droneCrestMax = num;
        break;
      case "drone_conf_min":
        if (Number.isFinite(num)) p.droneConfMin = num;
        break;
      case "veh_rms":
        if (Number.isFinite(num)) p.vehRms = num;
        break;
      case "bird_rms":
        if (Number.isFinite(num)) p.birdRms = num;
        break;
      case "walk_rms":
        if (Number.isFinite(num)) p.walkRms = num;
        break;
      case "pair_mask":
        if (Number.isFinite(num)) p.pairMask = num >>> 0;
        break;
      case "log":
        p.logEnabled = val === "1" || val.toLowerCase() === "true";
        break;
      default:
        break;
    }
  }
  return p;
}

export interface DoaRunResult {
  lines: string[];
  ndrone: number;
  nvehicle: number;
  nbird: number;
  nwalker: number;
  wind: boolean;
  windAz: number;
  windEl: number;
}

export interface DoaSrcLine {
  className: string;
  az: number | null;
  el: number | null;
  conf: number | null;
  raw: string;
}

/** Parse firmware-style `SRC class=… az=… el=…` lines from doa_host_drain_lines. */
export function parseDoaSrcLines(lines: readonly string[]): DoaSrcLine[] {
  const out: DoaSrcLine[] = [];
  for (const raw of lines) {
    if (!raw.startsWith("SRC ")) continue;
    const classMatch = /class=(\S+)/.exec(raw);
    const az = /(?:^|\s)az=([-+0-9.eE]+)/.exec(raw);
    const el = /(?:^|\s)el=([-+0-9.eE]+)/.exec(raw);
    const conf = /(?:^|\s)conf=([-+0-9.eE]+)/.exec(raw);
    out.push({
      className: classMatch?.[1] ?? "?",
      az: az ? Number(az[1]) : null,
      el: el ? Number(el[1]) : null,
      conf: conf ? Number(conf[1]) : null,
      raw,
    });
  }
  return out;
}

export interface DoaSweepPoint {
  value: number;
  ndrone: number;
  lines: string[];
}
