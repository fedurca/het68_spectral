/*
 * Host API wrapping the vendored doa.c engine.
 */
#include "doa.h"
#include "doa_params.h"
#include "debug_io.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define H68_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define H68_EXPORT
#endif

/* Flat float layout: 0 edge_mm … 9 walk_rms, 10 pair_mask, 11 log_enabled. */
static void params_from_flat(const float *f, doa_params_t *p) {
  doa_params_defaults(p);
  if (!f) return;
  p->edge_mm = f[0];
  p->c_mm_s = f[1];
  p->drone_rms = f[2];
  p->wind_ratio = f[3];
  p->wind_rms_min = f[4];
  p->drone_crest_max = f[5];
  p->drone_conf_min = f[6];
  p->veh_rms = f[7];
  p->bird_rms = f[8];
  p->walk_rms = f[9];
  p->pair_mask = (uint32_t)f[10];
  p->log_enabled = f[11] != 0.0f ? 1 : 0;
}

static void params_to_flat(const doa_params_t *p, float *f) {
  if (!f || !p) return;
  f[0] = p->edge_mm;
  f[1] = p->c_mm_s;
  f[2] = p->drone_rms;
  f[3] = p->wind_ratio;
  f[4] = p->wind_rms_min;
  f[5] = p->drone_crest_max;
  f[6] = p->drone_conf_min;
  f[7] = p->veh_rms;
  f[8] = p->bird_rms;
  f[9] = p->walk_rms;
  f[10] = (float)p->pair_mask;
  f[11] = p->log_enabled ? 1.0f : 0.0f;
}

H68_EXPORT void h68_api_doa_params_defaults(float *flat12) {
  doa_params_t p;
  doa_params_defaults(&p);
  params_to_flat(&p, flat12);
}

H68_EXPORT void h68_api_doa_params_set(const float *flat12) {
  doa_params_t p;
  params_from_flat(flat12, &p);
  doa_params_set(&p);
}

H68_EXPORT void h68_api_doa_params_get(float *flat12) {
  params_to_flat(doa_params_get(), flat12);
}

H68_EXPORT void h68_api_doa_reset(void) { doa_reset(); }

H68_EXPORT void h68_api_doa_push(const int16_t *interleaved, int frames) {
  if (!interleaved || frames <= 0) return;
  for (int i = 0; i < frames; i++) {
    doa_ring_push(interleaved + i * 6);
  }
}

H68_EXPORT uint32_t h68_api_doa_step(uint32_t budget) { return doa_step(budget); }

H68_EXPORT int h68_api_doa_drain_lines(char *dst, int dst_bytes) {
  return doa_host_drain_lines(dst, dst_bytes);
}

H68_EXPORT int h68_api_doa_line_count(void) { return doa_host_line_count(); }

H68_EXPORT uint32_t h68_api_doa_ndrone(void) { return g_doa_ndrone; }
H68_EXPORT uint32_t h68_api_doa_nvehicle(void) { return g_doa_nvehicle; }
H68_EXPORT uint32_t h68_api_doa_nbird(void) { return g_doa_nbird; }
H68_EXPORT uint32_t h68_api_doa_nwalker(void) { return g_doa_nwalker; }
H68_EXPORT uint32_t h68_api_doa_wind(void) { return g_doa_wind; }
H68_EXPORT float h68_api_doa_wind_az(void) { return g_doa_wind_az; }
H68_EXPORT float h68_api_doa_wind_el(void) { return g_doa_wind_el; }
