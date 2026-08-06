/*
 * Bump allocator over a static buffer.
 *
 * KISS FFT can place its state in caller-supplied memory, which is how this
 * project avoids malloc entirely. Allocation happens only from h68_*_init(),
 * never from a processing call, and the arena is reset wholesale rather than
 * freeing individual blocks.
 */
#ifndef H68_ARENA_H
#define H68_ARENA_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Sized for two cached real-FFT plans at H68_MAX_FFT plus the pair-correlation
 * complex plan. At 16384 a forward real plan needs ~164 kB. */
#ifndef H68_ARENA_BYTES
#define H68_ARENA_BYTES (1024u * 1024u)
#endif

/* Returns NULL when the arena is exhausted; callers must check. */
void *h68_arena_alloc(size_t bytes);
void h68_arena_reset(void);
size_t h68_arena_used(void);
size_t h68_arena_capacity(void);

#ifdef __cplusplus
}
#endif

#endif /* H68_ARENA_H */
