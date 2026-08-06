#ifndef H68_BANDS_H
#define H68_BANDS_H

#include "h68_dsp.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Per-band metrics over time.
 *
 * This lives in C rather than in the UI because the firmware does exactly this:
 * it sums spectral power into class bands and decides from the result. Keeping the
 * arithmetic here means a threshold read off a plot in the analyzer is the same
 * number the detector will compare against, including the normalisation.
 *
 * Bands are half-open in frequency, [lo, hi). A band narrower than one bin is
 * widened to a single bin rather than reported as empty, so an over-tight band is
 * visibly wrong instead of silently zero. */

typedef struct {
  float energy_db;  /* mean power in the band, dBFS, one full-scale sinusoid = 0 */
  float tonality_db;/* -10*log10(spectral flatness): 0 is noise-like, high is tonal */
  float peak_db;    /* strongest bin in the band */
  float peak_hz;
} h68_band_frame;

/* One band, one frame, from a linear magnitude spectrum. */
h68_band_frame h68_band_frame_metrics(const float *mag, int bins, float bin_hz,
                                      float lo_hz, float hi_hz);

/* Percentile of a dB series without sorting, via a fixed histogram over
 * [-200, 20] dB in 0.25 dB steps. Used for the per-band noise floor, where the
 * point is a robust low quantile rather than an exact order statistic, and where
 * the recording may be long enough that sorting would need unbounded scratch. */
float h68_db_percentile(const float *series, int n, float pct);

#ifdef __cplusplus
}
#endif

#endif /* H68_BANDS_H */
