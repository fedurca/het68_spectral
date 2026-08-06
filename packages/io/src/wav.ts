/*
 * WAV reader for the detection cube.
 *
 * The primary input is `arecord -f S24_3LE -r 48000 -c 6`, which packs 24 bits into
 * three bytes with no padding: 18 bytes per frame. Most browser and library WAV
 * readers either refuse that or silently mangle it, which is why this is hand
 * written.
 *
 * Everything found in the file is reported rather than assumed. A recording that
 * turns out to be 16 bit or 44.1 kHz should be visibly wrong, not quietly resampled
 * into something that looks plausible.
 */

export type SampleEncoding = "pcm-int" | "pcm-float" | "unknown";

export interface ChunkInfo {
  id: string;
  offset: number;
  size: number;
  /** True when the chunk had to be padded to an even length, as RIFF requires. */
  padded: boolean;
}

export interface WavFormat {
  /** Raw wFormatTag: 1 PCM, 3 IEEE float, 0xFFFE extensible. */
  formatTag: number;
  formatName: string;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  /** Extensible only; can be less than bitsPerSample when a container is oversized. */
  validBitsPerSample: number | null;
  channelMask: number | null;
  subFormatGuid: string | null;
  encoding: SampleEncoding;
}

export interface WavFile {
  format: WavFormat;
  chunks: ChunkInfo[];
  /** Anything non-canonical, in the order it was noticed. */
  warnings: string[];
  frames: number;
  channels: number;
  durationSec: number;
  /** Deinterleaved, channel c at [c*frames, (c+1)*frames). Full precision. */
  planar: Float32Array;
  /**
   * The same audio as the firmware sees it. doa.c works on int16, and a 24-bit
   * source reaches it as `s24 >> 8`; comparing a threshold tuned here against one
   * in the firmware without this would be 48 dB out.
   */
  planarInt16: Int16Array;
  /** Byte offset and length of the audio payload, for the debug view. */
  dataOffset: number;
  dataBytes: number;
}

export interface RawFormatOptions {
  channels: number;
  bitsPerSample: number;
  sampleRate: number;
  encoding?: SampleEncoding;
  littleEndian?: boolean;
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function formatName(tag: number): string {
  switch (tag) {
    case WAVE_FORMAT_PCM:
      return "PCM";
    case WAVE_FORMAT_IEEE_FLOAT:
      return "IEEE float";
    case WAVE_FORMAT_EXTENSIBLE:
      return "WAVE_FORMAT_EXTENSIBLE";
    default:
      return `unknown (0x${tag.toString(16)})`;
  }
}

function guidToString(view: DataView, offset: number): string {
  const d1 = view.getUint32(offset, true);
  const d2 = view.getUint16(offset + 4, true);
  const d3 = view.getUint16(offset + 6, true);
  const rest: string[] = [];
  for (let i = 0; i < 8; i++) {
    rest.push(view.getUint8(offset + 8 + i).toString(16).padStart(2, "0"));
  }
  return `${d1.toString(16).padStart(8, "0")}-${d2
    .toString(16)
    .padStart(4, "0")}-${d3.toString(16).padStart(4, "0")}-${rest
    .slice(0, 2)
    .join("")}-${rest.slice(2).join("")}`;
}

/** Reads a WAV file, reporting rather than repairing whatever it finds. */
export function decodeWav(buffer: ArrayBuffer): WavFile {
  const view = new DataView(buffer);
  const warnings: string[] = [];
  const chunks: ChunkInfo[] = [];

  if (buffer.byteLength < 12) throw new Error("File is too short to be a WAV");
  const riff = fourcc(view, 0);
  if (riff !== "RIFF") {
    if (riff === "RF64") {
      throw new Error(
        "RF64 files are not supported yet. Re-record or convert to WAV; a 6-channel 24-bit take only exceeds 4 GB after about 6 hours.",
      );
    }
    throw new Error(`Not a RIFF file (found "${riff}")`);
  }
  const riffSize = view.getUint32(4, true);
  if (fourcc(view, 8) !== "WAVE") throw new Error("RIFF file is not WAVE");

  if (riffSize + 8 !== buffer.byteLength) {
    warnings.push(
      `RIFF size field says ${riffSize + 8} bytes but the file is ${buffer.byteLength}. ` +
        `Common when a recording was interrupted; the data chunk is read to the real end of file.`,
    );
  }

  let fmt: WavFormat | null = null;
  let dataOffset = -1;
  let dataBytes = 0;

  let pos = 12;
  while (pos + 8 <= buffer.byteLength) {
    const id = fourcc(view, pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    const padded = (size & 1) === 1;

    if (body + size > buffer.byteLength) {
      warnings.push(
        `Chunk "${id}" claims ${size} bytes but only ${
          buffer.byteLength - body
        } remain. Truncated file; using what is there.`,
      );
    }
    chunks.push({ id, offset: pos, size, padded });

    if (id === "fmt ") {
      if (size < 16) throw new Error(`fmt chunk is only ${size} bytes`);
      const formatTag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const byteRate = view.getUint32(body + 8, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bitsPerSample = view.getUint16(body + 14, true);

      let validBits: number | null = null;
      let channelMask: number | null = null;
      let guid: string | null = null;
      let effectiveTag = formatTag;

      if (formatTag === WAVE_FORMAT_EXTENSIBLE && size >= 40) {
        validBits = view.getUint16(body + 18, true);
        channelMask = view.getUint32(body + 20, true);
        guid = guidToString(view, body + 24);
        // The first two bytes of the SubFormat GUID carry the real format tag.
        effectiveTag = view.getUint16(body + 24, true);
      }

      const encoding: SampleEncoding =
        effectiveTag === WAVE_FORMAT_PCM
          ? "pcm-int"
          : effectiveTag === WAVE_FORMAT_IEEE_FLOAT
            ? "pcm-float"
            : "unknown";

      fmt = {
        formatTag,
        formatName: formatName(formatTag),
        channels,
        sampleRate,
        byteRate,
        blockAlign,
        bitsPerSample,
        validBitsPerSample: validBits,
        channelMask,
        subFormatGuid: guid,
        encoding,
      };
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = Math.min(size, buffer.byteLength - body);
    }

    pos = body + size + (padded ? 1 : 0);
  }

  if (!fmt) throw new Error("No fmt chunk found");
  if (dataOffset < 0) throw new Error("No data chunk found");

  // Consistency checks. None of these are fatal, but each one has a plausible cause
  // worth naming rather than silently working around.
  const expectedBlockAlign = (fmt.channels * fmt.bitsPerSample) / 8;
  if (fmt.blockAlign !== expectedBlockAlign) {
    warnings.push(
      `blockAlign is ${fmt.blockAlign} but ${fmt.channels} channels of ${fmt.bitsPerSample} bits need ${expectedBlockAlign}. Frame layout taken from blockAlign.`,
    );
  }
  const expectedByteRate = fmt.sampleRate * fmt.blockAlign;
  if (fmt.byteRate !== expectedByteRate) {
    warnings.push(
      `byteRate is ${fmt.byteRate} but sampleRate * blockAlign is ${expectedByteRate}.`,
    );
  }
  if (fmt.encoding === "unknown") {
    warnings.push(
      `Unrecognised sample format ${fmt.formatName}. Samples cannot be decoded reliably.`,
    );
  }
  if (fmt.validBitsPerSample && fmt.validBitsPerSample !== fmt.bitsPerSample) {
    warnings.push(
      `Container is ${fmt.bitsPerSample} bits but only ${fmt.validBitsPerSample} are valid. Scaling uses the container width.`,
    );
  }
  if (fmt.channels !== 6) {
    warnings.push(
      `${fmt.channels} channels, not the 6 the cube produces. Channel to microphone mapping will not hold.`,
    );
  }
  if (fmt.sampleRate !== 48000) {
    warnings.push(
      `${fmt.sampleRate} Hz, not 48000. Every lag in samples, and the maximum lag the geometry allows, scales with this.`,
    );
  }

  if (fmt.blockAlign <= 0) throw new Error("blockAlign is zero");
  const frames = Math.floor(dataBytes / fmt.blockAlign);
  if (dataBytes % fmt.blockAlign !== 0) {
    warnings.push(
      `data chunk holds ${dataBytes} bytes, which is not a whole number of ${fmt.blockAlign}-byte frames. The trailing partial frame is dropped.`,
    );
  }

  const { planar, planarInt16 } = deinterleave(
    buffer,
    dataOffset,
    frames,
    fmt.channels,
    fmt.bitsPerSample,
    fmt.blockAlign,
    fmt.encoding,
  );

  return {
    format: fmt,
    chunks,
    warnings,
    frames,
    channels: fmt.channels,
    durationSec: fmt.sampleRate > 0 ? frames / fmt.sampleRate : 0,
    planar,
    planarInt16,
    dataOffset,
    dataBytes,
  };
}

/**
 * Headerless capture, for `arecord --file-type raw` and for the ffmpeg pipe the
 * Electron build uses.
 */
export function decodeRaw(
  buffer: ArrayBuffer,
  opts: RawFormatOptions,
): WavFile {
  const bytesPerSample = opts.bitsPerSample / 8;
  const blockAlign = opts.channels * bytesPerSample;
  const frames = Math.floor(buffer.byteLength / blockAlign);
  const encoding =
    opts.encoding ?? (opts.bitsPerSample === 32 ? "pcm-float" : "pcm-int");

  const { planar, planarInt16 } = deinterleave(
    buffer,
    0,
    frames,
    opts.channels,
    opts.bitsPerSample,
    blockAlign,
    encoding,
  );

  return {
    format: {
      formatTag: encoding === "pcm-float" ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM,
      formatName: encoding === "pcm-float" ? "IEEE float (raw)" : "PCM (raw)",
      channels: opts.channels,
      sampleRate: opts.sampleRate,
      byteRate: opts.sampleRate * blockAlign,
      blockAlign,
      bitsPerSample: opts.bitsPerSample,
      validBitsPerSample: null,
      channelMask: null,
      subFormatGuid: null,
      encoding,
    },
    chunks: [],
    warnings:
      buffer.byteLength % blockAlign !== 0
        ? ["Raw data does not end on a frame boundary; the partial frame is dropped."]
        : [],
    frames,
    channels: opts.channels,
    durationSec: opts.sampleRate > 0 ? frames / opts.sampleRate : 0,
    planar,
    planarInt16,
    dataOffset: 0,
    dataBytes: frames * blockAlign,
  };
}

function deinterleave(
  buffer: ArrayBuffer,
  dataOffset: number,
  frames: number,
  channels: number,
  bitsPerSample: number,
  blockAlign: number,
  encoding: SampleEncoding,
): { planar: Float32Array; planarInt16: Int16Array } {
  const planar = new Float32Array(channels * frames);
  const planarInt16 = new Int16Array(channels * frames);
  if (frames === 0) return { planar, planarInt16 };

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const bytesPerSample = Math.floor(bitsPerSample / 8);

  for (let c = 0; c < channels; c++) {
    const out = planar.subarray(c * frames, (c + 1) * frames);
    const out16 = planarInt16.subarray(c * frames, (c + 1) * frames);
    let p = dataOffset + c * bytesPerSample;

    if (encoding === "pcm-float" && bitsPerSample === 32) {
      for (let f = 0; f < frames; f++, p += blockAlign) {
        const v = view.getFloat32(p, true);
        out[f] = v;
        // Float input has no fixed-point original; map full scale onto int16 so
        // firmware-style thresholds still mean something.
        out16[f] = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
      }
    } else if (encoding === "pcm-float" && bitsPerSample === 64) {
      for (let f = 0; f < frames; f++, p += blockAlign) {
        const v = view.getFloat64(p, true);
        out[f] = v;
        out16[f] = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
      }
    } else if (bitsPerSample === 8) {
      // 8-bit WAV is unsigned by definition, unlike every wider depth.
      for (let f = 0; f < frames; f++, p += blockAlign) {
        const v = bytes[p]! - 128;
        out[f] = v / 128;
        out16[f] = v << 8;
      }
    } else if (bitsPerSample === 16) {
      for (let f = 0; f < frames; f++, p += blockAlign) {
        const v = view.getInt16(p, true);
        out[f] = v / 32768;
        out16[f] = v;
      }
    } else if (bitsPerSample === 24) {
      // S24_3LE: three bytes, little endian, sign extended from bit 23. There is no
      // padding byte, which is what trips up readers that assume 4-byte alignment.
      for (let f = 0; f < frames; f++, p += blockAlign) {
        const v =
          ((bytes[p]! << 8) | (bytes[p + 1]! << 16) | (bytes[p + 2]! << 24)) >> 8;
        out[f] = v / 8388608;
        // Exactly what the firmware receives: the top 16 bits of the 24-bit word.
        out16[f] = v >> 8;
      }
    } else if (bitsPerSample === 32) {
      for (let f = 0; f < frames; f++, p += blockAlign) {
        const v = view.getInt32(p, true);
        out[f] = v / 2147483648;
        out16[f] = v >> 16;
      }
    } else {
      throw new Error(`Unsupported bit depth ${bitsPerSample}`);
    }
  }

  return { planar, planarInt16 };
}

/** Extracts one channel as a contiguous view. No copy. */
export function channelView(wav: WavFile, channel: number): Float32Array {
  if (channel < 0 || channel >= wav.channels) {
    throw new Error(`Channel ${channel} out of range (0..${wav.channels - 1})`);
  }
  return wav.planar.subarray(channel * wav.frames, (channel + 1) * wav.frames);
}

/** Slices a time range from one channel, clamped to the file. */
export function channelSlice(
  wav: WavFile,
  channel: number,
  startSec: number,
  endSec: number,
  sampleRate: number,
): Float32Array {
  const from = Math.max(0, Math.floor(startSec * sampleRate));
  const to = Math.min(wav.frames, Math.ceil(endSec * sampleRate));
  if (to <= from) return new Float32Array(0);
  return channelView(wav, channel).subarray(from, to);
}

/**
 * Human-readable dump of the header and every chunk, for the debug panel. The point
 * is that a screenshot of a puzzling spectrogram can be traced back to what was
 * actually in the file.
 */
export function describeWav(wav: WavFile): string[] {
  const f = wav.format;
  const lines = [
    `format        ${f.formatName} (tag 0x${f.formatTag.toString(16)})`,
    `encoding      ${f.encoding}`,
    `channels      ${f.channels}`,
    `sample rate   ${f.sampleRate} Hz`,
    `bit depth     ${f.bitsPerSample}${
      f.validBitsPerSample && f.validBitsPerSample !== f.bitsPerSample
        ? ` (${f.validBitsPerSample} valid)`
        : ""
    }`,
    `block align   ${f.blockAlign} bytes/frame`,
    `byte rate     ${f.byteRate} bytes/s`,
    `frames        ${wav.frames}`,
    `duration      ${wav.durationSec.toFixed(3)} s`,
    `data          ${wav.dataBytes} bytes at offset ${wav.dataOffset}`,
  ];
  if (f.channelMask !== null) {
    lines.push(`channel mask  0x${f.channelMask.toString(16)}`);
  }
  if (f.subFormatGuid) lines.push(`subformat     ${f.subFormatGuid}`);
  lines.push("");
  lines.push("chunks:");
  for (const c of wav.chunks) {
    lines.push(
      `  ${c.id.padEnd(6)} offset ${String(c.offset).padStart(9)}  size ${String(
        c.size,
      ).padStart(10)}${c.padded ? "  (pad byte)" : ""}`,
    );
  }
  return lines;
}

/**
 * Writes a 6-channel WAV. Used to export synthetic scenes so the same fixture can be
 * fed to the firmware, to arecord-based tooling, or to another analyser.
 */
export function encodeWav(
  planar: Float32Array,
  channels: number,
  frames: number,
  sampleRate: number,
  bitsPerSample: 16 | 24 | 32 = 24,
): ArrayBuffer {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const writeTag = (offset: number, tag: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i));
  };

  writeTag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeTag(36, "data");
  view.setUint32(40, dataBytes, true);

  const clamp = (v: number, limit: number) =>
    Math.max(-limit, Math.min(limit - 1, Math.round(v * limit)));

  let p = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const v = planar[c * frames + f] ?? 0;
      if (bitsPerSample === 16) {
        view.setInt16(p, clamp(v, 32768), true);
      } else if (bitsPerSample === 24) {
        const s = clamp(v, 8388608);
        bytes[p] = s & 0xff;
        bytes[p + 1] = (s >> 8) & 0xff;
        bytes[p + 2] = (s >> 16) & 0xff;
      } else {
        view.setInt32(p, clamp(v, 2147483648), true);
      }
      p += bytesPerSample;
    }
  }

  return buffer;
}
