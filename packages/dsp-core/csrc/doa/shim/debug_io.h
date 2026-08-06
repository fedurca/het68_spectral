#pragma once
#include <stdint.h>
#include <stdbool.h>

void dbg_init(void);
void dbg_putc(char c);
void dbg_flush(void);
void dbg_puts(const char *s);
void dbg_putu32(uint32_t v);
void dbg_puthex8(uint8_t v);
void dbg_puthex32(uint32_t v);
bool dbg_rx_available(void);
int dbg_getc(void);
uint32_t dbg_line_lock(void);
void dbg_line_unlock(uint32_t saved);
void dbg_log_set(bool enabled);
bool dbg_log_enabled(void);

#define DBG_CP(letter) do { dbg_putc(letter); dbg_putc('\n'); } while (0)

/* Host-only: drain captured UART lines into a caller buffer (newline-separated). */
int doa_host_line_count(void);
int doa_host_drain_lines(char *dst, int dst_bytes);
void doa_host_clear_lines(void);
