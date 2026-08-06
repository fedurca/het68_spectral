/**
 * Ambient declaration for the Emscripten-generated module. The file is a build
 * artifact rather than a source file, so its shape is declared here instead of
 * being inferred; the exported names correspond one to one with the
 * EMSCRIPTEN_KEEPALIVE functions in csrc/h68_api.c.
 */
declare module "*/h68dsp.mjs" {
  /**
   * Heap views are properties rather than captured references because
   * ALLOW_MEMORY_GROWTH replaces the underlying ArrayBuffer when the heap grows,
   * detaching any view held from before.
   */
  export interface H68Module {
    HEAPF32: Float32Array;
    HEAP32: Int32Array;
    HEAPU8: Uint8Array;

    _h68_malloc(bytes: number): number;
    _h68_free(ptr: number): void;
    _h68_version(): number;
    _h68_arena_used_bytes(): number;
    _h68_arena_capacity_bytes(): number;
    _h68_fft_plan_count(): number;
    _h68_max_fft(): number;

    _h68_api_grating_hz(baselineMm: number, c: number): number;
    _h68_api_baseline_mm(i: number, j: number, edgeMm: number): number;
    _h68_api_pair_is_opposite(i: number, j: number): number;
    _h68_api_expected_lag(
      i: number,
      j: number,
      az: number,
      el: number,
      edgeMm: number,
      c: number,
      fs: number,
    ): number;
    _h68_api_sound_speed(tempC: number, rh: number, pa: number): number;
    _h68_api_lag_quantum_mm(c: number, fs: number): number;
    _h68_api_firmware_maxlag(edgeMm: number, fs: number): number;
    _h68_api_firmware_span(edgeMm: number, fs: number, doaN: number): number;
    _h68_api_angular_resolution_deg(edgeMm: number, c: number, fs: number): number;
    _h68_api_far_field_m(edgeMm: number, hz: number, c: number): number;
    _h68_api_air_absorption_db_per_m(
      hz: number,
      tempC: number,
      rh: number,
      pa: number,
    ): number;
    _h68_api_mic_positions(edgeMm: number, out18: number): void;
    _h68_api_pair_table(out30: number): void;

    _h68_api_stft_configure(
      fftSize: number,
      winLength: number,
      hop: number,
      windowKind: number,
      beta: number,
      fs: number,
    ): number;
    _h68_api_stft_bins(): number;
    _h68_api_stft_frames(nsamples: number): number;
    _h68_api_stft_metrics(out16: number): number;
    _h68_api_stft_analyze(
      x: number,
      nsamples: number,
      floorDb: number,
      outDb: number,
      outPhase: number,
    ): number;
    _h68_api_stft_analyze_all(
      planar: number,
      nch: number,
      nsamples: number,
      floorDb: number,
      outDb: number,
    ): number;
    _h68_api_stft_magnitude_linear(
      x: number,
      nsamples: number,
      outMag: number,
    ): number;

    _h68_api_band_metrics(
      planar: number,
      nch: number,
      nsamples: number,
      bandLo: number,
      bandHi: number,
      nbands: number,
      noisePct: number,
      outEnergyDb: number,
      outTonalityDb: number,
      outPeakHz: number,
      outFloorDb: number,
    ): number;
    _h68_api_db_percentile(series: number, n: number, pct: number): number;

    _h68_api_gcc_column(
      xi: number,
      xj: number,
      blockLen: number,
      nfft: number,
      usePhat: number,
      maxLag: number,
      fLo: number,
      fHi: number,
      fs: number,
      outCorr: number,
      outStats: number,
    ): number;
    _h68_api_gcc_surface(
      xi: number,
      xj: number,
      nsamples: number,
      blockLen: number,
      hop: number,
      nfft: number,
      usePhat: number,
      maxLag: number,
      fLo: number,
      fHi: number,
      fs: number,
      outSurface: number,
      outStats: number,
    ): number;
    _h68_api_gcc_columns(nsamples: number, blockLen: number, hop: number): number;
    _h68_api_coherence(
      xi: number,
      xj: number,
      nsamples: number,
      nfft: number,
      hop: number,
      windowKind: number,
      beta: number,
      outMsc: number,
    ): number;
    _h68_api_coherence_band(
      msc: number,
      nfft: number,
      fs: number,
      fLo: number,
      fHi: number,
    ): number;

    _h68_api_channel_stats(
      planar: number,
      nch: number,
      n: number,
      clipThresh: number,
      out: number,
    ): void;
    _h68_api_channel_correlations(planar: number, n: number, out15: number): void;
    _h68_api_mapping_probe(
      planar: number,
      nch: number,
      n: number,
      fs: number,
      toneHz: number,
      slotMs: number,
      outActive: number,
      outMarginDb: number,
      maxSlots: number,
    ): number;
    _h68_api_goertzel(x: number, n: number, hz: number, fs: number): number;

    _h68_api_f0_candidates(
      mag: number,
      bins: number,
      binHz: number,
      fLo: number,
      fHi: number,
      nHarm: number,
      blades: number,
      out: number,
      maxOut: number,
    ): number;
    _h68_api_f0_track(
      mag: number,
      frames: number,
      bins: number,
      binHz: number,
      fLo: number,
      fHi: number,
      nHarm: number,
      blades: number,
      maxRelJump: number,
      maxMiss: number,
      out: number,
    ): number;
    _h68_api_hnr_db(
      mag: number,
      bins: number,
      binHz: number,
      f0: number,
      nHarm: number,
      fLo: number,
      fHi: number,
    ): number;
    _h68_api_cepstrum(
      mag: number,
      bins: number,
      cepsSize: number,
      out: number,
    ): number;

    _h68_api_signature_floats(): number;
    _h68_api_signature_extract(
      mag: number,
      frames: number,
      bins: number,
      binHz: number,
      fLo: number,
      fHi: number,
      nHarm: number,
      blades: number,
      bandEdges: number,
      nBands: number,
      outSig: number,
    ): number;
    _h68_api_signature_match_frames(
      sigFloats: number,
      mag: number,
      frames: number,
      bins: number,
      binHz: number,
      bandEdges: number,
      out: number,
    ): number;
    _h68_api_signature_distance(a: number, b: number): number;

    _h68_api_synth_floats(): number;
    _h68_api_synth_defaults_neo2(fs: number, n: number, out: number): void;
    _h68_api_synth_render(params: number, outPlanar: number): number;
  }

  const factory: (options?: Record<string, unknown>) => Promise<H68Module>;
  export default factory;
}
