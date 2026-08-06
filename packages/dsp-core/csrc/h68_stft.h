#ifndef H68_STFT_H
#define H68_STFT_H

#include "h68_dsp.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Configures the shared analysis geometry. win_length may be shorter than
 * fft_size, in which case the frame is zero padded, which interpolates the
 * spectrum without improving true resolution. Plans are cached, so calling this
 * repeatedly with the same arguments is free. */
h68_status h68_stft_configure(int fft_size, int win_length, int hop,
                              h68_window_kind kind, float beta,
                              float sample_rate);

const h68_stft_metrics *h68_stft_metrics_get(void);
int h68_stft_bins(void);
int h68_stft_frame_count(int nsamples);

/* Magnitude is normalised so a full-scale sinusoid reads 0 dBFS regardless of
 * window or transform size: the one-sided amplitude spectrum, scaled by the
 * window's coherent gain. Without that normalisation a threshold tuned at one
 * FFT size would be wrong at another.
 *
 * out_db   : frame_count * bins, may be NULL
 * out_phase: frame_count * bins radians in (-pi, pi], may be NULL
 * floor_db : values below this are clamped, keeping the colour scale usable */
h68_status h68_stft_analyze(const float *x, int nsamples, float floor_db,
                            float *out_db, float *out_phase);

/* Single frame, for callers that need the raw complex spectrum (pair analysis,
 * cepstrum). out_re/out_im hold `bins` values. Reads win_length samples from x
 * and does not bounds check, so the caller must supply a full frame. */
h68_status h68_stft_frame_complex(const float *x, float *out_re, float *out_im);

/* One frame as normalised linear magnitude, same scaling as the dB path. Lets a
 * caller sweep a long recording with a single bins-sized buffer instead of
 * materialising the whole spectrogram, which is what band metrics need. */
h68_status h68_stft_frame_magnitude(const float *x, float *out_mag);

#ifdef __cplusplus
}
#endif

#endif /* H68_STFT_H */
