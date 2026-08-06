#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef bool (*het68_core1_verify_fn)(void);

static inline bool het68_launch_core1_verify(void (*entry)(void),
                                             het68_core1_verify_fn verify) {
  (void)entry;
  (void)verify;
  /* Host never launches a second core; doa_step replaces the loop. */
  return true;
}

static inline bool het68_launch_core1(void (*entry)(void)) {
  (void)entry;
  return true;
}

extern volatile uint32_t g_core1_alive;
extern volatile uint32_t g_core1_hb;
