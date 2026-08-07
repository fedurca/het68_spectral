/*
 * Electron main process.
 *
 * The renderer is exactly the web build, unchanged. Everything the browser cannot do
 * — open six channels without a downmix, enumerate serial ports, write a file where
 * the user asked — happens here and is reached through a narrow preload bridge, so
 * context isolation stays on and the same bundle keeps working in a browser.
 *
 * COOP and COEP are set on the loaded documents to match what the Cloudflare worker
 * sends, so SharedArrayBuffer is available in both and the two builds cannot drift
 * apart in a way that only appears after deployment.
 */

const { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } =
  require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { Capture } = require("./capture.cjs");
const update = require("./update.cjs");

const isDev = process.argv.includes("--dev");
/* Loads the renderer, reports what the environment gives it, and exits. Packaging is
 * the step where the renderer stops being served over http, and this is what proves
 * the swap did not break the fonts, the WebAssembly module or the secure context. */
const isSelfTest = process.argv.includes("--selftest");
const capture = new Capture();

let mainWindow = null;
let serial = null;

function rendererRoot() {
  // Packaged, the renderer sits beside the app resources; in development it is the
  // Vite build output two directories up.
  return app.isPackaged
    ? path.join(process.resourcesPath, "renderer")
    : path.join(__dirname, "..", "web", "dist");
}

/*
 * The renderer is served from a custom scheme rather than opened with loadFile.
 *
 * A file:// document has an opaque origin, which is not a secure context, so
 * crossOriginIsolated is false there and SharedArrayBuffer is gone however the headers
 * are set. Absolute asset paths break too: the stylesheet asks for /fonts/manrope and
 * under file:// that is the root of the disk. Registering het68:// as standard and
 * secure gives the desktop build the same origin semantics as the deployed site, so
 * the one bundle behaves the same in both.
 */
const SCHEME = "het68";
const ORIGIN = `${SCHEME}://app`;

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

function registerRendererProtocol() {
  const root = rendererRoot();
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname);
    const resolved = path.join(root, path.normalize(rel));
    // path.normalize collapses "..", so this rejects anything that climbed out.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    const target = rel === "/" || rel === "" ? path.join(root, "index.html") : resolved;
    const headers = {
      "Content-Type": CONTENT_TYPES[path.extname(target)] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    };
    try {
      const res = await net.fetch(pathToFileURL(target).toString());
      if (!res.ok) throw new Error(String(res.status));
      return new Response(res.body, { status: 200, headers });
    } catch {
      return new Response(`Not found: ${rel}`, {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1020,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#05080a",
    title: "het68 spectral",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The WebGL spectrogram is the whole point of the application, so a software
      // fallback would make it unusable rather than merely slow.
      webgl: true,
    },
  });

  if (isDev) {
    void mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadURL(`${ORIGIN}/index.html`);
  }

  // Anything that is not the application itself opens in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerRendererProtocol();

  /*
   * The isolation headers are forced onto every response, including the Vite dev
   * server's. Existing values are dropped first: Chromium normalises header names to
   * lower case, so merging on a capitalised key leaves two of them, and a doubled
   * "same-origin, same-origin" is not a value the policy parser accepts. The result
   * is silent — the header is simply ignored and crossOriginIsolated stays false.
   */
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = {};
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
      if (!/^cross-origin-(opener|embedder)-policy$/i.test(name)) headers[name] = value;
    }
    headers["Cross-Origin-Opener-Policy"] = ["same-origin"];
    headers["Cross-Origin-Embedder-Policy"] = ["require-corp"];
    callback({ responseHeaders: headers });
  });

  // Microphone permission is granted without a prompt inside the app; macOS still
  // shows its own system dialog the first time, driven by NSMicrophoneUsageDescription.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });

  createWindow();

  if (isSelfTest) void runSelfTest();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

async function runSelfTest() {
  const failures = [];
  const win = mainWindow;
  const timer = setTimeout(() => {
    console.error("selftest: the renderer did not finish loading within 30 s");
    app.exit(1);
  }, 30_000);

  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`selftest: renderer gone (${details.reason})`);
    app.exit(1);
  });

  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  // React mounts and the WebAssembly core loads after the document is ready.
  await new Promise((r) => setTimeout(r, 4000));

  const report = await win.webContents.executeJavaScript(`(async () => ({
    documentHeaders: await fetch(location.href).then(r => Object.fromEntries(r.headers)),
    url: location.href,
    secureContext: isSecureContext,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    manropeLoaded: [...document.fonts].some(f => f.family === "Manrope" && f.status === "loaded"),
    tabs: [...document.querySelectorAll("button.tab")].map(b => b.textContent),
    footer: document.querySelector(".app-footer")?.innerText.replace(/\\n/g, " | ") ?? null,
    bridge: typeof window.het68 === "object" && window.het68 !== null,
    webgl2: !!document.createElement("canvas").getContext("webgl2"),
  }))()`);

  clearTimeout(timer);

  if (!report.secureContext) failures.push("the renderer is not a secure context");
  if (!report.crossOriginIsolated) failures.push("cross-origin isolation is off");
  if (!report.sharedArrayBuffer) failures.push("SharedArrayBuffer is unavailable");
  if (!report.manropeLoaded) failures.push("the self-hosted Manrope font did not load");
  if (report.tabs.length !== 8) failures.push(`expected 8 tabs, found ${report.tabs.length}`);
  if (!report.bridge) failures.push("the preload bridge is missing");
  if (!report.webgl2) failures.push("WebGL2 is unavailable");

  console.log(JSON.stringify(report, null, 2));
  for (const f of failures) console.error(`selftest: ${f}`);
  console.log(failures.length === 0 ? "selftest: ok" : `selftest: ${failures.length} failures`);
  app.exit(failures.length === 0 ? 0 : 1);
}

app.on("window-all-closed", () => {
  void capture.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void capture.stop();
  void closeSerial();
});

// ---- capture --------------------------------------------------------------

capture.on("block", (block) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Structured clone copies the buffer, which for a 1024-frame six-channel block is
  // 24 kB — small enough that avoiding the copy is not worth a shared-memory ring
  // between processes.
  mainWindow.webContents.send("het68:capture-block", block);
});

capture.on("log", (line) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("het68:capture-log", line);
});

ipcMain.handle("het68:list-audio-devices", () => capture.listDevices());
ipcMain.handle("het68:start-capture", (_e, opts) => capture.start(opts));
ipcMain.handle("het68:stop-capture", () => capture.stop());
ipcMain.handle("het68:capture-stats", () => capture.stats);

// ---- serial ---------------------------------------------------------------

/*
 * serialport is loaded lazily. It is a native module, and if it failed to build the
 * rest of the application should still run: audio analysis does not depend on the
 * firmware's event lines.
 */
function loadSerialPort() {
  try {
    return require("serialport");
  } catch (err) {
    throw new Error(
      `The serialport module is unavailable (${err.message}). Audio analysis still works; only the firmware event line does not.`,
    );
  }
}

ipcMain.handle("het68:list-serial-ports", async () => {
  const { SerialPort } = loadSerialPort();
  const ports = await SerialPort.list();
  return ports.map((p) => ({
    id: p.path,
    label: [p.path, p.manufacturer, p.serialNumber].filter(Boolean).join(" · "),
  }));
});

ipcMain.handle("het68:start-serial", async (_e, { portId, baudRate }) => {
  await closeSerial();
  const { SerialPort } = loadSerialPort();
  const { ReadlineParser } = require("@serialport/parser-readline");

  const port = new SerialPort({ path: portId, baudRate, autoOpen: false });
  await new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });

  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
  parser.on("data", (line) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("het68:serial-line", String(line).replace(/\r$/, ""));
  });
  port.on("error", (err) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("het68:capture-log", `serial error: ${err.message}`);
  });

  serial = port;
});

async function closeSerial() {
  const port = serial;
  serial = null;
  if (!port || !port.isOpen) return;
  await new Promise((resolve) => port.close(() => resolve()));
}

ipcMain.handle("het68:stop-serial", () => closeSerial());

// ---- files ----------------------------------------------------------------

ipcMain.handle("het68:save-file", async (_e, { name, contents }) => {
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    defaultPath: name,
  });
  if (result.canceled || !result.filePath) return;
  const data =
    typeof contents === "string" ? contents : Buffer.from(new Uint8Array(contents));
  await fs.writeFile(result.filePath, data);
});

// ---- updates (manual, GitHub Releases) ------------------------------------

ipcMain.handle("het68:check-for-update", (_e, currentVersion) =>
  update.checkForUpdate(currentVersion),
);
ipcMain.handle("het68:download-update", (_e, opts) => update.downloadUpdate(opts));
ipcMain.handle("het68:open-path", (_e, filePath) => update.openPath(filePath));
ipcMain.handle("het68:open-external", (_e, url) => update.openExternal(url));
