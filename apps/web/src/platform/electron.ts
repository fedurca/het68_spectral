/*
 * Electron platform: everything goes through the preload bridge to the main process,
 * which spawns ffmpeg with the avfoundation input and reads the serial port.
 *
 * The renderer never touches Node APIs, so context isolation stays on and the same
 * bundle runs in the browser.
 */

import type {
  AudioDeviceInfo,
  CaptureBlock,
  CaptureSession,
  CaptureStats,
  PlatformAdapter,
  SerialPortInfo,
  SerialSession,
  UpdateCheckResult,
} from "./index.js";

/** The surface exposed by apps/desktop/preload.cjs. */
export interface Het68Bridge {
  platform: string;
  listAudioDevices(): Promise<AudioDeviceInfo[]>;
  startCapture(opts: {
    deviceId: string;
    channels: number;
    sampleRate: number;
  }): Promise<{ sampleRate: number; channels: number; deviceLabel: string; warnings: string[] }>;
  stopCapture(): Promise<void>;
  onCaptureBlock(cb: (block: CaptureBlock) => void): () => void;
  onCaptureLog(cb: (line: string) => void): () => void;
  captureStats(): Promise<CaptureStats>;
  listSerialPorts(): Promise<SerialPortInfo[]>;
  startSerial(opts: { portId: string; baudRate: number }): Promise<void>;
  stopSerial(): Promise<void>;
  onSerialLine(cb: (line: string) => void): () => void;
  saveFile(name: string, contents: string | Uint8Array, mime: string): Promise<void>;
  checkForUpdate(currentVersion: string): Promise<UpdateCheckResult>;
  downloadUpdate(opts: { url: string; name?: string }): Promise<{ path: string; name: string }>;
  openPath(filePath: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

function bridge(): Het68Bridge {
  const b = (window as unknown as { het68?: Het68Bridge }).het68;
  if (!b) throw new Error("The Electron bridge is missing; preload did not run.");
  return b;
}

export function createElectronAdapter(): PlatformAdapter {
  return {
    name: "electron",
    // Electron sets the same COOP/COEP headers as the worker, and a packaged app has
    // no cross-origin content at all.
    hasSharedMemory: typeof SharedArrayBuffer !== "undefined",

    listAudioDevices: () => bridge().listAudioDevices(),

    async startCapture({ deviceId, channels, sampleRate, onBlock, onLog }) {
      const b = bridge();
      const offBlock = b.onCaptureBlock(onBlock);
      const offLog = onLog ? b.onCaptureLog(onLog) : () => {};
      const info = await b.startCapture({ deviceId, channels, sampleRate });

      const warnings = [...info.warnings];
      if (info.channels < channels) {
        warnings.push(
          `ffmpeg opened the device with ${info.channels} channels rather than ${channels}. Check the device is the cube and not the built-in microphone.`,
        );
      }

      return {
        format: {
          sampleRate: info.sampleRate,
          channels: info.channels,
          requestedChannels: channels,
          deviceLabel: info.deviceLabel,
          backend: "ffmpeg-avfoundation",
          warnings,
        },
        async stop() {
          offBlock();
          offLog();
          await b.stopCapture();
        },
        stats: () => lastStats,
      } satisfies CaptureSession;
    },

    listSerialPorts: () => bridge().listSerialPorts(),

    async startSerial({ portId, baudRate, onLine, onLog }): Promise<SerialSession> {
      const b = bridge();
      const off = b.onSerialLine(onLine);
      await b.startSerial({ portId, baudRate });
      onLog?.(`serial ${portId} at ${baudRate} baud`);
      return {
        async stop() {
          off();
          await b.stopSerial();
        },
      };
    },

    saveFile: (name, contents, mime) => bridge().saveFile(name, contents, mime),

    checkForUpdate: (currentVersion) => bridge().checkForUpdate(currentVersion),
    downloadUpdate: (opts) => bridge().downloadUpdate(opts),
    openPath: (filePath) => bridge().openPath(filePath),
    openExternal: (url) => bridge().openExternal(url),
  };
}

/*
 * Capture statistics come from the main process, which is asynchronous, while the UI
 * polls them synchronously. The last value is cached and refreshed in the background;
 * a figure that is a second stale is fine for a buffer health display, and blocking
 * the renderer on IPC to draw one would not be.
 */
let lastStats: CaptureStats = {
  framesDelivered: 0,
  underruns: 0,
  overruns: 0,
  glitches: 0,
  latencyMs: 0,
};

export function startStatsPolling(intervalMs = 1000): () => void {
  const timer = setInterval(() => {
    void bridge()
      .captureStats()
      .then((s) => {
        lastStats = s;
      })
      .catch(() => {
        // The bridge is gone or capture has stopped; keep the last known figures.
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
