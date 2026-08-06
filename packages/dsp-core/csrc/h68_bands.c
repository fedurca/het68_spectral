#include "h68_bands.h"

#include <math.h>

#define HIST_BINS 880 /* -200 to +20 dB in 0.25 dB steps */
#define HIST_LO (-200.0f)
#define HIST_STEP 0.25f

h68_band_frame h68_band_frame_metrics(const float *mag, int bins, float bin_hz,
                                      float lo_hz, float hi_hz) {
  h68_band_frame out;
  out.energy_db = HIST_LO;
  out.tonality_db = 0.0f;
  out.peak_db = HIST_LO;
  out.peak_hz = 0.0f;

  if (!mag || bins <= 0 || bin_hz <= 0.0f) return out;

  int k_lo = (int)(lo_hz / bin_hz + 0.5f);
  int k_hi = (int)(hi_hz / bin_hz + 0.5f);
  if (k_lo < 0) k_lo = 0;
  if (k_hi > bins) k_hi = bins;
  /* A band the user drew narrower than the resolution still has to report
   * something, so it collapses to one bin instead of to nothing. */
  if (k_hi <= k_lo) k_hi = (k_lo < bins) ? k_lo + 1 : bins;
  if (k_hi <= k_lo) return out;

  const int n = k_hi - k_lo;
  double sum_p = 0.0;
  double sum_log = 0.0;
  float peak = 0.0f;
  int peak_k = k_lo;

  for (int k = k_lo; k < k_hi; k++) {
    const float m = mag[k];
    const double p = (double)m * (double)m;
    sum_p += p;
    /* Floored before the log so a bin that is exactly zero, which happens on
     * synthetic input, does not take the geometric mean to zero. */
    sum_log += log(p > 1e-30 ? p : 1e-30);
    if (m > peak) {
      peak = m;
      peak_k = k;
    }
  }

  const double mean_p = sum_p / n;
  const double geo_p = exp(sum_log / n);

  out.energy_db = (float)(10.0 * log10(mean_p > 1e-30 ? mean_p : 1e-30));
  out.peak_db = (float)(20.0 * log10(peak > 1e-15f ? peak : 1e-15f));
  out.peak_hz = (float)peak_k * bin_hz;

  /* Spectral flatness is the geometric mean over the arithmetic mean, which is 1
   * for white noise and approaches 0 for a pure tone. Inverted into dB it reads as
   * "how tonal", which is the direction the question is usually asked in. For a
   * ducted rotor this is the number that decides whether a comb detector is viable
   * at all. */
  const double flatness = (mean_p > 1e-30) ? geo_p / mean_p : 1.0;
  out.tonality_db = (float)(-10.0 * log10(flatness > 1e-30 ? flatness : 1e-30));
  return out;
}

float h68_db_percentile(const float *series, int n, float pct) {
  if (!series || n <= 0) return HIST_LO;
  if (pct < 0.0f) pct = 0.0f;
  if (pct > 1.0f) pct = 1.0f;

  static uint16_t hist[HIST_BINS];
  for (int i = 0; i < HIST_BINS; i++) hist[i] = 0;

  int counted = 0;
  for (int i = 0; i < n; i++) {
    float v = series[i];
    if (!isfinite(v)) continue;
    int b = (int)((v - HIST_LO) / HIST_STEP);
    if (b < 0) b = 0;
    if (b >= HIST_BINS) b = HIST_BINS - 1;
    /* uint16 saturates at 65535 samples in one histogram bin; on a recording long
     * enough for that the quantile is already determined to well within a step. */
    if (hist[b] < 65535) hist[b]++;
    counted++;
  }
  if (counted == 0) return HIST_LO;

  const int target = (int)(pct * (float)(counted - 1) + 0.5f);
  int cum = 0;
  for (int b = 0; b < HIST_BINS; b++) {
    cum += hist[b];
    if (cum > target) return HIST_LO + ((float)b + 0.5f) * HIST_STEP;
  }
  return HIST_LO + ((float)(HIST_BINS - 1) + 0.5f) * HIST_STEP;
}
