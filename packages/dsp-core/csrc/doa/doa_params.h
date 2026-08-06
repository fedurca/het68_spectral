#pragma once
/*
 * Runtime parameters for the host/WASM build of doa.c.
 *
 * Compile-time array sizes still use a maximum edge (see DOA_EDGE_MM in doa.c)
 * so buffers fit every geometry in the 350–512 mm design range. The live edge,
 * sound speed and classifier thresholds are read from this struct on every
 * analysis pass.
 */
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  float edge_mm;
  float c_mm_s;
  float drone_rms;
  float wind_ratio;
  float wind_rms_min;
  float drone_crest_max;
  float drone_conf_min;
  float veh_rms;
  float bird_rms;
  float walk_rms;
  /** Bitmask of enabled mic pairs: bit (i*6+j) for i<j. 0 = all pairs. */
  uint32_t pair_mask;
  /** 1 = emit SRC/TRACKS lines into the host line buffer. */
  int log_enabled;
} doa_params_t;

void doa_params_defaults(doa_params_t *p);
const doa_params_t *doa_params_get(void);
void doa_params_set(const doa_params_t *p);

/** Reset ring, tracks and sample clock; apply MIC_POS from current edge. */
void doa_reset(void);

/**
 * Advance the DOA engine by consuming up to `budget` ring samples already
 * pushed via doa_ring_push. Returns the number of samples consumed. Call in a
 * loop until the ring is drained or after feeding a whole recording.
 */
uint32_t doa_step(uint32_t budget);

/** Host sample clock used in place of time_us_64 (samples since reset). */
uint64_t doa_sample_clock(void);

#ifdef __cplusplus
}
#endif
