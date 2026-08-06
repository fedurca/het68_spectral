/*
 * Drone signature templates.
 *
 * Everything stored here is deliberately invariant to absolute rotor speed. The
 * reason is concrete: ground truth requires a 32 g Dronetag Mini on a 151 g
 * airframe, which raises hover RPM by roughly 10 percent, so every recording with
 * a known position has a shifted comb compared with the stock machine the detector
 * must recognise in the field. Rotor speed also moves with battery state, wind and
 * manoeuvre, so an absolute f0 was never a durable discriminator.
 *
 * What is stored instead: the ratios between the rotors' rates, the relative
 * levels of the harmonics, the balance of energy between bands, and tonality.
 * Absolute f0 survives only as a wide acceptance gate.
 */
#ifndef H68_SIGNATURE_H
#define H68_SIGNATURE_H

#include "h68_dsp.h"

#ifdef __cplusplus
extern "C" {
#endif

#define H68_SIG_MAX_COMBS 8
#define H68_SIG_MAX_HARM 16
#define H68_SIG_MAX_BANDS 8
#define H68_SIG_VERSION 1

typedef struct {
  int version;
  int blades;

  /* Rotor rates as ratios to the slowest, so the set survives a global speed
   * change. comb_ratios[0] is 1.0 by construction. */
  int n_combs;
  float comb_ratios[H68_SIG_MAX_COMBS];

  /* Harmonic envelope, dB relative to the fundamental. */
  int n_harmonics;
  float harmonic_rel_db[H68_SIG_MAX_HARM];
  float harmonic_sd_db[H68_SIG_MAX_HARM]; /* spread across frames */

  /* Band energies, dB relative to total energy in the analysed span. */
  int n_bands;
  float band_rel_db[H68_SIG_MAX_BANDS];

  float hnr_db;
  float hnr_sd_db;

  /* Acceptance gate, not a discriminator: wide enough to cover the RID module,
   * battery sag and manoeuvring. */
  float f0_gate_lo_hz;
  float f0_gate_hi_hz;

  float f0_drift_pct;  /* spread of f0 within the labelled segment */
  float mod_depth_db;  /* peak-to-peak amplitude modulation of the comb */
  int n_frames;        /* frames that contributed */
} h68_signature;

/* Extracts a template from a labelled stretch of magnitude spectrogram.
 *
 * mag is frames*bins linear magnitudes. band_edges holds n_bands+1 ascending
 * frequencies in Hz. Frames where no comb locks are skipped, and n_frames reports
 * how many actually contributed, so a template built from mostly silence is
 * visibly weak rather than quietly wrong. */
h68_status h68_signature_extract(const float *mag, int frames, int bins,
                                 float bin_hz, float f_lo_hz, float f_hi_hz,
                                 int n_harm, int blades,
                                 const float *band_edges, int n_bands,
                                 h68_signature *out);

/* Scores one frame against a template. Returns 0..1, where 1 is a perfect match.
 * out_f0_hz receives the f0 that was matched, which is worth surfacing because it
 * says how far the machine has drifted from the template's conditions. */
float h68_signature_match(const h68_signature *sig, const float *mag, int bins,
                          float bin_hz, const float *band_edges,
                          float *out_f0_hz);

/* Symmetric distance between two templates, 0 meaning identical. Useful for
 * asking whether two recordings describe the same airframe. */
float h68_signature_distance(const h68_signature *a, const h68_signature *b);

#ifdef __cplusplus
}
#endif

#endif /* H68_SIGNATURE_H */
