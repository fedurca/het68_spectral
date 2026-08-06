#include "h68_fft.h"

#include "h68_arena.h"

typedef struct {
  int nfft;
  int inverse;
  kiss_fftr_cfg cfg;
} plan_slot;

static plan_slot g_plans[H68_FFT_MAX_PLANS];
static int g_count;

kiss_fftr_cfg h68_fftr_plan(int nfft, int inverse) {
  if (nfft < 16 || (nfft & 1)) return NULL;
  inverse = inverse ? 1 : 0;

  for (int i = 0; i < g_count; ++i) {
    if (g_plans[i].nfft == nfft && g_plans[i].inverse == inverse) {
      return g_plans[i].cfg;
    }
  }
  if (g_count >= H68_FFT_MAX_PLANS) return NULL;

  size_t need = 0;
  kiss_fftr_alloc(nfft, inverse, NULL, &need);
  void *mem = h68_arena_alloc(need);
  if (!mem) return NULL;
  size_t have = need;
  kiss_fftr_cfg cfg = kiss_fftr_alloc(nfft, inverse, mem, &have);
  if (!cfg) return NULL;

  g_plans[g_count].nfft = nfft;
  g_plans[g_count].inverse = inverse;
  g_plans[g_count].cfg = cfg;
  ++g_count;
  return cfg;
}

int h68_fft_plans_cached(void) { return g_count; }
