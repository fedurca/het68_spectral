/*
 * The capture AudioWorklet, as a source string.
 *
 * It is inlined rather than being a separate file because an AudioWorklet module is
 * fetched by URL at runtime, and under Cross-Origin-Embedder-Policy: require-corp a
 * blob URL is the one form that loads identically from the dev server, from the
 * Cloudflare worker and from Electron's file:// origin.
 *
 * The processor does as little as possible: it copies the input into a ring and posts
 * whole blocks. Anything heavier here would run on the audio thread and show up as
 * dropouts.
 */

export const CAPTURE_WORKLET_SOURCE = String.raw`
class Het68Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.blockFrames = opts.blockFrames || 4800;
    this.channels = opts.channels || 6;
    this.buffer = new Float32Array(this.channels * this.blockFrames);
    this.filled = 0;
    this.startSample = 0;
    this.reportedChannels = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    if (input.length !== this.reportedChannels) {
      // The number of channels the graph actually delivers is not necessarily what
      // was requested, and the difference matters enough to report immediately.
      this.reportedChannels = input.length;
      this.port.postMessage({ type: 'channels', channels: input.length });
    }

    const frames = input[0].length;
    const n = Math.min(this.channels, input.length);

    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < this.channels; c++) {
        const src = c < n ? input[c] : null;
        this.buffer[c * this.blockFrames + this.filled] = src ? src[f] : 0;
      }
      this.filled++;
      if (this.filled === this.blockFrames) {
        const copy = this.buffer.slice();
        this.port.postMessage(
          {
            type: 'block',
            planar: copy,
            frames: this.blockFrames,
            channels: this.channels,
            startSample: this.startSample,
          },
          [copy.buffer],
        );
        this.startSample += this.blockFrames;
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('het68-capture', Het68Capture);
`;

export function captureWorkletUrl(): string {
  return URL.createObjectURL(
    new Blob([CAPTURE_WORKLET_SOURCE], { type: "application/javascript" }),
  );
}
