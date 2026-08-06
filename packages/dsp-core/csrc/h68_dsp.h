/*
 * het68 spectral - shared DSP definitions.
 *
 * This code is written to the same constraints as the het68 firmware so that it
 * can later be compiled for core1 of the RP2350 without modification:
 *   - no malloc/free in any processing path (init-time arena only)
 *   - all working memory is static or supplied by the caller
 *   - no blocking, no I/O, no global mutable state beyond the arena
 */
#ifndef H68_DSP_H
#define H68_DSP_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Detection cube: 6 microphones at the face centres of a cube standing on a
 * vertex. 15 unordered pairs. */
#define H68_NCH 6
#define H68_NPAIRS 15

/* Largest transform the analyzer offers. The arena is sized from this, so
 * lowering it for an ARM build shrinks the static footprint proportionally. */
#ifndef H68_MAX_FFT
#define H68_MAX_FFT 16384
#endif
#define H68_MAX_BINS (H68_MAX_FFT / 2 + 1)

/* M_PI is a POSIX extension rather than standard C and is absent under -std=c11 on
 * some toolchains, emcc among them. Carrying our own constant keeps the value
 * identical on every target, which is a precondition for comparing wasm output
 * against an ARM build bit for bit. */
#define H68_PI 3.14159265358979323846

/* Reference speed of sound at 20 C, dry air. Callers normally pass a value
 * derived from temperature and humidity instead. */
#define H68_C_REF 343.0f

/* Sound speed the firmware uses to size its correlation window. It is a cold
 * extreme, not a nominal value: doa.c derives DOA_MAXLAG from it so the lag
 * window stays valid down to about -40 C. Reproduced here so the analyzer can
 * show the same maxlag the firmware would use. */
#define H68_C_COLD_EXTREME 300.0f

typedef enum {
  H68_WIN_RECT = 0,
  H68_WIN_HANN = 1,
  H68_WIN_HAMMING = 2,
  H68_WIN_BLACKMAN_HARRIS = 3,
  H68_WIN_KAISER = 4
} h68_window_kind;

typedef enum {
  H68_OK = 0,
  H68_ERR_ARG = -1,
  H68_ERR_NOMEM = -2,
  H68_ERR_STATE = -3
} h68_status;

/* Metrics that decide whether a harmonic comb can be resolved at all. Recomputed
 * whenever the window or transform size changes and surfaced in the UI. */
typedef struct {
  int fft_size;
  int hop;
  int win_length;      /* window length before zero padding */
  float sample_rate;
  float bin_hz;        /* sample_rate / fft_size */
  float window_ms;     /* win_length / sample_rate * 1000 */
  float hop_ms;
  float overlap;       /* fraction, 0..1 */
  float enbw_bins;     /* equivalent noise bandwidth in bins */
  float enbw_hz;
  float coherent_gain; /* sum(w)/N */
  float scallop_db;    /* worst-case loss for a tone between two bins */
  float nenbw;         /* normalised ENBW = N*sum(w^2)/sum(w)^2 */
  float sidelobe_db;   /* highest sidelobe of the window, measured numerically */
} h68_stft_metrics;

#ifdef __cplusplus
}
#endif

#endif /* H68_DSP_H */
