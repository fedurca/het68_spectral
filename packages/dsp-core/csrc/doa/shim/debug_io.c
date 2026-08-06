/*
 * Capture dbg_puts output into a line ring for the analyzer UI / tests.
 */
#include "debug_io.h"

#include <stdio.h>
#include <string.h>

#define LINE_CAP 64
#define LINE_LEN 256
#define RING_BYTES (LINE_CAP * LINE_LEN)

static char g_lines[LINE_CAP][LINE_LEN];
static int g_line_n;
static int g_line_w;
static char g_cur[LINE_LEN];
static int g_cur_n;
static bool g_log = true;

void dbg_init(void) {
  g_line_n = 0;
  g_line_w = 0;
  g_cur_n = 0;
}

void dbg_flush(void) {}

void dbg_putc(char c) {
  if (c == '\n' || g_cur_n >= LINE_LEN - 1) {
    g_cur[g_cur_n] = '\0';
    memcpy(g_lines[g_line_w], g_cur, LINE_LEN);
    g_line_w = (g_line_w + 1) % LINE_CAP;
    if (g_line_n < LINE_CAP) g_line_n++;
    g_cur_n = 0;
    if (c != '\n' && c != '\0') {
      g_cur[g_cur_n++] = c;
    }
    return;
  }
  if (c != '\r') g_cur[g_cur_n++] = c;
}

void dbg_puts(const char *s) {
  if (!s) return;
  while (*s) dbg_putc(*s++);
}

void dbg_putu32(uint32_t v) {
  char buf[16];
  snprintf(buf, sizeof(buf), "%u", (unsigned)v);
  dbg_puts(buf);
}

void dbg_puthex8(uint8_t v) {
  char buf[8];
  snprintf(buf, sizeof(buf), "%02x", (unsigned)v);
  dbg_puts(buf);
}

void dbg_puthex32(uint32_t v) {
  char buf[16];
  snprintf(buf, sizeof(buf), "%08x", (unsigned)v);
  dbg_puts(buf);
}

bool dbg_rx_available(void) { return false; }
int dbg_getc(void) { return -1; }
uint32_t dbg_line_lock(void) { return 0; }
void dbg_line_unlock(uint32_t saved) { (void)saved; }

void dbg_log_set(bool enabled) { g_log = enabled; }
bool dbg_log_enabled(void) { return g_log; }

int doa_host_line_count(void) { return g_line_n; }

void doa_host_clear_lines(void) {
  g_line_n = 0;
  g_line_w = 0;
  g_cur_n = 0;
}

int doa_host_drain_lines(char *dst, int dst_bytes) {
  if (!dst || dst_bytes <= 0) return 0;
  int used = 0;
  int n = g_line_n;
  int start = (g_line_w - n + LINE_CAP) % LINE_CAP;
  for (int i = 0; i < n; i++) {
    const char *line = g_lines[(start + i) % LINE_CAP];
    int len = (int)strlen(line);
    if (used + len + 2 > dst_bytes) break;
    memcpy(dst + used, line, (size_t)len);
    used += len;
    dst[used++] = '\n';
  }
  dst[used] = '\0';
  doa_host_clear_lines();
  return used;
}
