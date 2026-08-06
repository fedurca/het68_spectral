#include "h68_pairs.h"

#include <math.h>
#include <string.h>

#include "h68_fft.h"
#include "h68_window.h"

static float g_pad_i[H68_MAX_FFT];
static float g_pad_j[H68_MAX_FFT];
static kiss_fft_cpx g_xi[H68_MAX_BINS];
static kiss_fft_cpx g_xj[H68_MAX_BINS];
static kiss_fft_cpx g_cross[H68_MAX_BINS];
static float g_corr[H68_MAX_FFT];

/* Coherence accumulators, kept separate so a coherence run does not disturb an
 * in-flight correlation. */
static float g_sxx[H68_MAX_BINS];
static float g_syy[H68_MAX_BINS];
static kiss_fft_cpx g_sxy[H68_MAX_BINS];
static float g_coh_win[H68_MAX_FFT];

static int is_pow2(int v) { return v > 0 && (v & (v - 1)) == 0; }

static int band_to_bin(float hz, int nfft, float sample_rate, int clamp_hi) {
  if (sample_rate <= 0.0f) return clamp_hi;
  int k = (int)lrintf(hz / (sample_rate / (float)nfft));
  if (k < 0) k = 0;
  if (k > nfft / 2) k = nfft / 2;
  return k;
}

h68_status h68_gcc_column(const float *xi, const float *xj, int block_len,
                          int nfft, int use_phat, int max_lag, float f_lo_hz,
                          float f_hi_hz, float sample_rate, float *out_corr,
                          h68_gcc_result *out) {
  if (!xi || !xj || !out) return H68_ERR_ARG;
  if (block_len <= 0 || !is_pow2(nfft) || nfft > H68_MAX_FFT) return H68_ERR_ARG;
  if (nfft < 2 * block_len) return H68_ERR_ARG;
  if (max_lag <= 0 || 2 * max_lag + 1 > nfft) return H68_ERR_ARG;

  kiss_fftr_cfg fwd = h68_fftr_plan(nfft, 0);
  kiss_fftr_cfg inv = h68_fftr_plan(nfft, 1);
  if (!fwd || !inv) return H68_ERR_NOMEM;

  memset(g_pad_i, 0, sizeof(float) * (size_t)nfft);
  memset(g_pad_j, 0, sizeof(float) * (size_t)nfft);

  /* Remove the mean before correlating. A DC offset differing between channels
   * puts a large spike at zero lag that swamps the real peak, and the MEMS mics
   * in the cube do carry different offsets. */
  double mi = 0.0, mj = 0.0;
  for (int n = 0; n < block_len; ++n) {
    mi += (double)xi[n];
    mj += (double)xj[n];
  }
  mi /= (double)block_len;
  mj /= (double)block_len;

  double ei = 0.0, ej = 0.0;
  for (int n = 0; n < block_len; ++n) {
    const double a = (double)xi[n] - mi;
    const double b = (double)xj[n] - mj;
    g_pad_i[n] = (float)a;
    g_pad_j[n] = (float)b;
    ei += a * a;
    ej += b * b;
  }

  kiss_fftr(fwd, g_pad_i, g_xi);
  kiss_fftr(fwd, g_pad_j, g_xj);

  const int bins = nfft / 2 + 1;
  const int k_lo = band_to_bin(f_lo_hz, nfft, sample_rate, 0);
  int k_hi = (f_hi_hz > 0.0f) ? band_to_bin(f_hi_hz, nfft, sample_rate, nfft / 2)
                              : (nfft / 2);
  if (k_hi < k_lo) k_hi = k_lo;

  int active = 0;
  for (int k = 0; k < bins; ++k) {
    if (k < k_lo || k > k_hi) {
      g_cross[k].r = 0.0f;
      g_cross[k].i = 0.0f;
      continue;
    }
    const float ar = g_xi[k].r, ai = g_xi[k].i;
    const float br = g_xj[k].r, bi = g_xj[k].i;
    /* conj(Xi) * Xj */
    float cr = ar * br + ai * bi;
    float ci = ar * bi - ai * br;

    if (use_phat) {
      const float mag = sqrtf(cr * cr + ci * ci);
      /* Regularise against dividing up near-silent bins into pure noise phase. */
      const float eps = 1e-12f;
      if (mag > eps) {
        cr /= mag;
        ci /= mag;
      } else {
        cr = 0.0f;
        ci = 0.0f;
      }
    }
    g_cross[k].r = cr;
    g_cross[k].i = ci;
    if (k > 0 && k < nfft / 2) ++active;
  }

  kiss_fftri(inv, g_cross, g_corr);

  /* Scale so a perfectly coherent delay peaks at 1.0. kiss_fftri is unnormalised
   * and the Hermitian extension doubles every bin except DC and Nyquist, so an
   * ideal linear-phase spectrum reaches 2*active at the true lag. */
  float scale;
  if (use_phat) {
    scale = (active > 0) ? 1.0f / (2.0f * (float)active) : 0.0f;
  } else {
    const double denom = sqrt(ei * ej);
    scale = (denom > 0.0) ? (float)(1.0 / denom) : 0.0f;
  }

  /* Gather the requested lag window. Negative lags live at the top of the
   * circular buffer. */
  const int span = 2 * max_lag + 1;
  int best = 0;
  float best_val = -1e30f;
  for (int idx = 0; idx < span; ++idx) {
    const int lag = idx - max_lag;
    const int n = (lag >= 0) ? lag : (nfft + lag);
    const float v = g_corr[n] * scale;
    if (out_corr) out_corr[idx] = v;
    if (v > best_val) {
      best_val = v;
      best = idx;
    }
  }

  /* Parabolic interpolation of the peak; one sample of lag is 7.1 mm of path
   * difference at 48 kHz, so sub-sample resolution is worth having. */
  float frac = 0.0f;
  if (best > 0 && best < span - 1) {
    const float ym1 = (out_corr ? out_corr[best - 1]
                                : g_corr[(best - 1 - max_lag >= 0)
                                             ? (best - 1 - max_lag)
                                             : (nfft + best - 1 - max_lag)] *
                                      scale);
    const float y0 = best_val;
    const float yp1 = (out_corr ? out_corr[best + 1]
                                : g_corr[(best + 1 - max_lag >= 0)
                                             ? (best + 1 - max_lag)
                                             : (nfft + best + 1 - max_lag)] *
                                      scale);
    const float denom = ym1 - 2.0f * y0 + yp1;
    if (fabsf(denom) > 1e-20f) {
      frac = 0.5f * (ym1 - yp1) / denom;
      if (frac > 1.0f) frac = 1.0f;
      if (frac < -1.0f) frac = -1.0f;
    }
  }

  /* Strongest competitor outside the main lobe. When this approaches the true
   * peak the delay is ambiguous, which is exactly what spatial aliasing looks
   * like above c/(2*baseline). */
  const int guard = 3;
  float second_val = -1e30f;
  int second_idx = -1;
  for (int idx = 0; idx < span; ++idx) {
    if (idx >= best - guard && idx <= best + guard) continue;
    const int lag = idx - max_lag;
    const int n = (lag >= 0) ? lag : (nfft + lag);
    const float v = g_corr[n] * scale;
    if (v > second_val) {
      second_val = v;
      second_idx = idx;
    }
  }

  out->peak_index = best;
  out->peak_lag = (float)(best - max_lag) + frac;
  out->peak_value = best_val;
  out->second_lag = (second_idx >= 0) ? (float)(second_idx - max_lag) : 0.0f;
  out->second_value = (second_idx >= 0) ? second_val : 0.0f;
  out->peak_ratio =
      (second_val > 1e-9f) ? (best_val / second_val) : (best_val > 0.0f ? 1e9f : 0.0f);

  return H68_OK;
}

h68_status h68_coherence(const float *xi, const float *xj, int nsamples,
                         int nfft, int hop, h68_window_kind kind, float beta,
                         float *out_msc, int *out_frames) {
  if (!xi || !xj || !out_msc) return H68_ERR_ARG;
  if (!is_pow2(nfft) || nfft > H68_MAX_FFT) return H68_ERR_ARG;
  if (hop <= 0 || nsamples < nfft) return H68_ERR_ARG;

  kiss_fftr_cfg fwd = h68_fftr_plan(nfft, 0);
  if (!fwd) return H68_ERR_NOMEM;

  const int bins = nfft / 2 + 1;
  memset(g_sxx, 0, sizeof(float) * (size_t)bins);
  memset(g_syy, 0, sizeof(float) * (size_t)bins);
  memset(g_sxy, 0, sizeof(kiss_fft_cpx) * (size_t)bins);

  h68_window_fill(g_coh_win, nfft, kind, beta);

  const int frames = (nsamples - nfft) / hop + 1;
  for (int f = 0; f < frames; ++f) {
    const float *a = xi + (size_t)f * (size_t)hop;
    const float *b = xj + (size_t)f * (size_t)hop;
    for (int n = 0; n < nfft; ++n) {
      g_pad_i[n] = a[n] * g_coh_win[n];
      g_pad_j[n] = b[n] * g_coh_win[n];
    }
    kiss_fftr(fwd, g_pad_i, g_xi);
    kiss_fftr(fwd, g_pad_j, g_xj);

    for (int k = 0; k < bins; ++k) {
      const float ar = g_xi[k].r, ai = g_xi[k].i;
      const float br = g_xj[k].r, bi = g_xj[k].i;
      g_sxx[k] += ar * ar + ai * ai;
      g_syy[k] += br * br + bi * bi;
      g_sxy[k].r += ar * br + ai * bi;
      g_sxy[k].i += ar * bi - ai * br;
    }
  }

  for (int k = 0; k < bins; ++k) {
    const float num = g_sxy[k].r * g_sxy[k].r + g_sxy[k].i * g_sxy[k].i;
    const float den = g_sxx[k] * g_syy[k];
    float msc = (den > 1e-30f) ? (num / den) : 0.0f;
    if (msc > 1.0f) msc = 1.0f; /* guards float rounding at msc == 1 */
    if (msc < 0.0f) msc = 0.0f;
    out_msc[k] = msc;
  }

  if (out_frames) *out_frames = frames;
  return H68_OK;
}

float h68_coherence_band(const float *msc, int nfft, float sample_rate,
                         float f_lo_hz, float f_hi_hz) {
  if (!msc || nfft <= 0 || sample_rate <= 0.0f) return 0.0f;
  const int k_lo = band_to_bin(f_lo_hz, nfft, sample_rate, 0);
  int k_hi = band_to_bin(f_hi_hz, nfft, sample_rate, nfft / 2);
  if (k_hi < k_lo) k_hi = k_lo;

  /* Weighting by the mean channel power keeps near-silent bins, whose coherence
   * is essentially a random number, from dragging the band average around. */
  double num = 0.0, den = 0.0;
  for (int k = k_lo; k <= k_hi; ++k) {
    const double w = (double)g_sxx[k] + (double)g_syy[k];
    num += (double)msc[k] * w;
    den += w;
  }
  if (den <= 0.0) {
    /* No power anywhere in the band; fall back to an unweighted mean so the
     * caller still gets a defined number. */
    const int n = k_hi - k_lo + 1;
    double s = 0.0;
    for (int k = k_lo; k <= k_hi; ++k) s += (double)msc[k];
    return (n > 0) ? (float)(s / n) : 0.0f;
  }
  return (float)(num / den);
}
