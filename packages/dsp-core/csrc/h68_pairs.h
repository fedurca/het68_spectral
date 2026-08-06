/*
 * Pairwise microphone analysis.
 *
 * Sign convention throughout: cross-correlating channel i against channel j uses
 * S = conj(Xi) * Xj, whose peak sits at tau = t_j - t_i. A positive lag therefore
 * means the wavefront reached j later than i, which matches
 * h68_expected_lag_samples() so measured and predicted lags can be compared
 * directly with no sign juggling.
 */
#ifndef H68_PAIRS_H
#define H68_PAIRS_H

#include "h68_dsp.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  float peak_lag;     /* parabolically interpolated, samples */
  float peak_value;   /* 1.0 means a perfectly coherent single delay */
  float second_lag;   /* strongest competitor outside the main lobe */
  float second_value;
  float peak_ratio;   /* peak / second; near 1 means the delay is ambiguous */
  int   peak_index;   /* integer argmax within the searched lag window */
} h68_gcc_result;

/* One GCC column for a pair.
 *
 * block_len samples are read from each channel and zero padded to nfft, which
 * must be at least 2*block_len so the correlation does not wrap. Restricting
 * [f_lo_hz, f_hi_hz] is the point of the exercise rather than an optimisation:
 * comparing the lag a single harmonic gives against the lag the whole comb gives
 * is how spatial aliasing becomes visible.
 *
 * out_corr receives 2*max_lag+1 values, index 0 being lag -max_lag. Pass NULL if
 * only the peak statistics are wanted. use_phat selects GCC-PHAT (whitened)
 * over plain energy-normalised GCC. */
h68_status h68_gcc_column(const float *xi, const float *xj, int block_len,
                          int nfft, int use_phat, int max_lag, float f_lo_hz,
                          float f_hi_hz, float sample_rate, float *out_corr,
                          h68_gcc_result *out);

/* Welch-averaged magnitude-squared coherence for a pair over the whole signal.
 * out_msc holds nfft/2+1 values in [0,1]. Coherence, not correlation, is what
 * says whether a band carries a usable delay at all. */
h68_status h68_coherence(const float *xi, const float *xj, int nsamples,
                         int nfft, int hop, h68_window_kind kind, float beta,
                         float *out_msc, int *out_frames);

/* Mean coherence across a frequency band, weighted by the average of the two
 * channels' power so silent bins do not dominate. */
float h68_coherence_band(const float *msc, int nfft, float sample_rate,
                         float f_lo_hz, float f_hi_hz);

#ifdef __cplusplus
}
#endif

#endif /* H68_PAIRS_H */
