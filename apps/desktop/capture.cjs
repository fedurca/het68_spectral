/*
 * Six-channel capture through ffmpeg.
 *
 * The browser cannot be trusted with this. getUserMedia will return a two-channel
 * downmix having asked for six, and Chrome applies echo cancellation, noise
 * suppression and automatic gain unless each is explicitly disabled — all three of
 * which alter the inter-channel phase that the entire array depends on. ffmpeg with
 * the avfoundation input opens the device directly and hands over exactly what it
 * produced.
 *
 * ffmpeg rather than a native binding because a native audio module means node-gyp,
 * a rebuild for every Electron version, and a signing headache on macOS. A subprocess
 * writing f32le to a pipe has none of that and can be replaced with a different
 * backend on another platform without touching anything else.
 *
 * Output is planar, channel-major, because every consumer downstream wants one
 * channel contiguously and converting later would copy the whole block twice.
 */

const { spawn, execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");

/** Where a bundled or user-installed ffmpeg is likely to be, in order of preference. */
const FFMPEG_CANDIDATES = [
  process.env.HET68_FFMPEG,
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
  "ffmpeg",
].filter(Boolean);

function inputFormat() {
  if (process.platform === "darwin") return "avfoundation";
  if (process.platform === "linux") return "alsa";
  return "dshow";
}

class Capture extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.ffmpegPath = null;
    this.channels = 0;
    this.sampleRate = 0;
    this.startSample = 0;
    this.pending = Buffer.alloc(0);
    this.stats = {
      framesDelivered: 0,
      underruns: 0,
      overruns: 0,
      glitches: 0,
      latencyMs: 0,
    };
  }

  async findFfmpeg() {
    if (this.ffmpegPath) return this.ffmpegPath;
    for (const candidate of FFMPEG_CANDIDATES) {
      const ok = await new Promise((resolve) => {
        execFile(candidate, ["-version"], (err) => resolve(!err));
      });
      if (ok) {
        this.ffmpegPath = candidate;
        return candidate;
      }
    }
    throw new Error(
      "ffmpeg was not found. Install it (brew install ffmpeg) or set HET68_FFMPEG to its path; it is the only reliable way to open six channels on macOS.",
    );
  }

  /**
   * Device names as the platform reports them. On macOS this comes from ffmpeg's own
   * enumeration, which is what the capture will use, rather than from Core Audio via
   * some other path that might number them differently.
   */
  async listDevices() {
    const ffmpeg = await this.findFfmpeg();
    if (process.platform !== "darwin") {
      return [{ id: "default", label: "System default input", channels: null }];
    }
    const text = await new Promise((resolve) => {
      // Listing devices always exits non-zero because there is no output file, so the
      // exit code is ignored and stderr is what carries the list.
      execFile(
        ffmpeg,
        ["-f", "avfoundation", "-list_devices", "true", "-i", ""],
        (_err, _stdout, stderr) => resolve(stderr || ""),
      );
    });

    const devices = [];
    let inAudio = false;
    for (const line of text.split("\n")) {
      if (/AVFoundation audio devices/i.test(line)) {
        inAudio = true;
        continue;
      }
      if (/AVFoundation video devices/i.test(line)) {
        inAudio = false;
        continue;
      }
      if (!inAudio) continue;
      const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
      if (m) devices.push({ id: m[1], label: m[2], channels: null });
    }
    if (devices.length === 0) {
      devices.push({ id: "0", label: "Default input (ffmpeg reported no list)", channels: null });
    }
    return devices;
  }

  async start({ deviceId, channels, sampleRate }) {
    if (this.proc) throw new Error("Capture is already running");
    const ffmpeg = await this.findFfmpeg();

    const input =
      process.platform === "darwin" ? `:${deviceId}` : deviceId || "default";
    const args = [
      "-hide_banner",
      "-nostdin",
      "-f",
      inputFormat(),
      "-ch_layout",
      channelLayout(channels),
      "-sample_rate",
      String(sampleRate),
      "-i",
      input,
      "-acodec",
      "pcm_f32le",
      "-f",
      "f32le",
      "-",
    ];

    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.startSample = 0;
    this.pending = Buffer.alloc(0);
    this.stats = {
      framesDelivered: 0,
      underruns: 0,
      overruns: 0,
      glitches: 0,
      latencyMs: 0,
    };

    const warnings = [];
    let actualChannels = channels;
    let actualRate = sampleRate;

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() === "") continue;
        this.emit("log", line.trim());
        // What ffmpeg actually opened, which is not necessarily what was asked for.
        const m = line.match(/Stream #0:0.*?(\d+) Hz, ([^,]+), /);
        if (m) {
          actualRate = Number(m[1]);
          actualChannels = channelsFromLayout(m[2].trim()) ?? actualChannels;
        }
        if (/Input\/output error|Device or resource busy/i.test(line)) {
          warnings.push(line.trim());
        }
      }
    });

    proc.stdout.on("data", (chunk) => this.onData(chunk));
    proc.on("close", (code) => {
      this.emit("log", `ffmpeg exited with code ${code}`);
      this.proc = null;
    });

    // ffmpeg reports the opened format on stderr shortly after start; a short wait
    // means the renderer is told the truth rather than the request.
    await new Promise((resolve) => setTimeout(resolve, 700));

    if (actualChannels !== channels) {
      warnings.push(
        `The device opened with ${actualChannels} channels rather than ${channels}.`,
      );
    }
    if (actualRate !== sampleRate) {
      warnings.push(
        `The device opened at ${actualRate} Hz rather than ${sampleRate} Hz; every frequency read from this capture is scaled by ${(actualRate / sampleRate).toFixed(4)}.`,
      );
    }

    this.channels = actualChannels;
    this.sampleRate = actualRate;

    return {
      sampleRate: actualRate,
      channels: actualChannels,
      deviceLabel: `${inputFormat()} device ${deviceId}`,
      warnings,
    };
  }

  onData(chunk) {
    const bytesPerFrame = 4 * this.channels;
    const buf =
      this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frames = Math.floor(buf.length / bytesPerFrame);
    if (frames === 0) {
      this.pending = buf;
      return;
    }
    const used = frames * bytesPerFrame;
    this.pending = buf.subarray(used);

    // De-interleave into channel-major order. Reading through a DataView rather than
    // a Float32Array view because the pipe gives no alignment guarantee.
    const planar = new Float32Array(frames * this.channels);
    const view = new DataView(buf.buffer, buf.byteOffset, used);
    for (let f = 0; f < frames; f++) {
      const base = f * bytesPerFrame;
      for (let c = 0; c < this.channels; c++) {
        planar[c * frames + f] = view.getFloat32(base + c * 4, true);
      }
    }

    this.stats.framesDelivered += frames;
    this.stats.latencyMs = (this.pending.length / bytesPerFrame / this.sampleRate) * 1000;

    this.emit("block", {
      planar,
      frames,
      channels: this.channels,
      startSample: this.startSample,
    });
    this.startSample += frames;
  }

  async stop() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    proc.kill("SIGINT");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function channelLayout(channels) {
  // ffmpeg needs a layout name, and there is no standard six-channel name that means
  // "six discrete microphones" — 5.1 would imply a speaker arrangement and can trigger
  // a remap. The unknown-channel form asks for six raw channels and nothing else.
  return `${channels}c`;
}

function channelsFromLayout(layout) {
  const direct = layout.match(/^(\d+)\s*channels?$/i) ?? layout.match(/^(\d+)c$/i);
  if (direct) return Number(direct[1]);
  const known = { mono: 1, stereo: 2, "quad": 4, "5.1": 6, "6.0": 6, "7.1": 8 };
  return known[layout.toLowerCase()] ?? null;
}

module.exports = { Capture };
