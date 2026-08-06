/*
 * Platform adapter.
 *
 * The renderer is shared between the browser build and the Electron build, so
 * everything that differs between them lives behind this interface. There is exactly
 * one reason it exists: six-channel capture.
 *
 * In the browser, getUserMedia with channelCount 6 is best effort. Chrome will
 * happily hand back two channels having silently downmixed, and it applies echo
 * cancellation, noise suppression and gain control unless each is explicitly turned
 * off — all three of which destroy the inter-channel phase relationships the whole
 * array depends on. The adapter therefore reports what it actually got rather than
 * what was asked for.
 *
 * In Electron the reliable path on macOS is ffmpeg with the avfoundation input,
 * spawned from the main process and piped as f32le. It avoids native modules and
 * node-gyp entirely, and it is the only way to be sure all six channels arrive
 * untouched.
 */

export interface AudioDeviceInfo {
  id: string;
  label: string;
  /** Channels the device claims, where the platform can tell us. */
  channels: number | null;
}

export interface CaptureFormat {
  sampleRate: number;
  channels: number;
  /** What was asked for, so a mismatch is visible. */
  requestedChannels: number;
  deviceLabel: string;
  backend: "getusermedia" | "ffmpeg-avfoundation";
  warnings: string[];
}

/** One block of interleaved-by-channel planar audio. */
export interface CaptureBlock {
  /** channels * frames, channel-major. */
  planar: Float32Array;
  frames: number;
  channels: number;
  /** Sample index of the first frame since capture started. */
  startSample: number;
}

export interface CaptureStats {
  framesDelivered: number;
  /** Blocks the ring dropped because the consumer fell behind. */
  underruns: number;
  overruns: number;
  glitches: number;
  /** Measured from the ring's fill level. */
  latencyMs: number;
}

export interface CaptureSession {
  format: CaptureFormat;
  stop(): Promise<void>;
  stats(): CaptureStats;
}

export interface SerialPortInfo {
  id: string;
  label: string;
}

export interface SerialSession {
  stop(): Promise<void>;
}

export interface PlatformAdapter {
  readonly name: "web" | "electron";
  /** Whether SharedArrayBuffer is usable, which needs COOP and COEP set. */
  readonly hasSharedMemory: boolean;

  listAudioDevices(): Promise<AudioDeviceInfo[]>;
  startCapture(opts: {
    deviceId: string;
    channels: number;
    sampleRate: number;
    onBlock: (block: CaptureBlock) => void;
    onLog?: (line: string) => void;
  }): Promise<CaptureSession>;

  listSerialPorts(): Promise<SerialPortInfo[]>;
  /** One event per line, as the firmware emits it. */
  startSerial(opts: {
    portId: string;
    baudRate: number;
    onLine: (line: string) => void;
    onLog?: (line: string) => void;
  }): Promise<SerialSession>;

  /** Native save dialog where there is one, a download otherwise. */
  saveFile(name: string, contents: string | Uint8Array, mime: string): Promise<void>;
}

declare global {
  interface Window {
    het68?: unknown;
  }
}

let adapter: PlatformAdapter | null = null;

export async function getPlatform(): Promise<PlatformAdapter> {
  if (adapter) return adapter;
  if (typeof window !== "undefined" && window.het68) {
    const mod = await import("./electron.js");
    adapter = mod.createElectronAdapter();
  } else {
    const mod = await import("./web.js");
    adapter = mod.createWebAdapter();
  }
  return adapter;
}

export function downloadFile(name: string, contents: string | Uint8Array, mime: string) {
  const blob = new Blob([contents as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoking immediately can cancel the download in some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
