#include "h68_harmonic.h"

#include <math.h>
#include <string.h>

#include "h68_fft.h"

static float g_floor[H68_MAX_BINS];  /* running noise floor estimate, dB */
static float g_logmag[H68_MAX_BINS]; /* magnitude in dB */
static float g_ceps_in[H68_MAX_FFT];
static kiss_fft_cpx g_ceps_spec[H68_MAX_BINS];

#define H68_DB_FLOOR (-200.0f)

static float lin_to_db(float v) {
  return (v > 1e-12f) ? 20.0f * log10f(v) : H68_DB_FLOOR;
}

/* Median of a small window, via insertion into a fixed scratch array. Median
 * rather than mean so a strong harmonic sitting inside the window does not lift
 * the floor estimate it is supposed to be measured against. */
static float median_window(const float *x, int bins, int centre, int half) {
  float buf[65];
  int lo = centre - half;
  int hi = centre + half;
  if (lo < 0) lo = 0;
  if (hi > bins - 1) hi = bins - 1;
  int n = hi - lo + 1;
  if (n > 65) n = 65;
  for (int i = 0; i < n; ++i) {
    float v = x[lo + i];
    int j = i - 1;
    while (j >= 0 && buf[j] > v) {
      buf[j + 1] = buf[j];
      --j;
    }
    buf[j + 1] = v;
  }
  return buf[n / 2];
}

/* Linear interpolation of a dB spectrum at a fractional bin. */
static float interp_db(const float *db, int bins, float bin) {
  if (bin < 0.0f) return H68_DB_FLOOR;
  const int i0 = (int)bin;
  if (i0 >= bins - 1) return H68_DB_FLOOR;
  const float fr = bin - (float)i0;
  return db[i0] * (1.0f - fr) + db[i0 + 1] * fr;
}

/* Comb salience: mean excess over the local floor across the harmonics that fall
 * inside the spectrum. Averaging rather than summing keeps candidates with
 * different harmonic counts comparable.
 *
 * k_analysis_hi is the end of the usable spectrum, deliberately not the top of the
 * f0 search range. Those are different limits: f0 is confined to a narrow band
 * around the expected blade-pass frequency, but its harmonics run far above it and
 * are the entire reason this estimator is sharp. Conflating the two leaves a single
 * harmonic in play and the search then locks onto whatever fits the noise. */
static float comb_score(const float *excess, int bins, float f0_bin, int n_harm,
                        int k_analysis_hi, int *found) {
  float sum = 0.0f;
  int cnt = 0;
  for (int h = 1; h <= n_harm; ++h) {
    const float b = f0_bin * (float)h;
    if (b > (float)k_analysis_hi) break;
    /* Take the best of the three bins around the predicted position: scalloping
     * loss and a slowly drifting rate both smear a harmonic by up to a bin. */
    float best = H68_DB_FLOOR;
    for (int d = -1; d <= 1; ++d) {
      const float v = interp_db(excess, bins, b + (float)d);
      if (v > best) best = v;
    }
    if (best > H68_DB_FLOOR) {
      sum += best;
      ++cnt;
    }
  }
  if (found) *found = cnt;
  return (cnt > 0) ? (sum / (float)cnt) : H68_DB_FLOOR;
}

h68_status h68_f0_candidates(const float *mag, int bins, float bin_hz,
                             float f_lo_hz, float f_hi_hz, int n_harm,
                             int blades, h68_f0_candidate *out, int max_out,
                             int *out_count) {
  if (out_count) *out_count = 0;
  if (!mag || !out || max_out <= 0) return H68_ERR_ARG;
  if (bins <= 4 || bins > H68_MAX_BINS || bin_hz <= 0.0f) return H68_ERR_ARG;
  if (n_harm < 1) n_harm = 1;
  if (blades < 1) blades = 1;

  for (int k = 0; k < bins; ++k) g_logmag[k] = lin_to_db(mag[k]);

  /* Noise floor from a running median, then work with the excess above it. This
   * makes the salience independent of overall level and of the tilt of the
   * background, so a distant drone scores the same way a close one does. */
  const int half = 24;
  for (int k = 0; k < bins; ++k) {
    g_floor[k] = median_window(g_logmag, bins, k, half);
  }
  for (int k = 0; k < bins; ++k) {
    float e = g_logmag[k] - g_floor[k];
    if (e < 0.0f) e = 0.0f;
    g_floor[k] = e; /* reuse the buffer: from here on it holds the excess */
  }

  /* f0 search range. */
  int k_lo = (int)floorf(f_lo_hz / bin_hz);
  int k_hi = (int)ceilf(f_hi_hz / bin_hz);
  if (k_lo < 1) k_lo = 1;
  if (k_hi > bins - 1) k_hi = bins - 1;
  if (k_hi <= k_lo) return H68_ERR_ARG;

  /* Harmonics are evaluated across the whole spectrum, not just the f0 band. */
  const int k_analysis_hi = bins - 1;
  const float nyquist_hz = bin_hz * (float)(bins - 1);

  /* Search f0 on an eighth-bin grid. The salience peak narrows with harmonic
   * count, so a sub-bin grid is what actually separates neighbouring rotors. */
  const float step = 0.125f;
  const int steps = (int)((float)(k_hi - k_lo) / step);
  if (steps < 3) return H68_ERR_ARG;

  /* Collect local maxima of the salience curve. */
  float prev2 = H68_DB_FLOOR, prev1 = H68_DB_FLOOR;
  float cand_f0[H68_MAX_F0_CANDIDATES * 4];
  float cand_score[H68_MAX_F0_CANDIDATES * 4];
  int cand_n = 0;
  const int cand_cap = (int)(sizeof(cand_f0) / sizeof(cand_f0[0]));

  for (int s = 0; s <= steps; ++s) {
    const float f0_bin = (float)k_lo + (float)s * step;
    int found = 0;
    const float sc = comb_score(g_floor, bins, f0_bin, n_harm, k_analysis_hi, &found);
    if (s >= 2 && prev1 > prev2 && prev1 >= sc && found > 0) {
      const float peak_bin = f0_bin - step;
      const float peak_f0 = peak_bin * bin_hz;
      if (cand_n < cand_cap) {
        cand_f0[cand_n] = peak_f0;
        cand_score[cand_n] = prev1;
        ++cand_n;
      } else {
        /* An eighth-bin grid throws up far more local maxima than there are
         * rotors, so the buffer must hold the strongest ones rather than the
         * first ones encountered. Keeping arrival order would fill it entirely
         * from the bottom of the search range and never reach the real f0. */
        int weakest = 0;
        for (int i = 1; i < cand_n; ++i) {
          if (cand_score[i] < cand_score[weakest]) weakest = i;
        }
        if (prev1 > cand_score[weakest]) {
          cand_f0[weakest] = peak_f0;
          cand_score[weakest] = prev1;
        }
      }
    }
    prev2 = prev1;
    prev1 = sc;
  }
  if (cand_n == 0) return H68_OK;

  /* Sort by score, descending. Insertion sort: cand_n is at most a few dozen. */
  for (int i = 1; i < cand_n; ++i) {
    const float fs_ = cand_f0[i], ss = cand_score[i];
    int j = i - 1;
    while (j >= 0 && cand_score[j] < ss) {
      cand_f0[j + 1] = cand_f0[j];
      cand_score[j + 1] = cand_score[j];
      --j;
    }
    cand_f0[j + 1] = fs_;
    cand_score[j + 1] = ss;
  }

  /* Octave correction. A comb at 2*f0 also fits f0, so whenever a sub-multiple
   * explains the spectrum nearly as well it is the better answer; otherwise every
   * rotor would be reported at twice its real speed half the time. */
  for (int i = 0; i < cand_n; ++i) {
    const float half_f0 = cand_f0[i] * 0.5f;
    if (half_f0 * 1.0f < f_lo_hz) continue;
    int found = 0;
    const float sc =
        comb_score(g_floor, bins, half_f0 / bin_hz, n_harm, k_analysis_hi, &found);
    /* Require the halved candidate to be within 1.5 dB and to actually place
     * harmonics, so noise does not win the swap. */
    if (found >= 3 && sc > cand_score[i] - 1.5f) {
      cand_f0[i] = half_f0;
      cand_score[i] = sc;
    }
  }

  /* Reject the sub-multiples and near-misses that any comb estimator throws up.
   * All rotors of a hovering machine carry a similar load, so a genuine extra
   * rotor scores within a few percent of the strongest, while a spurious f0 that
   * happens to hit a third of the harmonics scores around a third as well. The
   * gap is wide enough that a relative threshold separates them cleanly, and it
   * matters because the number of combs is itself a signature feature. */
  const float best_score = cand_score[0];
  const float score_gate = best_score * 0.6f;
  const float min_score_db = 3.0f;

  /* Keep the strongest candidates that are at least 1 percent apart: the rotors
   * of a hovering quad sit a few percent apart, so a coarser gate would merge
   * them and a finer one would split one rotor into several. */
  int n_out = 0;
  for (int i = 0; i < cand_n && n_out < max_out; ++i) {
    if (cand_score[i] < score_gate || cand_score[i] < min_score_db) break;
    int too_close = 0;
    for (int j = 0; j < n_out; ++j) {
      const float ratio = cand_f0[i] / out[j].f0_hz;
      if (ratio > 0.99f && ratio < 1.01f) {
        too_close = 1;
        break;
      }
    }
    if (too_close) continue;

    int found = 0;
    (void)comb_score(g_floor, bins, cand_f0[i] / bin_hz, n_harm, k_analysis_hi, &found);

    out[n_out].f0_hz = cand_f0[i];
    out[n_out].score = cand_score[i];
    out[n_out].rpm = cand_f0[i] / (float)blades * 60.0f;
    out[n_out].n_harmonics = found;
    out[n_out].hnr_db =
        h68_hnr_db(mag, bins, bin_hz, cand_f0[i], n_harm, f_lo_hz, nyquist_hz);
    ++n_out;
  }

  if (out_count) *out_count = n_out;
  return H68_OK;
}

float h68_hnr_db(const float *mag, int bins, float bin_hz, float f0_hz,
                 int n_harm, float f_lo_hz, float f_hi_hz) {
  if (!mag || bins <= 2 || bin_hz <= 0.0f || f0_hz <= 0.0f) return 0.0f;

  int k_lo = (int)floorf(f_lo_hz / bin_hz);
  int k_hi = (int)ceilf(f_hi_hz / bin_hz);
  if (k_lo < 1) k_lo = 1;
  if (k_hi > bins - 1) k_hi = bins - 1;
  if (k_hi <= k_lo) return 0.0f;

  double total = 0.0;
  for (int k = k_lo; k <= k_hi; ++k) {
    total += (double)mag[k] * (double)mag[k];
  }

  /* Harmonic energy: a two-bin skirt each side, which covers the main lobe of a
   * Hann window plus the smearing from a drifting rate. */
  double harm = 0.0;
  for (int h = 1; h <= n_harm; ++h) {
    const float centre = f0_hz * (float)h / bin_hz;
    const int c = (int)lrintf(centre);
    if (c < k_lo || c > k_hi) continue;
    for (int d = -2; d <= 2; ++d) {
      const int k = c + d;
      if (k < k_lo || k > k_hi) continue;
      harm += (double)mag[k] * (double)mag[k];
    }
  }

  double noise = total - harm;
  if (noise < 1e-20) noise = 1e-20;
  if (harm < 1e-20) return -100.0f;
  return (float)(10.0 * log10(harm / noise));
}

h68_status h68_cepstrum(const float *mag, int bins, int cepstrum_size,
                        float *out_ceps) {
  if (!mag || !out_ceps || bins < 4) return H68_ERR_ARG;
  if (cepstrum_size < 2 * (bins - 1) || cepstrum_size > H68_MAX_FFT) {
    return H68_ERR_ARG;
  }
  if (cepstrum_size & (cepstrum_size - 1)) return H68_ERR_ARG;

  kiss_fftr_cfg inv = h68_fftr_plan(cepstrum_size, 1);
  if (!inv) return H68_ERR_NOMEM;

  const int cbins = cepstrum_size / 2 + 1;
  for (int k = 0; k < cbins; ++k) {
    const float v = (k < bins) ? mag[k] : 0.0f;
    /* Log magnitude turns the multiplicative comb into an additive periodicity,
     * which is the whole trick behind the cepstrum. */
    g_ceps_spec[k].r = logf(v > 1e-10f ? v : 1e-10f);
    g_ceps_spec[k].i = 0.0f;
  }

  kiss_fftri(inv, g_ceps_spec, g_ceps_in);

  const float scale = 1.0f / (float)cepstrum_size;
  for (int i = 0; i < bins; ++i) out_ceps[i] = g_ceps_in[i] * scale;
  return H68_OK;
}

void h68_comb_tracker_reset(h68_comb_tracker *t) {
  if (!t) return;
  t->f0 = 0.0f;
  t->confidence = 0.0f;
  t->locked = 0;
  t->miss_count = 0;
}

void h68_comb_tracker_update(h68_comb_tracker *t,
                             const h68_f0_candidate *cands, int n_cands,
                             float max_rel_jump, int max_miss) {
  if (!t) return;
  if (!cands || n_cands <= 0) {
    if (++t->miss_count > max_miss) h68_comb_tracker_reset(t);
    return;
  }

  if (!t->locked) {
    t->f0 = cands[0].f0_hz;
    t->confidence = cands[0].score;
    t->locked = 1;
    t->miss_count = 0;
    return;
  }

  /* Prefer continuity over raw strength: the loudest candidate in a single frame
   * is often an octave error or the neighbouring rotor, whereas the trajectory is
   * what identifies the machine. */
  int best = -1;
  float best_dev = 1e30f;
  for (int i = 0; i < n_cands; ++i) {
    const float dev = fabsf(cands[i].f0_hz - t->f0) / (t->f0 > 0.0f ? t->f0 : 1.0f);
    if (dev <= max_rel_jump && dev < best_dev) {
      best_dev = dev;
      best = i;
    }
  }

  if (best < 0) {
    if (++t->miss_count > max_miss) {
      t->f0 = cands[0].f0_hz;
      t->confidence = cands[0].score;
      t->miss_count = 0;
    }
    return;
  }

  t->miss_count = 0;
  /* Light smoothing; enough to reject frame-level noise without lagging a real
   * throttle change. */
  t->f0 = 0.7f * t->f0 + 0.3f * cands[best].f0_hz;
  t->confidence = cands[best].score;
}
