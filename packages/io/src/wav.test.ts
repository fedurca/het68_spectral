import { describe, expect, it } from "vitest";
import { channelView, decodeRaw, decodeWav, describeWav, encodeWav } from "./wav.js";

/** Builds a 6-channel S24_3LE file the way arecord lays one out. */
function makeS24Wav(frames: number, sampleRate = 48000, channels = 6): ArrayBuffer {
  const bytesPerSample = 3;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 24, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);

  let p = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      // A distinct ramp per channel, so a channel mix-up is impossible to miss.
      const s = ((f + 1) * (c + 1) * 1000) | 0;
      bytes[p] = s & 0xff;
      bytes[p + 1] = (s >> 8) & 0xff;
      bytes[p + 2] = (s >> 16) & 0xff;
      p += 3;
    }
  }
  return buf;
}

describe("S24_3LE from arecord", () => {
  const wav = decodeWav(makeS24Wav(100));

  it("reads the header without complaint", () => {
    expect(wav.format.channels).toBe(6);
    expect(wav.format.sampleRate).toBe(48000);
    expect(wav.format.bitsPerSample).toBe(24);
    expect(wav.format.blockAlign).toBe(18);
    expect(wav.frames).toBe(100);
    expect(wav.warnings).toEqual([]);
  });

  it("deinterleaves each channel to its own ramp", () => {
    for (let c = 0; c < 6; c++) {
      const ch = channelView(wav, c);
      expect(ch.length).toBe(100);
      for (const f of [0, 37, 99]) {
        const expected = ((f + 1) * (c + 1) * 1000) / 8388608;
        expect(ch[f]).toBeCloseTo(expected, 6);
      }
    }
  });

  it("produces the int16 view the firmware would see", () => {
    // doa.c works on int16, reached from 24-bit as s24 >> 8. Getting this wrong
    // would put every threshold 48 dB out.
    for (let c = 0; c < 6; c++) {
      const base = c * wav.frames;
      for (const f of [0, 37, 99]) {
        const s24 = (f + 1) * (c + 1) * 1000;
        expect(wav.planarInt16[base + f]).toBe(s24 >> 8);
      }
    }
  });

  it("handles negative sample values", () => {
    const frames = 8;
    const buf = makeS24Wav(frames);
    const bytes = new Uint8Array(buf);
    // Write -1 as a 24-bit two's complement word into channel 0, frame 0.
    bytes[44] = 0xff;
    bytes[45] = 0xff;
    bytes[46] = 0xff;
    const decoded = decodeWav(buf);
    expect(channelView(decoded, 0)[0]).toBeCloseTo(-1 / 8388608, 9);
    expect(decoded.planarInt16[0]).toBe(-1);
  });
});

describe("non-canonical files", () => {
  it("flags a wrong channel count and sample rate rather than adapting", () => {
    const wav = decodeWav(makeS24Wav(50, 44100, 2));
    const joined = wav.warnings.join(" ");
    expect(joined).toContain("2 channels");
    expect(joined).toContain("44100 Hz");
  });

  it("reports a truncated data chunk", () => {
    const full = makeS24Wav(100);
    // Drop the last 30 bytes without correcting the size fields, which is what a
    // recording interrupted mid-write looks like.
    const truncated = full.slice(0, full.byteLength - 30);
    const wav = decodeWav(truncated);
    expect(wav.warnings.some((w) => w.includes("RIFF size"))).toBe(true);
    expect(wav.frames).toBe(98);
  });

  it("rejects a file that is not RIFF", () => {
    const buf = new ArrayBuffer(64);
    expect(() => decodeWav(buf)).toThrow(/Not a RIFF file/);
  });

  it("names RF64 explicitly instead of failing obscurely", () => {
    const buf = new ArrayBuffer(64);
    const view = new DataView(buf);
    for (const [i, ch] of [..."RF64"].entries()) view.setUint8(i, ch.charCodeAt(0));
    expect(() => decodeWav(buf)).toThrow(/RF64/);
  });
});

describe("round trip", () => {
  it("survives encode and decode at 24 bits", () => {
    const frames = 256;
    const channels = 6;
    const planar = new Float32Array(channels * frames);
    for (let c = 0; c < channels; c++) {
      for (let f = 0; f < frames; f++) {
        planar[c * frames + f] = Math.sin((2 * Math.PI * (c + 1) * f) / 64) * 0.5;
      }
    }
    const wav = decodeWav(encodeWav(planar, channels, frames, 48000, 24));
    expect(wav.frames).toBe(frames);
    for (let i = 0; i < planar.length; i++) {
      // One 24-bit quantum is 1.2e-7, so a couple of them is a fair tolerance.
      expect(wav.planar[i]).toBeCloseTo(planar[i]!, 6);
    }
  });
});

describe("raw capture", () => {
  it("reads headerless float32, as the ffmpeg pipe delivers it", () => {
    const frames = 32;
    const channels = 6;
    const buf = new ArrayBuffer(frames * channels * 4);
    const view = new DataView(buf);
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < channels; c++) {
        view.setFloat32((f * channels + c) * 4, (c + 1) / 10, true);
      }
    }
    const wav = decodeRaw(buf, {
      channels,
      bitsPerSample: 32,
      sampleRate: 48000,
      encoding: "pcm-float",
    });
    expect(wav.frames).toBe(frames);
    for (let c = 0; c < channels; c++) {
      expect(channelView(wav, c)[0]).toBeCloseTo((c + 1) / 10, 6);
    }
  });
});

describe("header dump", () => {
  it("lists the format and every chunk", () => {
    const text = describeWav(decodeWav(makeS24Wav(10))).join("\n");
    expect(text).toContain("block align   18 bytes/frame");
    expect(text).toContain("fmt ");
    expect(text).toContain("data");
  });
});
