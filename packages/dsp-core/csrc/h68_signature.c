#include "h68_signature.h"

#include <math.h>
#include <string.h>

#include "h68_harmonic.h"

#define H68_DB_FLOOR (-200.0f)

/* Accumulators for extraction; static to keep the processing path allocation
 * free. */
static double g_harm_sum[H68_SIG_MAX_HARM];
static double g_harm_sumsq[H68_SIG_MAX_HARM];
static int g_harm_count[H68_SIG_MAX_HARM];
static double g_band_sum[H68_SIG_MAX_BANDS];

static float harmonic_level_db(const float *mag, int bins, float bin_hz,
                               float f0_hz, int h) {
  const float centre = f0_hz * (float)h / bin_hz;
  const int c = (int)lrintf(centre);
  if (c < 1 || c > bins - 2) return H68_DB_FLOOR;
  /* Peak of the three bins around the prediction: a drifting rate and scalloping
   * loss both move a harmonic by up to a bin. */
  float best = 0.0f;
  for (int d = -1; d <= 1; ++d) {
    const int k = c + d;
    if (k < 0 || k >= bins) continue;
    if (mag[k] > best) best = mag[k];
  }
  return (best > 1e-12f) ? 20.0f * log10f(best) : H68_DB_FLOOR;
}

static void band_energies(const float *mag, int bins, float bin_hz,
                          const float *edges, int n_bands, double *out) {
  for (int b = 0; b < n_bands; ++b) {
    int k_lo = (int)floorf(edges[b] / bin_hz);
    int k_hi = (int)ceilf(edges[b + 1] / bin_hz);
    if (k_lo < 0) k_lo = 0;
    if (k_hi > bins - 1) k_hi = bins - 1;
    double s = 0.0;
    for (int k = k_lo; k <= k_hi; ++k) s += (double)mag[k] * (double)mag[k];
    out[b] = s;
  }
}

h68_status h68_signature_extract(const float *mag, int frames, int bins,
                                 float bin_hz, float f_lo_hz, float f_hi_hz,
                                 int n_harm, int blades,
                                 const float *band_edges, int n_bands,
                                 h68_signature *out) {
  if (!mag || !out || frames <= 0 || bins <= 4 || bin_hz <= 0.0f) {
    return H68_ERR_ARG;
  }
  if (n_harm < 1) n_harm = 1;
  if (n_harm > H68_SIG_MAX_HARM) n_harm = H68_SIG_MAX_HARM;
  if (n_bands < 0) n_bands = 0;
  if (n_bands > H68_SIG_MAX_BANDS) n_bands = H68_SIG_MAX_BANDS;
  if (n_bands > 0 && !band_edges) return H68_ERR_ARG;
  if (blades < 1) blades = 1;

  memset(out, 0, sizeof(*out));
  memset(g_harm_sum, 0, sizeof(g_harm_sum));
  memset(g_harm_sumsq, 0, sizeof(g_harm_sumsq));
  memset(g_harm_count, 0, sizeof(g_harm_count));
  memset(g_band_sum, 0, sizeof(g_band_sum));

  h68_comb_tracker tracker;
  h68_comb_tracker_reset(&tracker);

  double f0_sum = 0.0, f0_sumsq = 0.0;
  double hnr_sum = 0.0, hnr_sumsq = 0.0;

  /* Rotor ratios are bucketed by how many combs the frame produced. Slot k only
   * means "the k-th slowest rotor" among frames that saw the same number of
   * rotors; averaging across frames that saw three and four would put different
   * rotors in the same slot and produce a ratio vector that describes nothing. The
   * modal count wins at the end. */
  double comb_ratio_sum[H68_SIG_MAX_COMBS + 1][H68_SIG_MAX_COMBS];
  int comb_bucket_frames[H68_SIG_MAX_COMBS + 1];
  memset(comb_ratio_sum, 0, sizeof(comb_ratio_sum));
  memset(comb_bucket_frames, 0, sizeof(comb_bucket_frames));

  float fund_min_db = 1e30f, fund_max_db = -1e30f;
  int used = 0;

  for (int f = 0; f < frames; ++f) {
    const float *row = mag + (size_t)f * (size_t)bins;

    h68_f0_candidate cands[H68_MAX_F0_CANDIDATES];
    int n_cands = 0;
    if (h68_f0_candidates(row, bins, bin_hz, f_lo_hz, f_hi_hz, n_harm, blades,
                          cands, H68_MAX_F0_CANDIDATES, &n_cands) != H68_OK) {
      continue;
    }
    h68_comb_tracker_update(&tracker, cands, n_cands, 0.06f, 5);
    if (!tracker.locked || tracker.f0 <= 0.0f) continue;

    const float f0 = tracker.f0;
    const float fund_db = harmonic_level_db(row, bins, bin_hz, f0, 1);
    if (fund_db <= H68_DB_FLOOR) continue;

    ++used;
    f0_sum += (double)f0;
    f0_sumsq += (double)f0 * (double)f0;
    if (fund_db < fund_min_db) fund_min_db = fund_db;
    if (fund_db > fund_max_db) fund_max_db = fund_db;

    for (int h = 1; h <= n_harm; ++h) {
      const float db = harmonic_level_db(row, bins, bin_hz, f0, h);
      if (db <= H68_DB_FLOOR) continue;
      const double rel = (double)(db - fund_db);
      g_harm_sum[h - 1] += rel;
      g_harm_sumsq[h - 1] += rel * rel;
      ++g_harm_count[h - 1];
    }

    const float hnr = h68_hnr_db(row, bins, bin_hz, f0, n_harm, f_lo_hz, f_hi_hz);
    hnr_sum += (double)hnr;
    hnr_sumsq += (double)hnr * (double)hnr;

    if (n_bands > 0) {
      double e[H68_SIG_MAX_BANDS];
      band_energies(row, bins, bin_hz, band_edges, n_bands, e);
      double total = 0.0;
      for (int b = 0; b < n_bands; ++b) total += e[b];
      if (total > 1e-30) {
        for (int b = 0; b < n_bands; ++b) g_band_sum[b] += e[b] / total;
      }
    }

    /* Rotor ratios, expressed against the tracked rate.
     *
     * Only candidates within a few percent of the tracked rate can be other rotors
     * of the same machine: a hovering multirotor trims yaw torque with small
     * differences between the diagonal pairs, never with one rotor at two thirds of
     * another's speed. Anything further out is a sub-multiple or an octave error
     * from the estimator, and admitting it would be worse than merely adding noise,
     * because normalising against the lowest candidate would then rescale the whole
     * ratio vector and destroy the very invariance this template exists to provide. */
    const float rotor_tol = 0.10f;
    float sorted[H68_MAX_F0_CANDIDATES];
    int n = 0;
    for (int i = 0; i < n_cands && n < H68_SIG_MAX_COMBS; ++i) {
      const float rel = cands[i].f0_hz / f0 - 1.0f;
      if (rel > -rotor_tol && rel < rotor_tol) sorted[n++] = cands[i].f0_hz;
    }
    if (n > 0) {
      for (int i = 1; i < n; ++i) {
        const float v = sorted[i];
        int j = i - 1;
        while (j >= 0 && sorted[j] > v) {
          sorted[j + 1] = sorted[j];
          --j;
        }
        sorted[j + 1] = v;
      }
      /* Normalised against the mean of the rotor set, not against the tracked
       * rate. Which rotor the tracker happens to lock onto varies between takes,
       * and anchoring to it would shift the whole vector even though the pattern of
       * rates is identical. The mean is anchor free and preserves the spread, which
       * is the part that actually describes the machine. */
      double mean = 0.0;
      for (int i = 0; i < n; ++i) mean += (double)sorted[i];
      mean /= (double)n;
      if (mean > 0.0) {
        for (int i = 0; i < n; ++i) {
          comb_ratio_sum[n][i] += (double)sorted[i] / mean;
        }
        ++comb_bucket_frames[n];
      }
    }
  }

  out->version = H68_SIG_VERSION;
  out->blades = blades;
  out->n_frames = used;
  if (used == 0) {
    /* Nothing locked. Returning OK with n_frames == 0 lets the caller show an
     * honest "no comb found here" rather than a template made of noise. */
    return H68_OK;
  }

  out->n_harmonics = n_harm;
  for (int h = 0; h < n_harm; ++h) {
    if (g_harm_count[h] > 0) {
      const double m = g_harm_sum[h] / (double)g_harm_count[h];
      const double var = g_harm_sumsq[h] / (double)g_harm_count[h] - m * m;
      out->harmonic_rel_db[h] = (float)m;
      out->harmonic_sd_db[h] = (float)sqrt(var > 0.0 ? var : 0.0);
    } else {
      out->harmonic_rel_db[h] = H68_DB_FLOOR;
      out->harmonic_sd_db[h] = 0.0f;
    }
  }

  out->n_bands = n_bands;
  for (int b = 0; b < n_bands; ++b) {
    const double frac = g_band_sum[b] / (double)used;
    out->band_rel_db[b] =
        (frac > 1e-12) ? (float)(10.0 * log10(frac)) : H68_DB_FLOOR;
  }

  const double hnr_mean = hnr_sum / (double)used;
  const double hnr_var = hnr_sumsq / (double)used - hnr_mean * hnr_mean;
  out->hnr_db = (float)hnr_mean;
  out->hnr_sd_db = (float)sqrt(hnr_var > 0.0 ? hnr_var : 0.0);

  const double f0_mean = f0_sum / (double)used;
  const double f0_var = f0_sumsq / (double)used - f0_mean * f0_mean;
  const double f0_sd = sqrt(f0_var > 0.0 ? f0_var : 0.0);
  out->f0_drift_pct =
      (f0_mean > 0.0) ? (float)(100.0 * f0_sd / f0_mean) : 0.0f;

  /* Gate spans the observed range widened by 25 percent each way. That covers the
   * roughly 10 percent shift from carrying the RID module plus the ordinary spread
   * from battery state and manoeuvring, without becoming so wide that it stops
   * rejecting anything. */
  out->f0_gate_lo_hz = (float)(f0_mean * 0.75);
  out->f0_gate_hi_hz = (float)(f0_mean * 1.25);

  out->mod_depth_db =
      (fund_max_db > fund_min_db) ? (fund_max_db - fund_min_db) : 0.0f;

  /* Modal comb count: the number of rotors seen in the most frames. A maximum
   * would be set by a single lucky frame, and a mean would not be an integer. */
  int modal = 0;
  for (int k = 1; k <= H68_SIG_MAX_COMBS; ++k) {
    if (comb_bucket_frames[k] > comb_bucket_frames[modal]) modal = k;
  }
  out->n_combs = modal;
  if (modal > 0 && comb_bucket_frames[modal] > 0) {
    const double denom = (double)comb_bucket_frames[modal];
    for (int i = 0; i < modal; ++i) {
      out->comb_ratios[i] = (float)(comb_ratio_sum[modal][i] / denom);
    }
  }

  return H68_OK;
}

float h68_signature_match(const h68_signature *sig, const float *mag, int bins,
                          float bin_hz, const float *band_edges,
                          float *out_f0_hz) {
  if (out_f0_hz) *out_f0_hz = 0.0f;
  if (!sig || !mag || bins <= 4 || bin_hz <= 0.0f) return 0.0f;
  if (sig->n_frames <= 0) return 0.0f;

  h68_f0_candidate cands[H68_MAX_F0_CANDIDATES];
  int n_cands = 0;
  if (h68_f0_candidates(mag, bins, bin_hz, sig->f0_gate_lo_hz,
                        sig->f0_gate_hi_hz, sig->n_harmonics, sig->blades, cands,
                        H68_MAX_F0_CANDIDATES, &n_cands) != H68_OK) {
    return 0.0f;
  }
  if (n_cands == 0) return 0.0f;

  const float f0 = cands[0].f0_hz;
  if (out_f0_hz) *out_f0_hz = f0;

  const float fund_db = harmonic_level_db(mag, bins, bin_hz, f0, 1);
  if (fund_db <= H68_DB_FLOOR) return 0.0f;

  /* Harmonic envelope agreement, expressed as a per-harmonic z-score against the
   * spread the template itself recorded. Harmonics that were unstable in the
   * template are allowed to be unstable here too, which matters for ducted props
   * whose upper harmonics come and go. */
  double acc = 0.0;
  int terms = 0;
  for (int h = 1; h <= sig->n_harmonics; ++h) {
    const float ref = sig->harmonic_rel_db[h - 1];
    if (ref <= H68_DB_FLOOR) continue;
    const float db = harmonic_level_db(mag, bins, bin_hz, f0, h);
    if (db <= H68_DB_FLOOR) continue;
    const float rel = db - fund_db;
    float tol = sig->harmonic_sd_db[h - 1];
    if (tol < 3.0f) tol = 3.0f; /* floor on tolerance, in dB */
    const double z = (double)(rel - ref) / (double)tol;
    acc += z * z;
    ++terms;
  }
  double harm_score = 0.0;
  if (terms > 0) {
    const double rms_z = sqrt(acc / (double)terms);
    harm_score = exp(-0.5 * rms_z * rms_z);
  }

  /* Band balance agreement. */
  double band_score = 1.0;
  if (sig->n_bands > 0 && band_edges) {
    double e[H68_SIG_MAX_BANDS];
    band_energies(mag, bins, bin_hz, band_edges, sig->n_bands, e);
    double total = 0.0;
    for (int b = 0; b < sig->n_bands; ++b) total += e[b];
    if (total > 1e-30) {
      double s = 0.0;
      int n = 0;
      for (int b = 0; b < sig->n_bands; ++b) {
        const double frac = e[b] / total;
        const float db =
            (frac > 1e-12) ? (float)(10.0 * log10(frac)) : H68_DB_FLOOR;
        if (sig->band_rel_db[b] <= H68_DB_FLOOR || db <= H68_DB_FLOOR) continue;
        const double d = (double)(db - sig->band_rel_db[b]) / 6.0;
        s += d * d;
        ++n;
      }
      if (n > 0) band_score = exp(-0.5 * (s / (double)n));
    }
  }

  /* Tonality agreement: the single most diagnostic quantity for a ducted rotor. */
  const float hnr = h68_hnr_db(mag, bins, bin_hz, f0, sig->n_harmonics,
                               sig->f0_gate_lo_hz * 0.5f, bin_hz * (float)(bins - 1));
  float hnr_tol = sig->hnr_sd_db;
  if (hnr_tol < 3.0f) hnr_tol = 3.0f;
  const double hz = (double)(hnr - sig->hnr_db) / (double)hnr_tol;
  const double hnr_score = exp(-0.5 * hz * hz);

  /* Weighted geometric mean: any one factor failing badly should pull the whole
   * score down rather than being averaged away. */
  const double score = pow(harm_score, 0.5) * pow(band_score, 0.3) *
                       pow(hnr_score, 0.2);
  return (float)score;
}

float h68_signature_distance(const h68_signature *a, const h68_signature *b) {
  if (!a || !b) return 1e30f;
  if (a->n_frames <= 0 || b->n_frames <= 0) return 1e30f;

  double acc = 0.0;
  int terms = 0;

  const int nh = (a->n_harmonics < b->n_harmonics) ? a->n_harmonics
                                                   : b->n_harmonics;
  for (int h = 0; h < nh; ++h) {
    if (a->harmonic_rel_db[h] <= H68_DB_FLOOR ||
        b->harmonic_rel_db[h] <= H68_DB_FLOOR) {
      continue;
    }
    const double d = (double)(a->harmonic_rel_db[h] - b->harmonic_rel_db[h]) / 6.0;
    acc += d * d;
    ++terms;
  }

  const int nb = (a->n_bands < b->n_bands) ? a->n_bands : b->n_bands;
  for (int i = 0; i < nb; ++i) {
    if (a->band_rel_db[i] <= H68_DB_FLOOR || b->band_rel_db[i] <= H68_DB_FLOOR) {
      continue;
    }
    const double d = (double)(a->band_rel_db[i] - b->band_rel_db[i]) / 6.0;
    acc += d * d;
    ++terms;
  }

  const int nc = (a->n_combs < b->n_combs) ? a->n_combs : b->n_combs;
  for (int i = 0; i < nc; ++i) {
    /* Rotor ratios are dimensionless and tight; 1 percent is a meaningful unit. */
    const double d = (double)(a->comb_ratios[i] - b->comb_ratios[i]) / 0.01;
    acc += d * d;
    ++terms;
  }

  {
    const double d = (double)(a->hnr_db - b->hnr_db) / 6.0;
    acc += d * d;
    ++terms;
  }

  return (terms > 0) ? (float)sqrt(acc / (double)terms) : 1e30f;
}
