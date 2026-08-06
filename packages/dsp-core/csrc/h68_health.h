/*
 * Array health and per-channel statistics.
 *
 * A dead or saturated microphone destroys every spatial result silently, so these
 * checks are meant to be always visible rather than run on demand. The project has
 * no per-channel gain or delay calibration anywhere else: the firmware applies a
 * single global I2S_LSHIFT_LEFT to all six channels, so measuring and correcting
 * channel differences is entirely this application's job.
 */
#ifndef H68_HEALTH_H
#define H68_HEALTH_H

#include "h68_dsp.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  float rms;
  float rms_db;
  float peak;
  float peak_db;
  float crest_db;
  float dc;             /* mean, in full-scale units */
  int clipped_samples;
  int silent_samples;   /* runs of exact zero, which indicate dropouts */
  float noise_floor_db; /* 10th percentile of short-block RMS */
  float zero_crossing_rate;
  int dead;             /* variance indistinguishable from zero */
  int saturated;        /* clipping on a meaningful fraction of samples */
} h68_channel_stats;

/* clip_thresh is in full-scale units; 0.999 catches a 24-bit channel pinned at
 * full scale without flagging honest loud passages. */
void h68_channel_stats_compute(const float *x, int n, float clip_thresh,
                               h68_channel_stats *out);

/* Pearson correlation of two channels over the whole block, means removed.
 * Between two mics 27 cm apart looking at diffuse noise this should be small; a
 * value near 1 means duplicated channels, and near -1 means inverted polarity. */
float h68_channel_correlation(const float *a, const float *b, int n);

/* Single-frequency power in a block via Goertzel: cheaper than an FFT and exactly
 * what a fixed-tone calibration signal needs. Returns magnitude in full-scale
 * units. */
float h68_goertzel(const float *x, int n, float freq_hz, float sample_rate);

/* Channel mapping probe for the 1 kHz / 100 ms alternating test signal produced by
 * 1kHz_100ms_LR_flip.py. For each slot it reports which channel carried the tone,
 * which is the only way to catch a channel swap before it silently rotates every
 * azimuth the array reports.
 *
 * planar: nch blocks of n samples. out_active receives one channel index per slot,
 * or -1 when no channel stood out. */
h68_status h68_mapping_probe(const float *planar, int nch, int n,
                             float sample_rate, float tone_hz, float slot_ms,
                             int *out_active, float *out_margin_db,
                             int max_slots, int *out_slots);

#ifdef __cplusplus
}
#endif

#endif /* H68_HEALTH_H */
