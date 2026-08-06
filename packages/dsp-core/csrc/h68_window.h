#ifndef H68_WINDOW_H
#define H68_WINDOW_H

#include "h68_dsp.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Fills w[0..n-1] with a periodic (DFT-even) window. Periodic rather than
 * symmetric because these windows are used for spectral analysis, where the
 * periodic form gives the cleaner transform. beta applies to Kaiser only. */
void h68_window_fill(float *w, int n, h68_window_kind kind, float beta);

/* Derived properties of a filled window. sidelobe_db is measured from the
 * window's DTFT rather than tabulated, so a Kaiser beta the caller invented
 * still reports a truthful number. */
void h68_window_metrics(const float *w, int n, float *coherent_gain,
                        float *enbw_bins, float *nenbw, float *scallop_db,
                        float *sidelobe_db);

#ifdef __cplusplus
}
#endif

#endif /* H68_WINDOW_H */
