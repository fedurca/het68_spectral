/*
 * Firmware DOA (doa.c) running in WASM on the loaded audio.
 *
 * Shows the same SRC / TRACKS lines the UART would emit, lets thresholds be
 * edited and re-run, and sweeps one parameter against detection counts. When the
 * buffer is synthetic, reported az/el are compared to the known source angle.
 */

import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  DataTable,
  Empty,
  Field,
  NumberField,
  Panel,
  Readout,
  SelectField,
} from "@het68/ui";
import {
  DEFAULT_DOA_PARAMS,
  doaParamsFromParamText,
  doaParamsToParamText,
  parseDoaSrcLines,
  type DoaParams,
} from "@het68/dsp-core";
import { downloadCsv, downloadText, toCsv } from "@het68/io";
import {
  gateParamImport,
  verifyH68p,
  type H68pLicense,
} from "@het68/license";
import type { Analyzer } from "../state/analyzer.js";

const SWEEP_KEYS = [
  { value: "edge_mm", label: "edge_mm" },
  { value: "drone_conf_min", label: "drone_conf_min" },
  { value: "drone_rms", label: "drone_rms" },
  { value: "drone_crest_max", label: "drone_crest_max" },
  { value: "wind_ratio", label: "wind_ratio" },
  { value: "veh_rms", label: "veh_rms" },
  { value: "bird_rms", label: "bird_rms" },
  { value: "walk_rms", label: "walk_rms" },
] as const;

function angularErrorDeg(a: number, b: number): number {
  const d = ((a - b + 540) % 360) - 180;
  return Math.abs(d);
}

function setParam(p: DoaParams, key: keyof DoaParams, value: number | boolean): DoaParams {
  return { ...p, [key]: value };
}

export function DoaTab({ analyzer }: { analyzer: Analyzer }) {
  const {
    audio,
    doaParams,
    setDoaParams,
    doaResult,
    doaSweep,
    runDoa,
    runDoaSweep,
    appendLog,
    status,
  } = analyzer;

  const [paramText, setParamText] = useState(() => doaParamsToParamText(DEFAULT_DOA_PARAMS));
  const [licenseHex, setLicenseHex] = useState("");
  const [licenseStatus, setLicenseStatus] = useState<string | null>(null);
  const [verifiedLicense, setVerifiedLicense] = useState<H68pLicense | null>(null);
  const [sweepKey, setSweepKey] = useState<string>("drone_conf_min");
  const [sweepFrom, setSweepFrom] = useState(0.15);
  const [sweepTo, setSweepTo] = useState(0.55);
  const [sweepSteps, setSweepSteps] = useState(9);

  const src = useMemo(
    () => (doaResult ? parseDoaSrcLines(doaResult.lines) : []),
    [doaResult],
  );

  const droneSrc = src.filter((s) => s.className === "drone");
  const truth = audio?.synthTruth;

  const compare = useMemo(() => {
    if (!truth || droneSrc.length === 0) return null;
    const best = droneSrc.reduce((a, b) => ((b.conf ?? 0) > (a.conf ?? 0) ? b : a));
    if (best.az == null || best.el == null) return null;
    return {
      reportedAz: best.az,
      reportedEl: best.el,
      conf: best.conf,
      errAz: angularErrorDeg(best.az, truth.azDeg),
      errEl: Math.abs(best.el - truth.elDeg),
    };
  }, [droneSrc, truth]);

  const busy = status.state === "busy";

  const onImportParam = () => {
    const gate = gateParamImport(paramText, verifiedLicense);
    if (!gate.ok) {
      setLicenseStatus(gate.reason);
      appendLog(`PARAM import blocked: ${gate.reason}`);
      return;
    }
    const next = doaParamsFromParamText(paramText, doaParams);
    setDoaParams(next);
    setParamText(doaParamsToParamText(next));
    appendLog("PARAM imported");
    setLicenseStatus(null);
  };

  const onVerifyLicense = () => {
    const v = verifyH68p(licenseHex.trim());
    if (!v.ok) {
      setVerifiedLicense(null);
      setLicenseStatus(v.error);
      appendLog(`H68P verify failed: ${v.error}`);
      return;
    }
    setVerifiedLicense(v.license);
    setLicenseStatus(
      `valid CHIPID=${v.license.chipIdHex} expiry=${new Date(v.license.expiryEpoch * 1000).toISOString()} flags=0x${v.license.featureFlags.toString(16)}`,
    );
    appendLog("H68P license verified");
  };

  const onSweep = () => {
    const n = Math.max(2, Math.min(41, Math.round(sweepSteps)));
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      values.push(sweepFrom + ((sweepTo - sweepFrom) * i) / (n - 1));
    }
    void runDoaSweep(sweepKey, values);
  };

  if (!audio) {
    return (
      <Empty>
        Load a WAV or generate a synthetic scene first. DOA runs on the same buffer the
        spectrogram uses.
      </Empty>
    );
  }

  return (
    <div className="stack">
      <Panel
        title="DOA parameters"
        note="Runtime doa_params_t — same thresholds the firmware will expose via PARAM later."
      >
        <div className="grid-2">
          <NumberField
            label="edge_mm"
            value={doaParams.edgeMm}
            onChange={(v) => setDoaParams(setParam(doaParams, "edgeMm", v))}
          />
          <NumberField
            label="c_mm_s"
            value={doaParams.cMmS}
            onChange={(v) => setDoaParams(setParam(doaParams, "cMmS", v))}
          />
          <NumberField
            label="drone_rms"
            value={doaParams.droneRms}
            step={0.1}
            onChange={(v) => setDoaParams(setParam(doaParams, "droneRms", v))}
          />
          <NumberField
            label="drone_conf_min"
            value={doaParams.droneConfMin}
            step={0.01}
            onChange={(v) => setDoaParams(setParam(doaParams, "droneConfMin", v))}
          />
          <NumberField
            label="drone_crest_max"
            value={doaParams.droneCrestMax}
            step={0.1}
            onChange={(v) => setDoaParams(setParam(doaParams, "droneCrestMax", v))}
          />
          <NumberField
            label="wind_ratio"
            value={doaParams.windRatio}
            step={0.01}
            onChange={(v) => setDoaParams(setParam(doaParams, "windRatio", v))}
          />
          <NumberField
            label="veh_rms"
            value={doaParams.vehRms}
            step={0.1}
            onChange={(v) => setDoaParams(setParam(doaParams, "vehRms", v))}
          />
          <NumberField
            label="bird_rms"
            value={doaParams.birdRms}
            step={0.1}
            onChange={(v) => setDoaParams(setParam(doaParams, "birdRms", v))}
          />
          <NumberField
            label="walk_rms"
            value={doaParams.walkRms}
            step={0.1}
            onChange={(v) => setDoaParams(setParam(doaParams, "walkRms", v))}
          />
          <NumberField
            label="pair_mask"
            value={doaParams.pairMask}
            step={1}
            onChange={(v) => setDoaParams(setParam(doaParams, "pairMask", v >>> 0))}
          />
        </div>
        <div className="btn-row">
          <Button primary disabled={busy} onClick={() => void runDoa()}>
            Re-run DOA
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setDoaParams({ ...DEFAULT_DOA_PARAMS });
              setParamText(doaParamsToParamText(DEFAULT_DOA_PARAMS));
            }}
          >
            Reset defaults
          </Button>
          <Button
            onClick={() => {
              const t = doaParamsToParamText(doaParams);
              setParamText(t);
              downloadText("doa-params.txt", t);
            }}
          >
            Export PARAM
          </Button>
        </div>
      </Panel>

      <Panel title="PARAM import / export" note="Firmware-style PARAM key=value lines.">
        <Field label="PARAM text">
          <textarea
            value={paramText}
            rows={8}
            spellCheck={false}
            onChange={(e) => setParamText(e.target.value)}
            style={{ width: "100%", fontFamily: "var(--font-mono, monospace)", fontSize: "0.8rem" }}
          />
        </Field>
        <div className="btn-row">
          <Button onClick={onImportParam}>Import PARAM</Button>
          <Button onClick={() => setParamText(doaParamsToParamText(doaParams))}>
            Fill from current
          </Button>
        </div>
      </Panel>

      <Panel
        title="H68P license"
        note="Signed PARAM snapshots. Tampered blobs fail verify; PARAM import that alters protected thresholds needs a valid license when the gate is on."
      >
        <Field label="License (hex or base64)">
          <textarea
            value={licenseHex}
            rows={4}
            spellCheck={false}
            onChange={(e) => setLicenseHex(e.target.value)}
            style={{ width: "100%", fontFamily: "var(--font-mono, monospace)", fontSize: "0.8rem" }}
          />
        </Field>
        <div className="btn-row">
          <Button onClick={onVerifyLicense}>Verify H68P</Button>
          {verifiedLicense ? <Badge tone="ok">license OK</Badge> : <Badge>no license</Badge>}
        </div>
        {licenseStatus ? (
          <Readout rows={[["status", licenseStatus]]} />
        ) : null}
      </Panel>

      <Panel title="SRC / DET / TRACKS" note="UART-style lines from the host shim (SRC, DET, TRACKS, ENTITY).">
        {doaResult ? (
          <>
            <div className="btn-row">
              <Badge tone="ok">drones {doaResult.ndrone}</Badge>
              <Badge>vehicles {doaResult.nvehicle}</Badge>
              <Badge>birds {doaResult.nbird}</Badge>
              <Badge>walkers {doaResult.nwalker}</Badge>
              {doaResult.wind ? (
                <Badge tone="warn">
                  wind az {doaResult.windAz.toFixed(1)} el {doaResult.windEl.toFixed(1)}
                </Badge>
              ) : null}
            </div>
            <Readout
              rows={[
                ...(truth
                  ? [
                      [
                        "synth truth",
                        `az ${truth.azDeg.toFixed(1)}° el ${truth.elDeg.toFixed(1)}° @ ${truth.distanceM.toFixed(1)} m`,
                      ] as [string, string],
                    ]
                  : []),
                ...(compare
                  ? [
                      [
                        "vs truth",
                        `az ${compare.reportedAz.toFixed(1)} el ${compare.reportedEl.toFixed(1)} · |Δaz| ${compare.errAz.toFixed(1)}° |Δel| ${compare.errEl.toFixed(1)}°`,
                      ] as [string, string],
                    ]
                  : []),
              ]}
            />
            <DataTable
              keyOf={(r) => r.raw}
              columns={[
                { key: "class", label: "class", render: (r) => r.className },
                {
                  key: "az",
                  label: "az",
                  render: (r) => (r.az == null ? "—" : r.az.toFixed(1)),
                },
                {
                  key: "el",
                  label: "el",
                  render: (r) => (r.el == null ? "—" : r.el.toFixed(1)),
                },
                {
                  key: "conf",
                  label: "conf",
                  render: (r) => (r.conf == null ? "—" : r.conf.toFixed(2)),
                },
                { key: "raw", label: "line", render: (r) => r.raw },
              ]}
              rows={
                src.length > 0
                  ? src
                  : [{ className: "—", az: null, el: null, conf: null, raw: "(no SRC lines)" }]
              }
            />
            <details>
              <summary>All lines ({doaResult.lines.length})</summary>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.75rem" }}>
                {doaResult.lines.join("\n")}
              </pre>
            </details>
            <Button
              onClick={() =>
                downloadText("doa-lines.txt", doaResult.lines.join("\n") + "\n")
              }
            >
              Export lines
            </Button>
          </>
        ) : (
          <Empty>Press Re-run DOA on the loaded buffer.</Empty>
        )}
      </Panel>

      <Panel
        title="1D parameter sweep"
        note="Metric is drone track count and whether any SRC class=drone line appeared."
      >
        <SelectField
          label="Parameter"
          value={sweepKey}
          options={SWEEP_KEYS.map((k) => ({ value: k.value, label: k.label }))}
          onChange={setSweepKey}
        />
        <div className="grid-2">
          <NumberField label="From" value={sweepFrom} onChange={setSweepFrom} step={0.01} />
          <NumberField label="To" value={sweepTo} onChange={setSweepTo} step={0.01} />
          <NumberField
            label="Steps"
            value={sweepSteps}
            min={2}
            max={41}
            step={1}
            onChange={setSweepSteps}
          />
        </div>
        <div className="btn-row">
          <Button primary disabled={busy} onClick={onSweep}>
            Run sweep
          </Button>
          {doaSweep ? (
            <Button
              onClick={() => {
                const rows = doaSweep.points.map((p) => {
                  const srcLines = parseDoaSrcLines(p.result.lines);
                  const drone = srcLines.find((s) => s.className === "drone");
                  let errAz: number | "" = "";
                  if (truth && drone?.az != null) {
                    errAz = angularErrorDeg(drone.az, truth.azDeg);
                  }
                  return {
                    [doaSweep.sweepKey]: p.value,
                    ndrone: p.result.ndrone,
                    has_src_drone: srcLines.some((s) => s.className === "drone") ? 1 : 0,
                    az: drone?.az ?? "",
                    el: drone?.el ?? "",
                    conf: drone?.conf ?? "",
                    err_az_deg: errAz,
                  };
                });
                downloadCsv(`doa-sweep-${doaSweep.sweepKey}.csv`, toCsv(rows));
              }}
            >
              Export CSV
            </Button>
          ) : null}
        </div>
        {doaSweep ? (
          <DataTable
            keyOf={(r) => String(r.value)}
            columns={[
              {
                key: "value",
                label: doaSweep.sweepKey,
                render: (r) =>
                  typeof r.value === "number" ? r.value.toFixed(4) : String(r.value),
              },
              { key: "ndrone", label: "ndrone", render: (r) => r.ndrone },
              { key: "nvehicle", label: "nvehicle", render: (r) => r.nvehicle },
              { key: "lines", label: "lines", render: (r) => r.lines },
            ]}
            rows={doaSweep.points.map((p) => ({
              value: p.value,
              ndrone: p.result.ndrone,
              nvehicle: p.result.nvehicle,
              lines: p.result.lines.length,
            }))}
          />
        ) : null}
      </Panel>
    </div>
  );
}
