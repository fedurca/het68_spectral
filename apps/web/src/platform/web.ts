/*
 * Browser platform: getUserMedia into an AudioWorklet.
 *
 * This is best effort and says so. Two things routinely go wrong and both are
 * reported rather than hidden.
 *
 * Chrome will grant a stream with fewer channels than asked for, having downmixed
 * six microphones into stereo, and nothing in the API call fails. So the actual
 * channel count is read back from the track settings and from the worklet, and the
 * two are compared.
 *
 * Echo cancellation, noise suppression and automatic gain control are all on by
 * default. Each of them is fatal here: they are designed for a single voice and they
 * modify amplitude and phase per channel, which is precisely the information the
 * array measures. They are requested off explicitly, and the granted settings are
 * checked afterwards because a request is not a guarantee.
 */

import type {
  AudioDeviceInfo,
  CaptureBlock,
  CaptureSession,
  CaptureStats,
  PlatformAdapter,
  SerialPortInfo,
  SerialSession,
} from "./index.js";
import { downloadFile } from "./index.js";
import { captureWorkletUrl } from "./worklet.js";

export function createWebAdapter(): PlatformAdapter {
  return {
    name: "web",
    hasSharedMemory: typeof SharedArrayBuffer !== "undefined",

    async listAudioDevices(): Promise<AudioDeviceInfo[]> {
      // Labels are empty until permission has been granted at least once, which is
      // why this asks for a stream first and releases it immediately.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const t of probe.getTracks()) t.stop();
      } catch {
        // Carry on: the device list is still worth showing without labels.
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({
          id: d.deviceId,
          label: d.label || `input ${d.deviceId.slice(0, 8)}`,
          channels: null,
        }));
    },

    async startCapture({ deviceId, channels, sampleRate, onBlock, onLog }) {
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: { ideal: channels },
          sampleRate: { ideal: sampleRate },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getAudioTracks()[0]!;
      const settings = track.getSettings();
      const warnings: string[] = [];

      const grantedChannels = settings.channelCount ?? 0;
      if (grantedChannels !== 0 && grantedChannels < channels) {
        warnings.push(
          `The browser granted ${grantedChannels} channels instead of ${channels}. Six microphones have been mixed down to ${grantedChannels}, so every spatial result from this capture is meaningless. Use the desktop build for live work.`,
        );
      }
      for (const [key, label] of [
        ["echoCancellation", "Echo cancellation"],
        ["noiseSuppression", "Noise suppression"],
        ["autoGainControl", "Automatic gain control"],
      ] as const) {
        if ((settings as Record<string, unknown>)[key] === true) {
          warnings.push(
            `${label} is still on despite being requested off. It alters level and phase per channel, so delays between microphones cannot be trusted.`,
          );
        }
      }

      const ctx = new AudioContext({
        sampleRate,
        latencyHint: "playback",
      });
      if (Math.abs(ctx.sampleRate - sampleRate) > 1) {
        warnings.push(
          `The audio context runs at ${ctx.sampleRate} Hz, not ${sampleRate} Hz. Every delay in samples, and the maximum the geometry allows, scales with this.`,
        );
      }

      const url = captureWorkletUrl();
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }

      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "het68-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: channels,
        channelCountMode: "explicit",
        channelInterpretation: "discrete",
        processorOptions: { channels, blockFrames: Math.round(sampleRate / 10) },
      });

      const stats: CaptureStats = {
        framesDelivered: 0,
        underruns: 0,
        overruns: 0,
        glitches: 0,
        latencyMs: (ctx.baseLatency ?? 0) * 1000,
      };

      let workletChannels = 0;
      node.port.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as
          | { type: "channels"; channels: number }
          | ({ type: "block" } & CaptureBlock);
        if (msg.type === "channels") {
          workletChannels = msg.channels;
          if (workletChannels < channels) {
            onLog?.(
              `The audio graph is delivering ${workletChannels} channels; ${channels - workletChannels} are being padded with silence.`,
            );
            stats.glitches++;
          }
          return;
        }
        stats.framesDelivered += msg.frames;
        onBlock(msg);
      };

      source.connect(node);

      return {
        format: {
          sampleRate: ctx.sampleRate,
          channels: workletChannels || grantedChannels || channels,
          requestedChannels: channels,
          deviceLabel: track.label,
          backend: "getusermedia",
          warnings,
        },
        async stop() {
          node.port.onmessage = null;
          source.disconnect();
          node.disconnect();
          for (const t of stream.getTracks()) t.stop();
          await ctx.close();
        },
        stats: () => ({ ...stats }),
      } satisfies CaptureSession;
    },

    async listSerialPorts(): Promise<SerialPortInfo[]> {
      // Web Serial exists but each port has to be picked by the user through a
      // browser dialog, so there is no list to show up front.
      return [];
    },

    async startSerial({ onLine, onLog }): Promise<SerialSession> {
      const serial = (navigator as unknown as { serial?: unknown }).serial;
      if (!serial) {
        throw new Error(
          "This browser has no Web Serial support. Use the desktop build to read the firmware's event lines.",
        );
      }
      type SerialLike = {
        requestPort(): Promise<{
          open(o: { baudRate: number }): Promise<void>;
          readable: ReadableStream<Uint8Array>;
          close(): Promise<void>;
        }>;
      };
      const port = await (serial as SerialLike).requestPort();
      await port.open({ baudRate: 115200 });
      onLog?.("serial port opened");

      const decoder = new TextDecoder();
      let buffer = "";
      let stopped = false;
      const reader = port.readable.getReader();

      void (async () => {
        try {
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
              onLine(buffer.slice(0, nl).replace(/\r$/, ""));
              buffer = buffer.slice(nl + 1);
            }
          }
        } catch (err) {
          onLog?.(`serial read failed: ${(err as Error).message}`);
        }
      })();

      return {
        async stop() {
          stopped = true;
          try {
            await reader.cancel();
          } catch {
            // Already gone; nothing useful to do.
          }
          reader.releaseLock();
          await port.close();
        },
      };
    },

    async saveFile(name, contents, mime) {
      downloadFile(name, contents, mime);
    },
  };
}
