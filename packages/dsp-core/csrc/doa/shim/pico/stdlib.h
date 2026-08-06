#pragma once
/* Host stand-in for pico/stdlib.h — no hardware. */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <string.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static inline void sleep_ms(uint32_t ms) { (void)ms; }
static inline void tight_loop_contents(void) {}
static inline uint32_t time_us_32(void) { return 0; }

/* Sample clock is owned by the DOA host shim (doa_host_time.c). */
uint64_t doa_host_time_us(void);
static inline uint64_t time_us_64(void) { return doa_host_time_us(); }
