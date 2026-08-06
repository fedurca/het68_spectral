/*
 * WebGL2 spectrogram renderer for all six channels.
 *
 * Three decisions are worth explaining.
 *
 * One canvas, six viewports, one context. Six separate canvases would mean six GL
 * contexts and six uploads of the same colour map, and browsers start dropping
 * contexts after a dozen or so. A single context also makes the shared time axis and
 * shared colour scale automatic rather than something to keep in sync.
 *
 * A tile pyramid rather than one big texture. A five-minute recording at hop 1024 is
 * around 14000 frames, past the texture size limit on some machines, and drawing all
 * of them into 1000 pixels of screen would sample one column in fourteen — which is
 * exactly how a thin harmonic disappears. Each level is built by taking the maximum
 * over pairs of columns, so a narrow line survives being zoomed out. Averaging would
 * lose it in the noise floor around it, which is the wrong trade for this data.
 *
 * The frequency axis is inverted in the fragment shader. The alternative, resampling
 * on the CPU whenever the axis changes between linear, log and mel, would mean
 * re-uploading tens of megabytes per interaction. Doing it per pixel also lets the
 * shader take the maximum across every bin that falls inside a pixel, so a harmonic
 * one bin wide is still visible when the whole band is on screen.
 */

import { colormapLut, type ColormapName } from "./colormap.js";
import type { FrequencyScale } from "./scales.js";

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
uniform vec4 uRect; // x, y, w, h in clip space
void main() {
  vUv = aPos;
  gl_Position = vec4(uRect.x + aPos.x * uRect.z, uRect.y + aPos.y * uRect.w, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColour;

uniform sampler2D uData;
uniform sampler2D uLut;
uniform float uDbMin;
uniform float uDbMax;
uniform int uScale;      // 0 linear, 1 log, 2 mel
uniform float uFLo;
uniform float uFHi;
uniform float uBinHz;
uniform float uBins;     // valid bins in the texture
uniform float uTexHeight;
uniform float uTexWidth;
uniform float uPixelV;   // one output pixel in v units
uniform vec2 uTileU;     // visible sub-range of this tile in texture u

const float LOG_FLOOR = 20.0;

float unitToFreq(float u) {
  if (uScale == 0) {
    return uFLo + u * (uFHi - uFLo);
  } else if (uScale == 1) {
    float lo = max(uFLo, LOG_FLOOR);
    return exp(log(lo) + u * (log(uFHi) - log(lo)));
  } else {
    float lo = 2595.0 * log(1.0 + uFLo / 700.0) / log(10.0);
    float hi = 2595.0 * log(1.0 + uFHi / 700.0) / log(10.0);
    float mel = lo + u * (hi - lo);
    return 700.0 * (pow(10.0, mel / 2595.0) - 1.0);
  }
}

void main() {
  float u = uTileU.x + vUv.x * (uTileU.y - uTileU.x);

  // The band of bins this output pixel covers. Taking the maximum over it keeps a
  // one-bin harmonic visible when the whole spectrum is squeezed into a few hundred
  // pixels; a plain texture fetch would hit it only by luck.
  float fA = unitToFreq(clamp(vUv.y - uPixelV * 0.5, 0.0, 1.0));
  float fB = unitToFreq(clamp(vUv.y + uPixelV * 0.5, 0.0, 1.0));
  float bA = clamp(fA / uBinHz, 0.0, uBins - 1.0);
  float bB = clamp(fB / uBinHz, 0.0, uBins - 1.0);

  float taps = clamp(ceil(bB - bA) + 1.0, 1.0, 12.0);
  float best = -1e30;
  for (float i = 0.0; i < 12.0; i += 1.0) {
    if (i >= taps) break;
    float b = mix(bA, bB, taps <= 1.0 ? 0.0 : i / (taps - 1.0));
    float v = texture(uData, vec2(u, (b + 0.5) / uTexHeight)).r;
    best = max(best, v);
  }

  float t = clamp((best - uDbMin) / max(uDbMax - uDbMin, 1e-6), 0.0, 1.0);
  fragColour = vec4(texture(uLut, vec2(t, 0.5)).rgb, 1.0);
}`;

interface Tile {
  texture: WebGLTexture;
  /** First and last frame of this tile, in the level's own frame numbering. */
  startFrame: number;
  frames: number;
  width: number;
}

interface Level {
  /** Frames of the original spectrogram per column at this level. */
  decimation: number;
  frames: number;
  tiles: Tile[];
}

interface ChannelData {
  levels: Level[];
  frames: number;
  bins: number;
}

export interface SpectrogramView {
  /** Visible time range in frames of the original spectrogram. */
  frameFrom: number;
  frameTo: number;
  fLoHz: number;
  fHiHz: number;
  dbMin: number;
  dbMax: number;
  scale: FrequencyScale;
  colormap: ColormapName;
  binHz: number;
}

const SCALE_CODE: Record<FrequencyScale, number> = { linear: 0, log: 1, mel: 2 };

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return sh;
}

export class SpectrogramRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private lut: WebGLTexture;
  private lutName: ColormapName | null = null;
  private channels: (ChannelData | null)[] = [];
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private tileWidth: number;
  private textureBytes = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      // The spectrogram is redrawn on demand rather than every frame, so the
      // drawing buffer has to survive between draws.
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (!gl) {
      throw new Error(
        "WebGL2 is not available. Canvas 2D cannot keep up with a six-channel spectrogram on a long recording, so this build requires it.",
      );
    }
    this.gl = gl;

    // R16F rather than R32F: dB values span about 160 dB and half precision resolves
    // better than 0.05 dB over that range, which is far finer than anything visible,
    // and it halves the memory a six-channel spectrogram occupies on the GPU.
    if (!gl.getExtension("EXT_color_buffer_float")) {
      // Only needed for rendering to float targets, which this does not do; the
      // absence is not fatal but is worth knowing about when debugging.
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;

    for (const name of [
      "uRect",
      "uData",
      "uLut",
      "uDbMin",
      "uDbMax",
      "uScale",
      "uFLo",
      "uFHi",
      "uBinHz",
      "uBins",
      "uTexHeight",
      "uTexWidth",
      "uPixelV",
      "uTileU",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;

    this.lut = gl.createTexture()!;
    this.tileWidth = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
  }

  get gpuBytes(): number {
    return this.textureBytes;
  }

  private setLut(name: ColormapName) {
    if (this.lutName === name) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      colormapLut(name),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.lutName = name;
  }

  /** Replaces one channel's data and rebuilds its pyramid. */
  setChannel(channel: number, db: Float32Array, frames: number, bins: number): void {
    this.releaseChannel(channel);
    if (frames <= 0 || bins <= 0) {
      this.channels[channel] = null;
      return;
    }

    const levels: Level[] = [];
    let source = db;
    let levelFrames = frames;
    let decimation = 1;

    for (;;) {
      levels.push(this.uploadLevel(source, levelFrames, bins, decimation));
      if (levelFrames <= 1024) break;
      const nextFrames = levelFrames >> 1;
      if (nextFrames < 1) break;
      const reduced = new Float32Array(nextFrames * bins);
      for (let f = 0; f < nextFrames; f++) {
        const a = (2 * f) * bins;
        const b = Math.min(2 * f + 1, levelFrames - 1) * bins;
        const out = f * bins;
        for (let k = 0; k < bins; k++) {
          // Maximum, not mean: a harmonic one frame wide has to survive being
          // decimated, and the mean would bury it in the surrounding floor.
          const x = source[a + k]!;
          const y = source[b + k]!;
          reduced[out + k] = x > y ? x : y;
        }
      }
      source = reduced;
      levelFrames = nextFrames;
      decimation *= 2;
    }

    this.channels[channel] = { levels, frames, bins };
  }

  private uploadLevel(
    data: Float32Array,
    frames: number,
    bins: number,
    decimation: number,
  ): Level {
    const gl = this.gl;
    const tiles: Tile[] = [];

    for (let start = 0; start < frames; start += this.tileWidth) {
      const width = Math.min(this.tileWidth, frames - start);
      // The texture is bins-major so that one column of the spectrogram is one
      // column of the texture, which is what the shader's time coordinate indexes.
      const slice = new Float32Array(width * bins);
      for (let f = 0; f < width; f++) {
        const src = (start + f) * bins;
        for (let k = 0; k < bins; k++) slice[k * width + f] = data[src + k]!;
      }

      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R16F,
        width,
        bins,
        0,
        gl.RED,
        gl.FLOAT,
        slice,
      );
      // NEAREST in the time direction: the pyramid already handles minification,
      // and blending adjacent frames would smear a transient that matters.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this.textureBytes += width * bins * 2;
      tiles.push({ texture: tex, startFrame: start, frames: width, width });
    }

    return { decimation, frames, tiles };
  }

  private releaseChannel(channel: number): void {
    const data = this.channels[channel];
    if (!data) return;
    for (const level of data.levels) {
      for (const tile of level.tiles) {
        this.gl.deleteTexture(tile.texture);
        this.textureBytes -= tile.width * data.bins * 2;
      }
    }
    this.channels[channel] = null;
  }

  clear(): void {
    for (let c = 0; c < this.channels.length; c++) this.releaseChannel(c);
    this.channels = [];
    this.textureBytes = 0;
  }

  dispose(): void {
    this.clear();
    const gl = this.gl;
    gl.deleteTexture(this.lut);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }

  /**
   * Draws every loaded channel as a stacked row, newest state of `view` applied to
   * all of them so the time axis and colour scale are shared by construction.
   */
  draw(view: SpectrogramView, rowCount: number, gapPx = 2): void {
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width === 0 || height === 0) return;

    gl.viewport(0, 0, width, height);
    gl.clearColor(0.02, 0.03, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    this.setLut(view.colormap);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.uniform1i(this.uniforms.uLut!, 1);
    gl.uniform1i(this.uniforms.uData!, 0);
    gl.uniform1f(this.uniforms.uDbMin!, view.dbMin);
    gl.uniform1f(this.uniforms.uDbMax!, view.dbMax);
    gl.uniform1i(this.uniforms.uScale!, SCALE_CODE[view.scale]);
    gl.uniform1f(this.uniforms.uFLo!, view.fLoHz);
    gl.uniform1f(this.uniforms.uFHi!, view.fHiHz);
    gl.uniform1f(this.uniforms.uBinHz!, view.binHz);

    const rowHeightPx = (height - gapPx * (rowCount - 1)) / rowCount;
    gl.uniform1f(this.uniforms.uPixelV!, 1 / Math.max(rowHeightPx, 1));

    const visibleFrames = Math.max(1, view.frameTo - view.frameFrom);

    for (let row = 0; row < rowCount; row++) {
      const data = this.channels[row];
      if (!data) continue;

      // One texel per output pixel at most: the level whose columns are no finer
      // than the screen can show. Anything finer costs bandwidth for detail that
      // cannot be displayed and reintroduces the sampling problem the pyramid
      // exists to solve.
      const wanted = visibleFrames / Math.max(width, 1);
      let level = data.levels[0]!;
      for (const cand of data.levels) {
        if (cand.decimation <= wanted) level = cand;
      }

      const from = view.frameFrom / level.decimation;
      const to = view.frameTo / level.decimation;

      // Rows are drawn top to bottom; clip space runs the other way.
      const yTopPx = row * (rowHeightPx + gapPx);
      const y0 = 1 - (2 * (yTopPx + rowHeightPx)) / height;
      const rowH = (2 * rowHeightPx) / height;

      gl.uniform1f(this.uniforms.uBins!, data.bins);
      gl.uniform1f(this.uniforms.uTexHeight!, data.bins);

      for (const tile of level.tiles) {
        const tileFrom = tile.startFrame;
        const tileTo = tile.startFrame + tile.frames;
        if (tileTo <= from || tileFrom >= to) continue;

        const visFrom = Math.max(from, tileFrom);
        const visTo = Math.min(to, tileTo);

        // Where this tile lands on screen, in clip space.
        const xa = ((visFrom - from) / (to - from)) * 2 - 1;
        const xb = ((visTo - from) / (to - from)) * 2 - 1;

        gl.uniform4f(this.uniforms.uRect!, xa, y0, xb - xa, rowH);
        gl.uniform1f(this.uniforms.uTexWidth!, tile.width);
        gl.uniform2f(
          this.uniforms.uTileU!,
          (visFrom - tileFrom) / tile.width,
          (visTo - tileFrom) / tile.width,
        );

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tile.texture);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }

    gl.bindVertexArray(null);
  }
}
