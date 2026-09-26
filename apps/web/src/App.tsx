import { useEffect, useState } from "react";
import { Badge } from "@het68/ui";
import { loadBuildInfo, type BuildInfo } from "./buildinfo.js";
import { TabBoundary } from "./TabBoundary.js";
import { useAnalyzer } from "./state/analyzer.js";
import { SourcePanel } from "./panels/SourcePanel.js";
import { GeometryPanel } from "./panels/GeometryPanel.js";
import { StftPanel } from "./panels/StftPanel.js";
import { SpectrogramTab } from "./panels/SpectrogramTab.js";
import { BandsTab } from "./panels/BandsTab.js";
import { PairsTab } from "./panels/PairsTab.js";
import { HealthTab } from "./panels/HealthTab.js";
import { SignatureTab } from "./panels/SignatureTab.js";
import { GroundTruthTab } from "./panels/GroundTruthTab.js";
import { LiveTab } from "./panels/LiveTab.js";
import { DoaTab } from "./panels/DoaTab.js";
import { TonePositionTab } from "./panels/TonePositionTab.js";
import { DebugTab } from "./panels/DebugTab.js";

const TABS = [
  { id: "spectrogram", label: "Spectrograms" },
  { id: "bands", label: "Bands" },
  { id: "pairs", label: "Microphone differences" },
  { id: "health", label: "Array health" },
  { id: "signature", label: "Drone signatures" },
  { id: "doa", label: "DOA" },
  { id: "tone", label: "2 kHz position" },
  { id: "truth", label: "Ground truth" },
  { id: "live", label: "Live input" },
  { id: "debug", label: "Debug" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function App() {
  const analyzer = useAnalyzer();
  const [tab, setTab] = useState<TabId>("spectrogram");
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [gpuBytes, setGpuBytes] = useState(0);

  useEffect(() => {
    void loadBuildInfo().then(setBuild);
  }, []);

  const { status, audio, stft, init, timings } = analyzer;
  const lastTiming = timings.length > 0 ? timings[timings.length - 1] : null;

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">
          het68 spectral
          <small>detection cube spectrogram analyzer</small>
        </span>
        <span className="app-header-spacer" />

        {audio ? (
          <Badge tone="ok" title={`${audio.kind} source`}>
            {audio.name} · {audio.channels} ch · {audio.sampleRate} Hz ·{" "}
            {audio.durationSec.toFixed(2)} s
          </Badge>
        ) : (
          <Badge>no audio loaded</Badge>
        )}

        {status.state === "busy" ? (
          <Badge tone="warn">working: {status.what}</Badge>
        ) : status.state === "error" ? (
          <Badge tone="error" title={status.message}>
            {status.what} failed
          </Badge>
        ) : (
          <Badge tone="ok">idle</Badge>
        )}
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="app-body">
        <aside className="sidebar">
          <SourcePanel analyzer={analyzer} />
          <GeometryPanel analyzer={analyzer} />
          <StftPanel analyzer={analyzer} />
        </aside>

        <main className="main">
          {status.state === "error" ? (
            <div className="finding" data-severity="error">
              <strong>{status.what}</strong>
              <span>{status.message}</span>
            </div>
          ) : null}

          <TabBoundary tab={TABS.find((t) => t.id === tab)!.label}>
            {tab === "spectrogram" ? (
              <SpectrogramTab analyzer={analyzer} onGpuBytes={setGpuBytes} />
            ) : null}
            {tab === "bands" ? <BandsTab analyzer={analyzer} /> : null}
            {tab === "pairs" ? <PairsTab analyzer={analyzer} /> : null}
            {tab === "health" ? <HealthTab analyzer={analyzer} /> : null}
            {tab === "signature" ? <SignatureTab analyzer={analyzer} /> : null}
            {tab === "doa" ? <DoaTab analyzer={analyzer} /> : null}
            {tab === "tone" ? <TonePositionTab analyzer={analyzer} /> : null}
            {tab === "truth" ? <GroundTruthTab analyzer={analyzer} /> : null}
            {tab === "live" ? <LiveTab analyzer={analyzer} /> : null}
            {tab === "debug" ? (
              <DebugTab analyzer={analyzer} build={build} gpuBytes={gpuBytes} />
            ) : null}
          </TabBoundary>
        </main>
      </div>

      <footer className="app-footer">
        <span>
          {build
            ? `${build.version} ${build.commitShort}${build.dirty ? "+dirty" : ""}`
            : "build unknown"}
        </span>
        <span>dsp v{init?.version ?? "?"}</span>
        {stft ? (
          <span>
            {stft.frames}×{stft.bins} bins · {stft.metrics.binHz.toFixed(2)} Hz ·{" "}
            {stft.metrics.windowMs.toFixed(1)} ms
          </span>
        ) : (
          <span>no STFT</span>
        )}
        {lastTiming ? (
          <span>
            last: {lastTiming.kind} {lastTiming.elapsedMs.toFixed(1)} ms
          </span>
        ) : null}
        <span>gpu {(gpuBytes / 1e6).toFixed(1)} MB</span>
        <span>
          {typeof SharedArrayBuffer === "undefined"
            ? "SharedArrayBuffer unavailable (COOP/COEP not set)"
            : "SharedArrayBuffer ready"}
        </span>
      </footer>
    </div>
  );
}
