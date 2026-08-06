#include "h68_window.h"

#include <math.h>

static double bessel_i0(double x) {
  /* Ascending series; converges quickly for the beta range Kaiser windows use. */
  double sum = 1.0;
  double term = 1.0;
  const double half = x * 0.5;
  for (int k = 1; k < 64; ++k) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

void h68_window_fill(float *w, int n, h68_window_kind kind, float beta) {
  if (!w || n <= 0) return;
  if (n == 1) {
    w[0] = 1.0f;
    return;
  }
  const double two_pi_over_n = 2.0 * H68_PI / (double)n;
  switch (kind) {
    case H68_WIN_RECT:
      for (int i = 0; i < n; ++i) w[i] = 1.0f;
      break;
    case H68_WIN_HAMMING:
      for (int i = 0; i < n; ++i) {
        w[i] = (float)(0.54 - 0.46 * cos(two_pi_over_n * i));
      }
      break;
    case H68_WIN_BLACKMAN_HARRIS:
      for (int i = 0; i < n; ++i) {
        const double t = two_pi_over_n * i;
        w[i] = (float)(0.35875 - 0.48829 * cos(t) + 0.14128 * cos(2.0 * t) -
                       0.01168 * cos(3.0 * t));
      }
      break;
    case H68_WIN_KAISER: {
      double b = (double)beta;
      if (b < 0.0) b = 0.0;
      const double denom = bessel_i0(b);
      const double half = (double)(n - 1) * 0.5;
      for (int i = 0; i < n; ++i) {
        const double r = ((double)i - half) / half;
        double arg = 1.0 - r * r;
        if (arg < 0.0) arg = 0.0;
        w[i] = (float)(bessel_i0(b * sqrt(arg)) / denom);
      }
      break;
    }
    case H68_WIN_HANN:
    default:
      for (int i = 0; i < n; ++i) {
        w[i] = (float)(0.5 - 0.5 * cos(two_pi_over_n * i));
      }
      break;
  }
}

/* |W(f)| for a fractional bin offset, evaluated directly. O(n) per call, used
 * only at init time. */
static double dtft_mag(const float *w, int n, double bin_offset) {
  const double omega = 2.0 * H68_PI * bin_offset / (double)n;
  double re = 0.0, im = 0.0;
  for (int i = 0; i < n; ++i) {
    const double ph = omega * i;
    re += (double)w[i] * cos(ph);
    im -= (double)w[i] * sin(ph);
  }
  return sqrt(re * re + im * im);
}

void h68_window_metrics(const float *w, int n, float *coherent_gain,
                        float *enbw_bins, float *nenbw, float *scallop_db,
                        float *sidelobe_db) {
  if (!w || n <= 0) return;

  double s1 = 0.0, s2 = 0.0;
  for (int i = 0; i < n; ++i) {
    const double v = (double)w[i];
    s1 += v;
    s2 += v * v;
  }

  const double cg = s1 / (double)n;
  /* Normalised ENBW: how many bins of white noise the window lets through,
   * relative to a rectangular window of the same length. */
  const double enbw = (s1 > 0.0) ? ((double)n * s2 / (s1 * s1)) : 0.0;

  if (coherent_gain) *coherent_gain = (float)cg;
  if (enbw_bins) *enbw_bins = (float)enbw;
  if (nenbw) *nenbw = (float)enbw;

  /* Scalloping loss: a tone exactly between two bins is attenuated by this much
   * relative to one sitting on a bin centre. It is the reason a harmonic can
   * appear to fade in and out as the rotor speed drifts. */
  if (scallop_db) {
    const double peak = dtft_mag(w, n, 0.0);
    const double mid = dtft_mag(w, n, 0.5);
    *scallop_db = (peak > 0.0 && mid > 0.0)
                      ? (float)(20.0 * log10(mid / peak))
                      : 0.0f;
  }

  /* Highest sidelobe, found by walking the transform outwards to the first null
   * and taking the maximum beyond it. For every window offered here the highest
   * sidelobe is the first one, so a 64-bin search is sufficient and stays cheap
   * even at the largest transform size. */
  if (sidelobe_db) {
    const double peak = dtft_mag(w, n, 0.0);
    const int steps_per_bin = 8;
    const int max_bins = 64;
    double prev = peak;
    int past_null = 0;
    double worst = 0.0;
    for (int k = 1; k <= max_bins * steps_per_bin; ++k) {
      const double off = (double)k / steps_per_bin;
      if (off >= (double)n / 2.0) break;
      const double mag = dtft_mag(w, n, off);
      if (!past_null) {
        /* The main lobe falls monotonically until the first null. */
        if (mag > prev) past_null = 1;
      }
      if (past_null && mag > worst) worst = mag;
      prev = mag;
    }
    *sidelobe_db = (peak > 0.0 && worst > 0.0)
                       ? (float)(20.0 * log10(worst / peak))
                       : -200.0f;
  }
}
