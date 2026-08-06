#include "h68_arena.h"

#include <stdint.h>

/* Aligned to 8 so that kiss_fft_cpx (two floats) and any double scratch land on
 * natural boundaries on both wasm32 and arm. */
static union {
  double align;
  unsigned char bytes[H68_ARENA_BYTES];
} g_arena;

static size_t g_used;

void *h68_arena_alloc(size_t bytes) {
  size_t aligned = (bytes + 7u) & ~(size_t)7u;
  if (aligned > H68_ARENA_BYTES - g_used) {
    return NULL;
  }
  void *p = &g_arena.bytes[g_used];
  g_used += aligned;
  return p;
}

void h68_arena_reset(void) { g_used = 0; }

size_t h68_arena_used(void) { return g_used; }

size_t h68_arena_capacity(void) { return H68_ARENA_BYTES; }
