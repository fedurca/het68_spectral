#include "h68_health.h"

#include <math.h>
#include <string.h>

#define H68_DB_FLOOR (-200.0f)

static float lin_db(float v) {
  return (v > 1e-12f) ? 20.0f * log10f(v) : H68_DB_FLOOR;
}

void h68_channel_stats_compute(const float *x, int n, float clip_thresh,
                               h68_channel_stats *out) {
  if (!out) return;
  memset(out, 0, sizeof(*out));
  if (!x || n <= 0) {
    out->rms_db = H68_DB_FLOOR;
    out->peak_db = H68_DB_FLOOR;
    out->noise_floor_db = H68_DB_FLOOR;
    out->dead = 1;
    return;
  }
  if (clip_thresh <= 0.0f) clip_thresh = 0.999f;

  double sum = 0.0, sumsq = 0.0;
  float peak = 0.0f;
  int clipped = 0;
  int zeros = 0;
  int zero_run = 0;
  int max_zero_run = 0;
  int crossings = 0;
  float prev = 0.0f;

  for (int i = 0; i < n; ++i) {
    const float v = x[i];
    sum += (double)v;
    sumsq += (double)v * (double)v;
    const float a = fabsf(v);
    if (a > peak) peak = a;
    if (a >= clip_thresh) ++clipped;
    if (v == 0.0f) {
      ++zeros;
      if (++zero_run > max_zero_run) max_zero_run = zero_run;
    } else {
      zero_run = 0;
    }
    if (i > 0 && ((prev < 0.0f && v >= 0.0f) || (prev >= 0.0f && v < 0.0f))) {
      ++crossings;
    }
    prev = v;
  }

  const double mean = sum / (double)n;
  const double ms = sumsq / (double)n;
  const double variance = ms - mean * mean;

  out->dc = (float)mean;
  out->rms = (float)sqrt(ms);
  out->rms_db = lin_db(out->rms);
  out->peak = peak;
  out->peak_db = lin_db(peak);
  out->crest_db = (out->rms > 0.0f) ? (out->peak_db - out->rms_db) : 0.0f;
  out->clipped_samples = clipped;
  out->silent_samples = zeros;
  out->zero_crossing_rate = (n > 1) ? ((float)crossings / (float)(n - 1)) : 0.0f;

  /* A channel is dead when its variance is negligible, which catches both a
   * disconnected mic and one stuck at a constant DC value. Judging by RMS alone
   * would miss the latter. */
  out->dead = (variance < 1e-14) ? 1 : 0;
  /* Occasional clipping happens on transients; a whole percent of samples at full
   * scale means the channel is genuinely saturated. */
  out->saturated = (clipped > n / 100) ? 1 : 0;

  /* Noise floor from the 10th percentile of short-block RMS. Ignoring the loud
   * blocks is what makes this an estimate of the floor rather than of the signal,
   * and it works even when a drone is audible for most of the take. */
  const int block = 1024;
  const int nblocks = n / block;
  if (nblocks >= 4) {
    /* Fixed histogram over dB rather than sorting the blocks: bounded memory and
     * a resolution of 1 dB, which is finer than the estimate deserves anyway. */
    int hist[201];
    memset(hist, 0, sizeof(hist));
    for (int b = 0; b < nblocks; ++b) {
      double s = 0.0;
      const float *p = x + (size_t)b * (size_t)block;
      for (int i = 0; i < block; ++i) s += (double)p[i] * (double)p[i];
      const float db = lin_db((float)sqrt(s / (double)block));
      int idx = (int)lrintf(db) + 200;
      if (idx < 0) idx = 0;
      if (idx > 200) idx = 200;
      ++hist[idx];
    }
    const int target = nblocks / 10 + 1;
    int acc = 0;
    int chosen = 0;
    for (int i = 0; i <= 200; ++i) {
      acc += hist[i];
      if (acc >= target) {
        chosen = i;
        break;
      }
    }
    out->noise_floor_db = (float)(chosen - 200);
  } else {
    out->noise_floor_db = out->rms_db;
  }
}

float h68_channel_correlation(const float *a, const float *b, int n) {
  if (!a || !b || n <= 1) return 0.0f;
  double sa = 0.0, sb = 0.0;
  for (int i = 0; i < n; ++i) {
    sa += (double)a[i];
    sb += (double)b[i];
  }
  const double ma = sa / (double)n, mb = sb / (double)n;
  double num = 0.0, da = 0.0, db = 0.0;
  for (int i = 0; i < n; ++i) {
    const double x = (double)a[i] - ma;
    const double y = (double)b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const double den = sqrt(da * db);
  return (den > 1e-20) ? (float)(num / den) : 0.0f;
}

float h68_goertzel(const float *x, int n, float freq_hz, float sample_rate) {
  if (!x || n <= 0 || sample_rate <= 0.0f) return 0.0f;
  const double w = 2.0 * H68_PI * (double)freq_hz / (double)sample_rate;
  const double coeff = 2.0 * cos(w);
  double s1 = 0.0, s2 = 0.0;
  for (int i = 0; i < n; ++i) {
    const double s = (double)x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const double re = s1 - s2 * cos(w);
  const double im = s2 * sin(w);
  /* Scaled to the amplitude of a sinusoid at exactly freq_hz. */
  return (float)(2.0 * sqrt(re * re + im * im) / (double)n);
}

h68_status h68_mapping_probe(const float *planar, int nch, int n,
                             float sample_rate, float tone_hz, float slot_ms,
                             int *out_active, float *out_margin_db,
                             int max_slots, int *out_slots) {
  if (out_slots) *out_slots = 0;
  if (!planar || !out_active || nch <= 0 || nch > H68_NCH) return H68_ERR_ARG;
  if (n <= 0 || sample_rate <= 0.0f || slot_ms <= 0.0f) return H68_ERR_ARG;

  const int slot = (int)(slot_ms * 0.001f * sample_rate);
  if (slot < 16) return H68_ERR_ARG;
  int slots = n / slot;
  if (slots > max_slots) slots = max_slots;

  for (int s = 0; s < slots; ++s) {
    float best = -1.0f, second = -1.0f;
    int best_ch = -1;
    for (int c = 0; c < nch; ++c) {
      const float *p = planar + (size_t)c * (size_t)n + (size_t)s * (size_t)slot;
      const float mag = h68_goertzel(p, slot, tone_hz, sample_rate);
      if (mag > best) {
        second = best;
        best = mag;
        best_ch = c;
      } else if (mag > second) {
        second = mag;
      }
    }
    /* Require a clear winner. Crosstalk and room reflections put the tone on every
     * channel at some level, so without a margin test this would always report
     * whichever channel happens to be a fraction of a dB louder. */
    float margin_db;
    if (best <= 1e-9f) {
      margin_db = 0.0f; /* no tone anywhere in this slot */
    } else if (second <= 1e-9f) {
      /* Every other channel silent: the separation is effectively unbounded, and
       * reporting zero here would reject the cleanest possible result. */
      margin_db = 120.0f;
    } else {
      margin_db = 20.0f * log10f(best / second);
    }
    if (out_margin_db) out_margin_db[s] = margin_db;
    out_active[s] = (margin_db >= 6.0f) ? best_ch : -1;
  }

  if (out_slots) *out_slots = slots;
  return H68_OK;
}
