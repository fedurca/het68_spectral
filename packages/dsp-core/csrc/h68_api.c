/*
 * Flat export surface for WebAssembly.
 *
 * Two rules shape this file. First, calls are coarse: a whole lag-by-time surface
 * or a whole six-channel spectrogram comes back from one call, because per-frame
 * round trips between JS and wasm cost more than the arithmetic does. Second,
 * nothing here returns a struct by value or a pointer into C memory that JS has to
 * interpret; composite results are written into caller-supplied float arrays in a
 * documented order, so the binding stays a thin cast rather than a layout contract
 * that breaks silently when a field is added.
 */
#include <math.h>
#include <string.h>

#include "h68_arena.h"
#include "h68_bands.h"
#include "h68_dsp.h"
#include "h68_fft.h"
#include "h68_geometry.h"
#include "h68_harmonic.h"
#include "h68_health.h"
#include "h68_pairs.h"
#include "h68_signature.h"
#include "h68_stft.h"
#include "h68_synth.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define H68_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define H68_EXPORT
#endif

#include <stdlib.h>

#define H68_API_VERSION 1

/* ---- host-side buffer management ---------------------------------------
 * These exist so JS can obtain wasm heap space for its own audio and result
 * buffers. They are not part of any processing path; the DSP itself never
 * allocates. */
H68_EXPORT void *h68_malloc(int bytes) {
  return (bytes > 0) ? malloc((size_t)bytes) : NULL;
}

H68_EXPORT void h68_free(void *p) { free(p); }

H68_EXPORT int h68_version(void) { return H68_API_VERSION; }
H68_EXPORT int h68_arena_used_bytes(void) { return (int)h68_arena_used(); }
H68_EXPORT int h68_arena_capacity_bytes(void) { return (int)h68_arena_capacity(); }
H68_EXPORT int h68_fft_plan_count(void) { return h68_fft_plans_cached(); }
H68_EXPORT int h68_max_fft(void) { return H68_MAX_FFT; }

/* ---- geometry ---------------------------------------------------------- */

H68_EXPORT float h68_api_grating_hz(float baseline_mm, float c_mps) {
  return h68_grating_hz(baseline_mm, c_mps);
}

H68_EXPORT float h68_api_baseline_mm(int i, int j, float edge_mm) {
  return h68_baseline_mm(i, j, edge_mm);
}

H68_EXPORT int h68_api_pair_is_opposite(int i, int j) {
  return h68_pair_is_opposite(i, j);
}

H68_EXPORT float h68_api_expected_lag(int i, int j, float az, float el,
                                      float edge_mm, float c_mps, float fs) {
  return h68_expected_lag_samples(i, j, az, el, edge_mm, c_mps, fs);
}

H68_EXPORT float h68_api_sound_speed(float temp_c, float rh, float pa) {
  return h68_sound_speed(temp_c, rh, pa);
}

H68_EXPORT float h68_api_lag_quantum_mm(float c_mps, float fs) {
  return h68_lag_quantum_mm(c_mps, fs);
}

H68_EXPORT int h68_api_firmware_maxlag(float edge_mm, float fs) {
  return h68_firmware_maxlag(edge_mm, fs);
}

H68_EXPORT int h68_api_firmware_span(float edge_mm, float fs, int doa_n) {
  return h68_firmware_span(edge_mm, fs, doa_n);
}

H68_EXPORT float h68_api_angular_resolution_deg(float edge_mm, float c_mps,
                                                float fs) {
  return h68_angular_resolution_deg(edge_mm, c_mps, fs);
}

H68_EXPORT float h68_api_far_field_m(float edge_mm, float hz, float c_mps) {
  return h68_far_field_m(edge_mm, hz, c_mps);
}

H68_EXPORT float h68_api_air_absorption_db_per_m(float hz, float t, float rh,
                                                 float pa) {
  return h68_air_absorption_db_per_m(hz, t, rh, pa);
}

/* Writes the 6 mic positions in mm as 18 floats, xyz per mic. */
H68_EXPORT void h68_api_mic_positions(float edge_mm, float *out18) {
  if (!out18) return;
  for (int m = 0; m < H68_NCH; ++m) {
    h68_mic_pos_mm(m, edge_mm, out18 + m * 3);
  }
}

/* Writes the 15 pair indices as 30 ints (i, j per pair). */
H68_EXPORT void h68_api_pair_table(int *out30) {
  if (!out30) return;
  for (int p = 0; p < H68_NPAIRS; ++p) {
    out30[p * 2 + 0] = H68_PAIR_I[p];
    out30[p * 2 + 1] = H68_PAIR_J[p];
  }
}

/* ---- STFT ------------------------------------------------------------- */

H68_EXPORT int h68_api_stft_configure(int fft_size, int win_length, int hop,
                                      int window_kind, float beta, float fs) {
  return (int)h68_stft_configure(fft_size, win_length, hop,
                                 (h68_window_kind)window_kind, beta, fs);
}

H68_EXPORT int h68_api_stft_bins(void) { return h68_stft_bins(); }
H68_EXPORT int h68_api_stft_frames(int nsamples) {
  return h68_stft_frame_count(nsamples);
}

/* Metrics as 16 floats, in this order:
 *  0 fft_size        1 hop            2 win_length     3 sample_rate
 *  4 bin_hz          5 window_ms      6 hop_ms         7 overlap
 *  8 enbw_bins       9 enbw_hz       10 coherent_gain 11 scallop_db
 * 12 nenbw          13 sidelobe_db   14 unused        15 unused */
H68_EXPORT int h68_api_stft_metrics(float *out16) {
  const h68_stft_metrics *m = h68_stft_metrics_get();
  if (!m || !out16) return (int)H68_ERR_STATE;
  out16[0] = (float)m->fft_size;
  out16[1] = (float)m->hop;
  out16[2] = (float)m->win_length;
  out16[3] = m->sample_rate;
  out16[4] = m->bin_hz;
  out16[5] = m->window_ms;
  out16[6] = m->hop_ms;
  out16[7] = m->overlap;
  out16[8] = m->enbw_bins;
  out16[9] = m->enbw_hz;
  out16[10] = m->coherent_gain;
  out16[11] = m->scallop_db;
  out16[12] = m->nenbw;
  out16[13] = m->sidelobe_db;
  out16[14] = 0.0f;
  out16[15] = 0.0f;
  return (int)H68_OK;
}

/* One channel to dB (and optionally phase). Pass 0 for out_phase to skip it. */
H68_EXPORT int h68_api_stft_analyze(const float *x, int nsamples, float floor_db,
                                    float *out_db, float *out_phase) {
  return (int)h68_stft_analyze(x, nsamples, floor_db, out_db, out_phase);
}

/* All six channels in one call. planar holds nch blocks of nsamples; out_db
 * receives nch blocks of frames*bins. */
H68_EXPORT int h68_api_stft_analyze_all(const float *planar, int nch,
                                        int nsamples, float floor_db,
                                        float *out_db) {
  if (!planar || !out_db || nch <= 0 || nch > H68_NCH) return (int)H68_ERR_ARG;
  const int bins = h68_stft_bins();
  const int frames = h68_stft_frame_count(nsamples);
  if (bins <= 0 || frames <= 0) return (int)H68_ERR_STATE;
  const size_t stride = (size_t)frames * (size_t)bins;
  for (int c = 0; c < nch; ++c) {
    const h68_status st =
        h68_stft_analyze(planar + (size_t)c * (size_t)nsamples, nsamples,
                         floor_db, out_db + (size_t)c * stride, NULL);
    if (st != H68_OK) return (int)st;
  }
  return (int)H68_OK;
}

/* Linear magnitude for one channel, which is what the harmonic and signature
 * routines expect. */
H68_EXPORT int h68_api_stft_magnitude_linear(const float *x, int nsamples,
                                             float *out_mag) {
  if (!x || !out_mag) return (int)H68_ERR_ARG;
  const int bins = h68_stft_bins();
  const int frames = h68_stft_frame_count(nsamples);
  if (bins <= 0 || frames <= 0) return (int)H68_ERR_STATE;
  /* Reuse the dB path and undo the log: one code path for the normalisation means
   * the two representations cannot drift apart. */
  const h68_status st = h68_stft_analyze(x, nsamples, -400.0f, out_mag, NULL);
  if (st != H68_OK) return (int)st;
  const size_t n = (size_t)frames * (size_t)bins;
  for (size_t i = 0; i < n; ++i) {
    out_mag[i] = (out_mag[i] <= -399.0f) ? 0.0f
                                        : powf(10.0f, out_mag[i] / 20.0f);
  }
  return (int)H68_OK;
}

/* ---- watched frequency bands ------------------------------------------ */

/* Band energy, tonality and peak for every channel and frame, computed straight
 * from planar audio so nothing the size of a spectrogram has to cross the boundary
 * twice.
 *
 * Each output holds nch * nbands * frames values, indexed
 * (ch * nbands + band) * frames + frame. out_floor holds nch * nbands and carries
 * the per-band noise floor at the requested percentile, which is what turns a band
 * energy into an SNR.
 *
 * Any of the outputs may be NULL. */
H68_EXPORT int h68_api_band_metrics(const float *planar, int nch, int nsamples,
                                    const float *band_lo, const float *band_hi,
                                    int nbands, float noise_pct,
                                    float *out_energy_db, float *out_tonality_db,
                                    float *out_peak_hz, float *out_floor_db) {
  if (!planar || !band_lo || !band_hi || nch <= 0 || nch > H68_NCH) {
    return (int)H68_ERR_ARG;
  }
  if (nbands <= 0) return (int)H68_ERR_ARG;

  const int bins = h68_stft_bins();
  const int frames = h68_stft_frame_count(nsamples);
  if (bins <= 0 || frames <= 0) return (int)H68_ERR_STATE;

  const h68_stft_metrics *m = h68_stft_metrics_get();
  if (!m) return (int)H68_ERR_STATE;
  const float bin_hz = m->bin_hz;
  const int hop = m->hop;

  static float mag[H68_MAX_BINS];

  for (int c = 0; c < nch; ++c) {
    const float *x = planar + (size_t)c * (size_t)nsamples;
    for (int f = 0; f < frames; ++f) {
      /* One transform per frame, then every band reads the same spectrum. Doing it
       * the other way round costs a transform per band and gives identical
       * numbers. */
      if (h68_stft_frame_magnitude(x + (size_t)f * (size_t)hop, mag) != H68_OK) {
        return (int)H68_ERR_STATE;
      }
      for (int b = 0; b < nbands; ++b) {
        const h68_band_frame r =
            h68_band_frame_metrics(mag, bins, bin_hz, band_lo[b], band_hi[b]);
        const size_t idx = ((size_t)c * (size_t)nbands + (size_t)b) *
                               (size_t)frames +
                           (size_t)f;
        if (out_energy_db) out_energy_db[idx] = r.energy_db;
        if (out_tonality_db) out_tonality_db[idx] = r.tonality_db;
        if (out_peak_hz) out_peak_hz[idx] = r.peak_hz;
      }
    }
  }

  if (out_floor_db && out_energy_db) {
    for (int c = 0; c < nch; ++c) {
      for (int b = 0; b < nbands; ++b) {
        const size_t base =
            ((size_t)c * (size_t)nbands + (size_t)b) * (size_t)frames;
        out_floor_db[c * nbands + b] =
            h68_db_percentile(out_energy_db + base, frames, noise_pct);
      }
    }
  }
  return frames;
}

H68_EXPORT float h68_api_db_percentile(const float *series, int n, float pct) {
  return h68_db_percentile(series, n, pct);
}

/* ---- pair analysis ---------------------------------------------------- */

/* Single GCC column. out_corr gets 2*maxlag+1 values; out_stats gets 6 floats:
 * peak_lag, peak_value, second_lag, second_value, peak_ratio, peak_index. */
H68_EXPORT int h68_api_gcc_column(const float *xi, const float *xj,
                                  int block_len, int nfft, int use_phat,
                                  int max_lag, float f_lo, float f_hi, float fs,
                                  float *out_corr, float *out_stats) {
  h68_gcc_result r;
  memset(&r, 0, sizeof(r));
  const h68_status st = h68_gcc_column(xi, xj, block_len, nfft, use_phat, max_lag,
                                       f_lo, f_hi, fs, out_corr, &r);
  if (out_stats) {
    out_stats[0] = r.peak_lag;
    out_stats[1] = r.peak_value;
    out_stats[2] = r.second_lag;
    out_stats[3] = r.second_value;
    out_stats[4] = r.peak_ratio;
    out_stats[5] = (float)r.peak_index;
  }
  return (int)st;
}

/* The whole lag-by-time surface for one pair in a single call.
 *
 * out_surface receives columns * (2*max_lag+1) floats, column major in time.
 * out_stats receives columns * 6 floats laid out as in h68_api_gcc_column. This is
 * the view that shows whether a delay is stable or hopping between grating lobes,
 * which is the question a 384 mm cube has to answer for the drone band. */
H68_EXPORT int h68_api_gcc_surface(const float *xi, const float *xj,
                                   int nsamples, int block_len, int hop,
                                   int nfft, int use_phat, int max_lag,
                                   float f_lo, float f_hi, float fs,
                                   float *out_surface, float *out_stats) {
  if (!xi || !xj || nsamples < block_len || hop <= 0) return (int)H68_ERR_ARG;
  const int span = 2 * max_lag + 1;
  const int columns = (nsamples - block_len) / hop + 1;
  for (int c = 0; c < columns; ++c) {
    const size_t off = (size_t)c * (size_t)hop;
    h68_gcc_result r;
    memset(&r, 0, sizeof(r));
    float *corr = out_surface ? out_surface + (size_t)c * (size_t)span : NULL;
    const h68_status st =
        h68_gcc_column(xi + off, xj + off, block_len, nfft, use_phat, max_lag,
                       f_lo, f_hi, fs, corr, &r);
    if (st != H68_OK) return (int)st;
    if (out_stats) {
      float *s = out_stats + (size_t)c * 6u;
      s[0] = r.peak_lag;
      s[1] = r.peak_value;
      s[2] = r.second_lag;
      s[3] = r.second_value;
      s[4] = r.peak_ratio;
      s[5] = (float)r.peak_index;
    }
  }
  return columns;
}

H68_EXPORT int h68_api_gcc_columns(int nsamples, int block_len, int hop) {
  if (nsamples < block_len || hop <= 0) return 0;
  return (nsamples - block_len) / hop + 1;
}

H68_EXPORT int h68_api_coherence(const float *xi, const float *xj, int nsamples,
                                 int nfft, int hop, int window_kind, float beta,
                                 float *out_msc) {
  int frames = 0;
  const h68_status st = h68_coherence(xi, xj, nsamples, nfft, hop,
                                      (h68_window_kind)window_kind, beta,
                                      out_msc, &frames);
  return (st == H68_OK) ? frames : (int)st;
}

H68_EXPORT float h68_api_coherence_band(const float *msc, int nfft, float fs,
                                        float f_lo, float f_hi) {
  return h68_coherence_band(msc, nfft, fs, f_lo, f_hi);
}

/* ---- health ----------------------------------------------------------- */

/* 13 floats per channel:
 *  0 rms       1 rms_db      2 peak       3 peak_db     4 crest_db
 *  5 dc        6 clipped     7 silent     8 noise_floor_db
 *  9 zcr      10 dead       11 saturated 12 unused */
H68_EXPORT void h68_api_channel_stats(const float *planar, int nch, int n,
                                      float clip_thresh, float *out) {
  if (!planar || !out || nch <= 0) return;
  for (int c = 0; c < nch; ++c) {
    h68_channel_stats s;
    h68_channel_stats_compute(planar + (size_t)c * (size_t)n, n, clip_thresh, &s);
    float *o = out + (size_t)c * 13u;
    o[0] = s.rms;
    o[1] = s.rms_db;
    o[2] = s.peak;
    o[3] = s.peak_db;
    o[4] = s.crest_db;
    o[5] = s.dc;
    o[6] = (float)s.clipped_samples;
    o[7] = (float)s.silent_samples;
    o[8] = s.noise_floor_db;
    o[9] = s.zero_crossing_rate;
    o[10] = (float)s.dead;
    o[11] = (float)s.saturated;
    o[12] = 0.0f;
  }
}

/* Correlation matrix for all 15 pairs, in H68_PAIR order. */
H68_EXPORT void h68_api_channel_correlations(const float *planar, int n,
                                            float *out15) {
  if (!planar || !out15) return;
  for (int p = 0; p < H68_NPAIRS; ++p) {
    out15[p] = h68_channel_correlation(planar + (size_t)H68_PAIR_I[p] * (size_t)n,
                                       planar + (size_t)H68_PAIR_J[p] * (size_t)n,
                                       n);
  }
}

H68_EXPORT int h68_api_mapping_probe(const float *planar, int nch, int n,
                                     float fs, float tone_hz, float slot_ms,
                                     int *out_active, float *out_margin_db,
                                     int max_slots) {
  int slots = 0;
  const h68_status st = h68_mapping_probe(planar, nch, n, fs, tone_hz, slot_ms,
                                          out_active, out_margin_db, max_slots,
                                          &slots);
  return (st == H68_OK) ? slots : (int)st;
}

H68_EXPORT float h68_api_goertzel(const float *x, int n, float hz, float fs) {
  return h68_goertzel(x, n, hz, fs);
}

/* ---- harmonic analysis ------------------------------------------------ */

/* Candidates as 5 floats each: f0_hz, score, rpm, hnr_db, n_harmonics. */
H68_EXPORT int h68_api_f0_candidates(const float *mag, int bins, float bin_hz,
                                     float f_lo, float f_hi, int n_harm,
                                     int blades, float *out, int max_out) {
  h68_f0_candidate c[H68_MAX_F0_CANDIDATES];
  int n = 0;
  if (max_out > H68_MAX_F0_CANDIDATES) max_out = H68_MAX_F0_CANDIDATES;
  const h68_status st = h68_f0_candidates(mag, bins, bin_hz, f_lo, f_hi, n_harm,
                                          blades, c, max_out, &n);
  if (st != H68_OK) return (int)st;
  if (out) {
    for (int i = 0; i < n; ++i) {
      out[i * 5 + 0] = c[i].f0_hz;
      out[i * 5 + 1] = c[i].score;
      out[i * 5 + 2] = c[i].rpm;
      out[i * 5 + 3] = c[i].hnr_db;
      out[i * 5 + 4] = (float)c[i].n_harmonics;
    }
  }
  return n;
}

/* Tracks f0 across a whole magnitude spectrogram in one call.
 * out receives 4 floats per frame: f0_hz, rpm, score, locked. */
H68_EXPORT int h68_api_f0_track(const float *mag, int frames, int bins,
                                float bin_hz, float f_lo, float f_hi,
                                int n_harm, int blades, float max_rel_jump,
                                int max_miss, float *out) {
  if (!mag || !out || frames <= 0) return (int)H68_ERR_ARG;
  h68_comb_tracker t;
  h68_comb_tracker_reset(&t);
  for (int f = 0; f < frames; ++f) {
    h68_f0_candidate c[H68_MAX_F0_CANDIDATES];
    int n = 0;
    const float *row = mag + (size_t)f * (size_t)bins;
    if (h68_f0_candidates(row, bins, bin_hz, f_lo, f_hi, n_harm, blades, c,
                          H68_MAX_F0_CANDIDATES, &n) != H68_OK) {
      n = 0;
    }
    h68_comb_tracker_update(&t, c, n, max_rel_jump, max_miss);
    float *o = out + (size_t)f * 4u;
    o[0] = t.locked ? t.f0 : 0.0f;
    o[1] = t.locked ? (t.f0 / (float)(blades > 0 ? blades : 1) * 60.0f) : 0.0f;
    o[2] = t.confidence;
    o[3] = (float)t.locked;
  }
  return frames;
}

H68_EXPORT float h68_api_hnr_db(const float *mag, int bins, float bin_hz,
                                float f0, int n_harm, float f_lo, float f_hi) {
  return h68_hnr_db(mag, bins, bin_hz, f0, n_harm, f_lo, f_hi);
}

H68_EXPORT int h68_api_cepstrum(const float *mag, int bins, int ceps_size,
                                float *out) {
  return (int)h68_cepstrum(mag, bins, ceps_size, out);
}

/* ---- signatures ------------------------------------------------------- */

/* Templates cross the boundary as a flat float array so the JSON schema on the JS
 * side owns the layout. Order:
 *   0 version            1 blades            2 n_combs        3 n_harmonics
 *   4 n_bands            5 hnr_db            6 hnr_sd_db      7 f0_gate_lo
 *   8 f0_gate_hi         9 f0_drift_pct     10 mod_depth_db  11 n_frames
 *  12..19  comb_ratios[8]
 *  20..35  harmonic_rel_db[16]
 *  36..51  harmonic_sd_db[16]
 *  52..59  band_rel_db[8]
 * total 60 floats */
#define H68_SIG_FLOATS 60

H68_EXPORT int h68_api_signature_floats(void) { return H68_SIG_FLOATS; }

static void sig_to_floats(const h68_signature *s, float *o) {
  memset(o, 0, sizeof(float) * H68_SIG_FLOATS);
  o[0] = (float)s->version;
  o[1] = (float)s->blades;
  o[2] = (float)s->n_combs;
  o[3] = (float)s->n_harmonics;
  o[4] = (float)s->n_bands;
  o[5] = s->hnr_db;
  o[6] = s->hnr_sd_db;
  o[7] = s->f0_gate_lo_hz;
  o[8] = s->f0_gate_hi_hz;
  o[9] = s->f0_drift_pct;
  o[10] = s->mod_depth_db;
  o[11] = (float)s->n_frames;
  for (int i = 0; i < H68_SIG_MAX_COMBS; ++i) o[12 + i] = s->comb_ratios[i];
  for (int i = 0; i < H68_SIG_MAX_HARM; ++i) o[20 + i] = s->harmonic_rel_db[i];
  for (int i = 0; i < H68_SIG_MAX_HARM; ++i) o[36 + i] = s->harmonic_sd_db[i];
  for (int i = 0; i < H68_SIG_MAX_BANDS; ++i) o[52 + i] = s->band_rel_db[i];
}

static void floats_to_sig(const float *o, h68_signature *s) {
  memset(s, 0, sizeof(*s));
  s->version = (int)o[0];
  s->blades = (int)o[1];
  s->n_combs = (int)o[2];
  s->n_harmonics = (int)o[3];
  s->n_bands = (int)o[4];
  s->hnr_db = o[5];
  s->hnr_sd_db = o[6];
  s->f0_gate_lo_hz = o[7];
  s->f0_gate_hi_hz = o[8];
  s->f0_drift_pct = o[9];
  s->mod_depth_db = o[10];
  s->n_frames = (int)o[11];
  for (int i = 0; i < H68_SIG_MAX_COMBS; ++i) s->comb_ratios[i] = o[12 + i];
  for (int i = 0; i < H68_SIG_MAX_HARM; ++i) s->harmonic_rel_db[i] = o[20 + i];
  for (int i = 0; i < H68_SIG_MAX_HARM; ++i) s->harmonic_sd_db[i] = o[36 + i];
  for (int i = 0; i < H68_SIG_MAX_BANDS; ++i) s->band_rel_db[i] = o[52 + i];
}

H68_EXPORT int h68_api_signature_extract(const float *mag, int frames, int bins,
                                         float bin_hz, float f_lo, float f_hi,
                                         int n_harm, int blades,
                                         const float *band_edges, int n_bands,
                                         float *out_sig) {
  h68_signature s;
  const h68_status st =
      h68_signature_extract(mag, frames, bins, bin_hz, f_lo, f_hi, n_harm,
                            blades, band_edges, n_bands, &s);
  if (st != H68_OK) return (int)st;
  if (out_sig) sig_to_floats(&s, out_sig);
  return s.n_frames;
}

/* Scores every frame of a spectrogram against a template.
 * out receives 2 floats per frame: score, matched f0. */
H68_EXPORT int h68_api_signature_match_frames(const float *sig_floats,
                                              const float *mag, int frames,
                                              int bins, float bin_hz,
                                              const float *band_edges,
                                              float *out) {
  if (!sig_floats || !mag || !out || frames <= 0) return (int)H68_ERR_ARG;
  h68_signature s;
  floats_to_sig(sig_floats, &s);
  for (int f = 0; f < frames; ++f) {
    float f0 = 0.0f;
    const float score = h68_signature_match(
        &s, mag + (size_t)f * (size_t)bins, bins, bin_hz, band_edges, &f0);
    out[f * 2 + 0] = score;
    out[f * 2 + 1] = f0;
  }
  return frames;
}

H68_EXPORT float h68_api_signature_distance(const float *a, const float *b) {
  if (!a || !b) return 1e30f;
  h68_signature sa, sb;
  floats_to_sig(a, &sa);
  floats_to_sig(b, &sb);
  return h68_signature_distance(&sa, &sb);
}

/* ---- synthetic scenes ------------------------------------------------- */

/* Parameters arrive as a flat float array so the TS side owns the schema:
 *  0 sample_rate      1 n_samples        2 edge_mm         3 temp_c
 *  4 humidity_pct     5 pressure_pa      6 air_absorption  7 az_deg
 *  8 el_deg           9 distance_m      10 n_rotors       11 blades
 * 12 rpm_jitter_pct  13 rpm_ramp_pct    14 n_harmonics    15 harmonic_rolloff_db
 * 16 tonal_level_db  17 broadband_level_db  18 broadband_lo  19 broadband_hi
 * 20 wind_level_db   21 wind_cutoff_hz  22 background_level_db
 * 23 tone_hz         24 tone_level_db   25 seed
 * 26..33 rpm[8]
 * total 34 floats */
#define H68_SYNTH_FLOATS 34

H68_EXPORT int h68_api_synth_floats(void) { return H68_SYNTH_FLOATS; }

H68_EXPORT void h68_api_synth_defaults_neo2(float fs, int n, float *out) {
  if (!out) return;
  h68_synth_params p;
  h68_synth_defaults_neo2(&p, fs, n);
  out[0] = p.sample_rate;
  out[1] = (float)p.n_samples;
  out[2] = p.edge_mm;
  out[3] = p.temp_c;
  out[4] = p.humidity_pct;
  out[5] = p.pressure_pa;
  out[6] = (float)p.air_absorption;
  out[7] = p.az_deg;
  out[8] = p.el_deg;
  out[9] = p.distance_m;
  out[10] = (float)p.n_rotors;
  out[11] = (float)p.blades;
  out[12] = p.rpm_jitter_pct;
  out[13] = p.rpm_ramp_pct;
  out[14] = (float)p.n_harmonics;
  out[15] = p.harmonic_rolloff_db;
  out[16] = p.tonal_level_db;
  out[17] = p.broadband_level_db;
  out[18] = p.broadband_lo_hz;
  out[19] = p.broadband_hi_hz;
  out[20] = p.wind_level_db;
  out[21] = p.wind_cutoff_hz;
  out[22] = p.background_level_db;
  out[23] = p.tone_hz;
  out[24] = p.tone_level_db;
  out[25] = (float)p.seed;
  for (int i = 0; i < H68_SYNTH_MAX_ROTORS; ++i) out[26 + i] = p.rpm[i];
}

H68_EXPORT int h68_api_synth_render(const float *params, float *out_planar) {
  if (!params || !out_planar) return (int)H68_ERR_ARG;
  h68_synth_params p;
  memset(&p, 0, sizeof(p));
  p.sample_rate = params[0];
  p.n_samples = (int)params[1];
  p.edge_mm = params[2];
  p.temp_c = params[3];
  p.humidity_pct = params[4];
  p.pressure_pa = params[5];
  p.air_absorption = (int)params[6];
  p.az_deg = params[7];
  p.el_deg = params[8];
  p.distance_m = params[9];
  p.n_rotors = (int)params[10];
  p.blades = (int)params[11];
  p.rpm_jitter_pct = params[12];
  p.rpm_ramp_pct = params[13];
  p.n_harmonics = (int)params[14];
  p.harmonic_rolloff_db = params[15];
  p.tonal_level_db = params[16];
  p.broadband_level_db = params[17];
  p.broadband_lo_hz = params[18];
  p.broadband_hi_hz = params[19];
  p.wind_level_db = params[20];
  p.wind_cutoff_hz = params[21];
  p.background_level_db = params[22];
  p.tone_hz = params[23];
  p.tone_level_db = params[24];
  p.seed = (unsigned int)params[25];
  for (int i = 0; i < H68_SYNTH_MAX_ROTORS; ++i) p.rpm[i] = params[26 + i];
  return (int)h68_synth_render(&p, out_planar);
}
