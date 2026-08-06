/*
 * Synthetic scene generator for the 6-microphone cube.
 *
 * Built first, before any real recording exists, because it is the only way to
 * check the analysis chain against a known truth: a scene rendered for a given
 * azimuth and elevation says what GCC-PHAT must return, so a disagreement points
 * at the code rather than at the data. It also reproduces spatial aliasing on
 * demand (render a single tone above c/(2*baseline) and the grating lobes appear
 * where theory says they should).
 *
 * Deterministic for a given seed on every platform: the RNG is integer-only and
 * does not touch libc rand.
 */
#ifndef H68_SYNTH_H
#define H68_SYNTH_H

#include "h68_dsp.h"

#ifdef __cplusplus
extern "C" {
#endif

#define H68_SYNTH_MAX_ROTORS 8

typedef struct {
  float sample_rate;
  int n_samples;

  /* Array and medium */
  float edge_mm;
  float temp_c;
  float humidity_pct;
  float pressure_pa;
  int air_absorption; /* apply ISO 9613-1 atmospheric attenuation */

  /* Source position */
  float az_deg;
  float el_deg;
  float distance_m;

  /* Rotors. Independent RPM is the point: four rotors a few percent apart
   * produce four interleaved combs that beat against each other, which is the
   * most distinctive thing a multirotor does. */
  int n_rotors;
  int blades;
  float rpm[H68_SYNTH_MAX_ROTORS];
  float rpm_jitter_pct; /* random-walk wander, per rotor */
  float rpm_ramp_pct;   /* linear drift across the take, models spool up */
  int n_harmonics;
  float harmonic_rolloff_db; /* level drop per harmonic */
  float tonal_level_db;      /* fundamental level at 1 m, dBFS */

  /* Broadband blade self-noise, band limited */
  float broadband_level_db;
  float broadband_lo_hz;
  float broadband_hi_hz;

  /* Site noise. Wind is decorrelated between mics; the pink background models a
   * diffuse field and is likewise independent per channel. */
  float wind_level_db;
  float wind_cutoff_hz;
  float background_level_db;

  /* Optional pure tone, for aliasing demonstrations */
  float tone_hz;
  float tone_level_db;

  unsigned int seed;
} h68_synth_params;

/* Sensible starting point modelled on a DJI Neo 2: 151 g, four two-blade 55.9 mm
 * ducted props, hover around 27000 rpm which puts the blade-pass fundamental near
 * 900 Hz. Ducted props are less tonal than open ones, so the broadband share here
 * is deliberately high. */
void h68_synth_defaults_neo2(h68_synth_params *p, float sample_rate,
                             int n_samples);

/* Renders planar output: channel c occupies out[c * n_samples ...]. Returns
 * H68_ERR_ARG on a malformed request. Needs no scratch from the caller. */
h68_status h68_synth_render(const h68_synth_params *p, float *out);

/* Atmospheric absorption in dB per metre, ISO 9613-1. Exposed because the
 * expected detection range at a given frequency is a question the UI should be
 * able to answer directly. */
float h68_air_absorption_db_per_m(float freq_hz, float temp_c,
                                  float humidity_pct, float pressure_pa);

#ifdef __cplusplus
}
#endif

#endif /* H68_SYNTH_H */
