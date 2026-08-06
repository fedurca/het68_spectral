#include "doa_params.h"

#include <string.h>

static doa_params_t g_params;
static int g_have;
static uint64_t g_sample_clock;
volatile uint32_t g_core1_alive = 1;
volatile uint32_t g_core1_hb;

void doa_params_defaults(doa_params_t *p) {
  if (!p) return;
  memset(p, 0, sizeof(*p));
  p->edge_mm = 384.0f;
  p->c_mm_s = 343000.0f;
  p->drone_rms = 2.5f;
  p->wind_ratio = 0.38f;
  p->wind_rms_min = 12.0f;
  p->drone_crest_max = 5.5f;
  p->drone_conf_min = 0.28f;
  p->veh_rms = 6.5f;
  p->bird_rms = 2.2f;
  p->walk_rms = 3.0f;
  p->pair_mask = 0;
  p->log_enabled = 1;
}

const doa_params_t *doa_params_get(void) {
  if (!g_have) {
    doa_params_defaults(&g_params);
    g_have = 1;
  }
  return &g_params;
}

void doa_params_set(const doa_params_t *p) {
  if (!p) return;
  g_params = *p;
  g_have = 1;
}

uint64_t doa_host_time_us(void) {
  /* 48 kHz → microseconds. */
  return (g_sample_clock * 1000000ull) / 48000ull;
}

uint64_t doa_sample_clock(void) { return g_sample_clock; }

void doa_host_advance_samples(uint32_t n) { g_sample_clock += n; }

void doa_host_reset_clock(void) { g_sample_clock = 0; }
