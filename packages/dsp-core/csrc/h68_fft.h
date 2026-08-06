/*
 * Plan cache for KISS FFT.
 *
 * Plans are the only thing that comes out of the arena, and they are never
 * released: a handful of transform sizes get reused for the whole session, so a
 * cache with no eviction is both simpler and safer than letting each module
 * reset the arena and invalidate its neighbours' pointers.
 */
#ifndef H68_FFT_H
#define H68_FFT_H

#include "kissfft/kiss_fftr.h"

#ifdef __cplusplus
extern "C" {
#endif

#ifndef H68_FFT_MAX_PLANS
#define H68_FFT_MAX_PLANS 8
#endif

/* Returns a cached real-FFT plan, building it on first use. NULL when the arena
 * or the cache is full. inverse selects kiss_fftri's direction. */
kiss_fftr_cfg h68_fftr_plan(int nfft, int inverse);

int h68_fft_plans_cached(void);

#ifdef __cplusplus
}
#endif

#endif /* H68_FFT_H */
