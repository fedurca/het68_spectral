#include "h68_stft.h"

#include <math.h>
#include <string.h>

#include "h68_fft.h"
#include "h68_window.h"

/* Static working set rather than arena blocks: the arena holds only FFT plans,
 * which are shared and never released, so no module can invalidate another's
 * buffers. Lowering H68_MAX_FFT for an ARM build shrinks all of this
 * proportionally. */
static float g_window[H68_MAX_FFT];
static float g_padded[H68_MAX_FFT];
static kiss_fft_cpx g_spec[H68_MAX_BINS];

typedef struct {
  int configured;
  int fft_size;
  int win_length;
  int hop;
  h68_window_kind kind;
  float beta;
  float sample_rate;
  kiss_fftr_cfg fwd;
  float win_sum;
  h68_stft_metrics metrics;
} h68_stft_state;

static h68_stft_state g;

static int is_pow2(int v) { return v > 0 && (v & (v - 1)) == 0; }

h68_status h68_stft_configure(int fft_size, int win_length, int hop,
                              h68_window_kind kind, float beta,
                              float sample_rate) {
  if (!is_pow2(fft_size) || fft_size < 16 || fft_size > H68_MAX_FFT) {
    return H68_ERR_ARG;
  }
  if (win_length <= 0 || win_length > fft_size) return H68_ERR_ARG;
  if (hop <= 0 || hop > win_length) return H68_ERR_ARG;
  if (sample_rate <= 0.0f) return H68_ERR_ARG;

  kiss_fftr_cfg fwd = h68_fftr_plan(fft_size, 0);
  if (!fwd) return H68_ERR_NOMEM;

  const int window_changed = !g.configured || g.win_length != win_length ||
                             g.kind != kind || g.beta != beta;
  const int size_changed = !g.configured || g.fft_size != fft_size;

  g.fwd = fwd;
  g.fft_size = fft_size;
  g.win_length = win_length;
  g.hop = hop;
  g.kind = kind;
  g.beta = beta;
  g.sample_rate = sample_rate;

  if (window_changed) {
    h68_window_fill(g_window, win_length, kind, beta);
    g.win_sum = 0.0f;
    for (int i = 0; i < win_length; ++i) g.win_sum += g_window[i];
    if (g.win_sum == 0.0f) g.win_sum = 1.0f;
  }
  if (size_changed || window_changed) {
    /* Zero the padding tail once; the analysis loop only ever writes the first
     * win_length entries. */
    memset(g_padded, 0, sizeof(float) * (size_t)fft_size);
  }
  g.configured = 1;

  h68_stft_metrics *m = &g.metrics;
  m->fft_size = fft_size;
  m->hop = hop;
  m->win_length = win_length;
  m->sample_rate = sample_rate;
  m->bin_hz = sample_rate / (float)fft_size;
  m->window_ms = (float)win_length / sample_rate * 1000.0f;
  m->hop_ms = (float)hop / sample_rate * 1000.0f;
  m->overlap = 1.0f - (float)hop / (float)win_length;
  h68_window_metrics(g_window, win_length, &m->coherent_gain, &m->enbw_bins,
                     &m->nenbw, &m->scallop_db, &m->sidelobe_db);
  /* ENBW in Hz follows the window length, not the padded transform: zero padding
   * adds bins but no independent information. */
  m->enbw_hz = m->enbw_bins * (sample_rate / (float)win_length);

  return H68_OK;
}

const h68_stft_metrics *h68_stft_metrics_get(void) {
  return g.configured ? &g.metrics : NULL;
}

int h68_stft_bins(void) { return g.configured ? (g.fft_size / 2 + 1) : 0; }

int h68_stft_frame_count(int nsamples) {
  if (!g.configured || nsamples < g.win_length) return 0;
  return (nsamples - g.win_length) / g.hop + 1;
}

h68_status h68_stft_frame_complex(const float *x, float *out_re,
                                  float *out_im) {
  if (!g.configured) return H68_ERR_STATE;
  if (!x) return H68_ERR_ARG;

  for (int i = 0; i < g.win_length; ++i) g_padded[i] = x[i] * g_window[i];
  kiss_fftr(g.fwd, g_padded, g_spec);

  const int bins = g.fft_size / 2 + 1;
  for (int k = 0; k < bins; ++k) {
    if (out_re) out_re[k] = g_spec[k].r;
    if (out_im) out_im[k] = g_spec[k].i;
  }
  return H68_OK;
}

h68_status h68_stft_frame_magnitude(const float *x, float *out_mag) {
  if (!g.configured) return H68_ERR_STATE;
  if (!x || !out_mag) return H68_ERR_ARG;

  const int bins = g.fft_size / 2 + 1;
  const float norm = 2.0f / g.win_sum;

  for (int i = 0; i < g.win_length; ++i) g_padded[i] = x[i] * g_window[i];
  kiss_fftr(g.fwd, g_padded, g_spec);

  for (int k = 0; k < bins; ++k) {
    const float re = g_spec[k].r;
    const float im = g_spec[k].i;
    const float scale = (k == 0 || k == bins - 1) ? (norm * 0.5f) : norm;
    out_mag[k] = sqrtf(re * re + im * im) * scale;
  }
  return H68_OK;
}

h68_status h68_stft_analyze(const float *x, int nsamples, float floor_db,
                            float *out_db, float *out_phase) {
  if (!g.configured) return H68_ERR_STATE;
  if (!x) return H68_ERR_ARG;

  const int bins = g.fft_size / 2 + 1;
  const int frames = h68_stft_frame_count(nsamples);
  /* Single-sided amplitude: double every bin except DC and Nyquist, and divide
   * out the window's coherent gain, so a full-scale sinusoid reads 0 dBFS at any
   * transform size. A threshold tuned at one FFT size then still means the same
   * thing at another. */
  const float norm = 2.0f / g.win_sum;

  for (int f = 0; f < frames; ++f) {
    const float *frame = x + (size_t)f * (size_t)g.hop;
    for (int i = 0; i < g.win_length; ++i) g_padded[i] = frame[i] * g_window[i];
    kiss_fftr(g.fwd, g_padded, g_spec);

    float *db_row = out_db ? out_db + (size_t)f * (size_t)bins : NULL;
    float *ph_row = out_phase ? out_phase + (size_t)f * (size_t)bins : NULL;

    for (int k = 0; k < bins; ++k) {
      const float re = g_spec[k].r;
      const float im = g_spec[k].i;
      if (db_row) {
        const float scale = (k == 0 || k == bins - 1) ? (norm * 0.5f) : norm;
        const float mag = sqrtf(re * re + im * im) * scale;
        float db = (mag > 0.0f) ? 20.0f * log10f(mag) : floor_db;
        if (db < floor_db) db = floor_db;
        db_row[k] = db;
      }
      if (ph_row) ph_row[k] = atan2f(im, re);
    }
  }
  return H68_OK;
}
