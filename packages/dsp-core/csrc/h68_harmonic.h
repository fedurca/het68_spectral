/*
 * Harmonic comb analysis: blade-pass frequency, multi-rotor separation, tonality.
 *
 * The comb salience used here sums log magnitude across harmonics of a candidate
 * f0 rather than multiplying them (a classic harmonic product spectrum). Summing
 * logs is the same idea in a numerically stable form, and it has a property that
 * matters for this application: the salience peak narrows in proportion to the
 * number of harmonics used. Four rotors 1 percent apart are only a fraction of a
 * bin apart at the fundamental but clearly separated by the ninth harmonic, so
 * pushing the comb high is what makes multi-rotor separation possible at all.
 */
#ifndef H68_HARMONIC_H
#define H68_HARMONIC_H

#include "h68_dsp.h"

#ifdef __cplusplus
extern "C" {
#endif

#define H68_MAX_F0_CANDIDATES 8

typedef struct {
  float f0_hz;
  float score;      /* comb salience above the local noise floor, dB */
  float rpm;        /* f0 / blades * 60, the unit that exposes a nonsense result */
  float hnr_db;     /* harmonic-to-noise ratio over the searched band */
  int n_harmonics;  /* harmonics found above the floor */
} h68_f0_candidate;

/* Candidate blade-pass frequencies from one magnitude spectrum, strongest first.
 *
 * mag holds `bins` linear magnitudes (not dB). Candidates are separated by at
 * least 1 percent in f0 so the individual rotors of a quad survive as distinct
 * entries. Octave errors are checked explicitly: a comb at 2*f0 always also fits
 * f0, so a half-frequency candidate that explains the spectrum nearly as well
 * wins, which is the standard failure mode of this family of estimators. */
h68_status h68_f0_candidates(const float *mag, int bins, float bin_hz,
                             float f_lo_hz, float f_hi_hz, int n_harm,
                             int blades, h68_f0_candidate *out, int max_out,
                             int *out_count);

/* Harmonic-to-noise ratio for a known f0, in dB, over [f_lo, f_hi].
 *
 * This is the number that decides whether a comb-based detector is viable for the
 * Neo 2 at all: its ducted props suppress tonal peaks, and if HNR comes out low
 * the detector has to lean on broadband spectral shape instead. Better measured
 * than assumed. */
float h68_hnr_db(const float *mag, int bins, float bin_hz, float f0_hz,
                 int n_harm, float f_lo_hz, float f_hi_hz);

/* Real cepstrum of a magnitude spectrum, as an independent view of periodicity.
 * out_ceps receives `bins` values indexed by quefrency in samples; a comb with
 * spacing f0 shows a peak at fs/f0. cepstrum_size must be a power of two of at
 * least 2*(bins-1). */
h68_status h68_cepstrum(const float *mag, int bins, int cepstrum_size,
                        float *out_ceps);

/* Continuity tracker. Rotor speed changes with throttle, battery and wind, so the
 * f0 trajectory is itself a discriminator and has to survive frames where the
 * strongest candidate jumps an octave or picks up a neighbouring rotor. */
typedef struct {
  float f0;
  float confidence;
  int locked;
  int miss_count;
} h68_comb_tracker;

void h68_comb_tracker_reset(h68_comb_tracker *t);

/* max_rel_jump is a fraction (0.05 allows 5 percent frame to frame). After
 * max_miss consecutive frames without a plausible candidate the tracker unlocks
 * and is free to jump anywhere. */
void h68_comb_tracker_update(h68_comb_tracker *t,
                             const h68_f0_candidate *cands, int n_cands,
                             float max_rel_jump, int max_miss);

#ifdef __cplusplus
}
#endif

#endif /* H68_HARMONIC_H */
