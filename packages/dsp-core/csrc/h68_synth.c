#include "h68_synth.h"

#include <math.h>
#include <string.h>

#include "h68_geometry.h"

/* ---- deterministic RNG ------------------------------------------------- */

/* PCG-XSH-RR. Integer only, so a seed reproduces bit-identical noise on wasm and
 * on arm, which is what makes a synthetic fixture usable as a regression test. */
typedef struct {
  unsigned long long state;
  unsigned long long inc;
} pcg32;

static void pcg_seed(pcg32 *r, unsigned int seed, unsigned int stream) {
  r->state = 0ULL;
  r->inc = ((unsigned long long)stream << 1u) | 1ULL;
  r->state = r->state * 6364136223846793005ULL + r->inc;
  r->state += (unsigned long long)seed;
  r->state = r->state * 6364136223846793005ULL + r->inc;
}

static unsigned int pcg_next(pcg32 *r) {
  unsigned long long old = r->state;
  r->state = old * 6364136223846793005ULL + r->inc;
  unsigned int xorshifted = (unsigned int)(((old >> 18u) ^ old) >> 27u);
  unsigned int rot = (unsigned int)(old >> 59u);
  return (xorshifted >> rot) | (xorshifted << ((0u - rot) & 31u));
}

/* Uniform in [-1, 1). */
static float pcg_uniform(pcg32 *r) {
  return (float)((double)pcg_next(r) / 2147483648.0 - 1.0);
}

/* Box-Muller, one value per call; the discarded second value costs nothing at the
 * sample rates involved and keeps the state simple. */
static float pcg_gauss(pcg32 *r) {
  double u1 = ((double)pcg_next(r) + 1.0) / 4294967297.0;
  double u2 = ((double)pcg_next(r) + 1.0) / 4294967297.0;
  return (float)(sqrt(-2.0 * log(u1)) * cos(6.283185307179586 * u2));
}

/* ---- atmospheric absorption (ISO 9613-1) ------------------------------- */

float h68_air_absorption_db_per_m(float freq_hz, float temp_c,
                                  float humidity_pct, float pressure_pa) {
  if (freq_hz <= 0.0f) return 0.0f;
  const double T = (double)temp_c + 273.15;
  const double T0 = 293.15;
  double p = (double)pressure_pa;
  if (p <= 0.0) p = 101325.0;
  const double p0 = 101325.0;
  const double pr = p / p0;
  const double f = (double)freq_hz;

  /* Molar concentration of water vapour, percent. */
  const double p_sat =
      610.94 * exp(17.625 * (double)temp_c / ((double)temp_c + 243.04));
  double rh = (double)humidity_pct;
  if (rh < 0.0) rh = 0.0;
  if (rh > 100.0) rh = 100.0;
  const double h = rh * (p_sat / p) * 100.0;

  /* Relaxation frequencies of oxygen and nitrogen. */
  const double frO = pr * (24.0 + 4.04e4 * h * (0.02 + h) / (0.391 + h));
  const double frN = pr * pow(T / T0, -0.5) *
                     (9.0 + 280.0 * h * exp(-4.17 * (pow(T / T0, -1.0 / 3.0) - 1.0)));

  const double term_classical = 1.84e-11 / pr * sqrt(T / T0);
  const double term_O = 0.01275 * exp(-2239.1 / T) / (frO + f * f / frO);
  const double term_N = 0.1068 * exp(-3352.0 / T) / (frN + f * f / frN);

  const double alpha =
      8.686 * f * f * (term_classical + pow(T / T0, -2.5) * (term_O + term_N));
  return (float)alpha;
}

/* ---- helpers ----------------------------------------------------------- */

static float db_to_lin(float db) { return powf(10.0f, db / 20.0f); }

/* One-pole low pass, used for wind and to band-limit broadband noise. */
typedef struct {
  float y;
  float a;
} onepole;

static void onepole_set(onepole *f, float cutoff_hz, float fs) {
  if (cutoff_hz <= 0.0f || fs <= 0.0f) {
    f->a = 1.0f;
  } else {
    const float x = expf(-2.0f * (float)H68_PI * cutoff_hz / fs);
    f->a = x;
  }
  f->y = 0.0f;
}

static float onepole_lp(onepole *f, float x) {
  f->y = (1.0f - f->a) * x + f->a * f->y;
  return f->y;
}

/* Paul Kellet's economy pinking filter: -3 dB/octave to within a few tenths of a
 * dB across the audio band, and cheap enough to run per channel. */
typedef struct {
  float b0, b1, b2, b3, b4, b5, b6;
} pink_state;

static float pink_next(pink_state *s, float white) {
  s->b0 = 0.99886f * s->b0 + white * 0.0555179f;
  s->b1 = 0.99332f * s->b1 + white * 0.0750759f;
  s->b2 = 0.96900f * s->b2 + white * 0.1538520f;
  s->b3 = 0.86650f * s->b3 + white * 0.3104856f;
  s->b4 = 0.55000f * s->b4 + white * 0.5329522f;
  s->b5 = -0.7616f * s->b5 - white * 0.0168980f;
  const float out =
      s->b0 + s->b1 + s->b2 + s->b3 + s->b4 + s->b5 + s->b6 + white * 0.5362f;
  s->b6 = white * 0.115926f;
  return out * 0.11f; /* roughly unit RMS */
}

void h68_synth_defaults_neo2(h68_synth_params *p, float sample_rate,
                             int n_samples) {
  if (!p) return;
  memset(p, 0, sizeof(*p));
  p->sample_rate = sample_rate;
  p->n_samples = n_samples;
  p->edge_mm = 384.0f;
  p->temp_c = 15.0f;
  p->humidity_pct = 60.0f;
  p->pressure_pa = 101325.0f;
  p->air_absorption = 1;

  p->az_deg = 35.0f;
  p->el_deg = 20.0f;
  p->distance_m = 25.0f;

  p->n_rotors = 4;
  p->blades = 2;
  /* A hovering quad trims yaw torque by running the diagonal pairs at slightly
   * different speeds, so the four rates are close but never equal. */
  p->rpm[0] = 26600.0f;
  p->rpm[1] = 27200.0f;
  p->rpm[2] = 26900.0f;
  p->rpm[3] = 27500.0f;
  p->rpm_jitter_pct = 0.4f;
  p->rpm_ramp_pct = 0.0f;
  p->n_harmonics = 9;
  p->harmonic_rolloff_db = 4.5f;
  p->tonal_level_db = -18.0f;

  /* Ducted props trade tonal peaks for broadband hiss, so the broadband part is
   * only a few dB below the fundamental rather than far beneath it. */
  p->broadband_level_db = -24.0f;
  p->broadband_lo_hz = 700.0f;
  p->broadband_hi_hz = 9000.0f;

  p->wind_level_db = -60.0f;
  p->wind_cutoff_hz = 120.0f;
  p->background_level_db = -66.0f;

  p->tone_hz = 0.0f;
  p->tone_level_db = -120.0f;

  p->seed = 1u;
}

h68_status h68_synth_render(const h68_synth_params *p, float *out) {
  if (!p || !out) return H68_ERR_ARG;
  if (p->sample_rate <= 0.0f || p->n_samples <= 0) return H68_ERR_ARG;
  if (p->n_rotors < 0 || p->n_rotors > H68_SYNTH_MAX_ROTORS) return H68_ERR_ARG;
  if (p->blades < 1) return H68_ERR_ARG;

  const int n = p->n_samples;
  const float fs = p->sample_rate;
  const float c = h68_sound_speed(p->temp_c, p->humidity_pct, p->pressure_pa);

  memset(out, 0, sizeof(float) * (size_t)n * (size_t)H68_NCH);

  /* Per-mic propagation delay for a plane wave from (az, el). The far-field
   * threshold at 384 mm and 6 kHz is 5.6 m, so every realistic target is a plane
   * wave and a single delay per mic is exact. */
  float d[3];
  h68_dir_from_angles(p->az_deg, p->el_deg, d);
  float tau_s[H68_NCH];
  for (int m = 0; m < H68_NCH; ++m) {
    float pos[3];
    h68_mic_pos_mm(m, p->edge_mm, pos);
    const float proj_mm = pos[0] * d[0] + pos[1] * d[1] + pos[2] * d[2];
    /* Closer to the source means an earlier arrival, hence the negative sign. */
    tau_s[m] = -(proj_mm * 0.001f) / c;
  }

  const float dist = (p->distance_m > 0.1f) ? p->distance_m : 0.1f;
  /* Spherical spreading referenced to 1 m. */
  const float spread = 1.0f / dist;

  /* ---- tonal part: harmonic combs, one per rotor ---------------------- */
  if (p->n_rotors > 0 && p->n_harmonics > 0) {
    const float base_amp = db_to_lin(p->tonal_level_db) * spread;

    for (int r = 0; r < p->n_rotors; ++r) {
      pcg32 rng;
      pcg_seed(&rng, p->seed, 100u + (unsigned int)r);

      /* Slow random walk on the shaft rate, low-pass filtered so it wanders
       * rather than hisses. */
      onepole wander;
      onepole_set(&wander, 1.5f, fs);

      double phase = 0.0; /* shaft phase in cycles */
      const float rpm0 = p->rpm[r];

      for (int i = 0; i < n; ++i) {
        const float t01 = (n > 1) ? ((float)i / (float)(n - 1)) : 0.0f;
        const float ramp = 1.0f + (p->rpm_ramp_pct * 0.01f) * t01;
        const float wob =
            1.0f + (p->rpm_jitter_pct * 0.01f) * onepole_lp(&wander, pcg_gauss(&rng));
        const float rpm = rpm0 * ramp * wob;
        const float shaft_hz = rpm / 60.0f;

        for (int hh = 1; hh <= p->n_harmonics; ++hh) {
          /* Blade-pass fundamental is shaft rate times blade count; harmonics of
           * that are what form the comb. */
          const float f = shaft_hz * (float)p->blades * (float)hh;
          if (f >= fs * 0.5f) break;

          float amp = base_amp * db_to_lin(-p->harmonic_rolloff_db * (float)(hh - 1));
          if (p->air_absorption) {
            const float a = h68_air_absorption_db_per_m(f, p->temp_c,
                                                        p->humidity_pct,
                                                        p->pressure_pa);
            amp *= db_to_lin(-a * dist);
          }
          if (amp < 1e-9f) continue;

          const double cyc = phase * (double)(p->blades * hh);
          for (int m = 0; m < H68_NCH; ++m) {
            /* s(t - tau) becomes a phase offset of -2*pi*f*tau. Exact for a
             * steady rate and accurate to well under a degree here, since tau is
             * at most 56 us while the rate moves by a fraction of a percent per
             * second. */
            const double ph =
                6.283185307179586 * (cyc - (double)f * (double)tau_s[m]);
            out[(size_t)m * (size_t)n + i] += amp * (float)sin(ph);
          }
        }
        phase += (double)shaft_hz / (double)fs;
        if (phase > 1.0e6) phase -= 1.0e6; /* keep double precision meaningful */
      }
    }
  }

  /* ---- broadband blade noise, delayed per mic ------------------------- */
  if (p->broadband_level_db > -119.0f) {
    /* One source waveform read at six fractional offsets, so the channels share
     * the same noise with the correct relative delays. Without that the broadband
     * part would be incoherent and GCC could only ever lock onto the tonal comb,
     * which would hide exactly the behaviour worth testing.
     *
     * A 256-sample ring is enough for any cube edge: the largest delay is
     * edge/c*fs, about 54 samples at 384 mm, and a fixed offset keeps every read
     * index positive. Streaming this way removes any limit on render length. */
    enum { RING = 256, RING_MASK = RING - 1 };
    float ring[RING];
    memset(ring, 0, sizeof(ring));

    float delay[H68_NCH];
    float max_abs = 0.0f;
    for (int m = 0; m < H68_NCH; ++m) {
      delay[m] = tau_s[m] * fs;
      const float a = fabsf(delay[m]);
      if (a > max_abs) max_abs = a;
    }
    const float offset = ceilf(max_abs) + 2.0f;
    if (offset + max_abs + 3.0f >= (float)RING) return H68_ERR_ARG;

    pcg32 rng;
    pcg_seed(&rng, p->seed, 7u);
    onepole lo, hi;
    onepole_set(&lo, p->broadband_hi_hz, fs);
    onepole_set(&hi, p->broadband_lo_hz, fs);

    float amp = db_to_lin(p->broadband_level_db) * spread;
    if (p->air_absorption) {
      /* Absorption is applied at the band centre; across 700 Hz to 9 kHz the edge
       * error is a couple of dB, acceptable for a fixture whose purpose is
       * geometry rather than absolute level. */
      const float fc = 0.5f * (p->broadband_lo_hz + p->broadband_hi_hz);
      const float a =
          h68_air_absorption_db_per_m(fc, p->temp_c, p->humidity_pct, p->pressure_pa);
      amp *= db_to_lin(-a * dist);
    }

    /* Prime the ring so the first output samples are not a fade-in from silence. */
    int w = 0;
    for (int i = 0; i < RING; ++i) {
      const float white = pcg_gauss(&rng);
      const float lp = onepole_lp(&lo, white);
      ring[w & RING_MASK] = lp - onepole_lp(&hi, lp);
      ++w;
    }

    for (int i = 0; i < n; ++i) {
      const float white = pcg_gauss(&rng);
      const float lp = onepole_lp(&lo, white);
      /* Band pass as the difference of two low passes. */
      ring[w & RING_MASK] = lp - onepole_lp(&hi, lp);
      ++w;

      for (int m = 0; m < H68_NCH; ++m) {
        const float back = offset + delay[m];
        const int ib = (int)floorf(back);
        const float fr = back - (float)ib;
        /* Catmull-Rom over four taps; smooth enough not to colour the band. */
        const int base = w - 1 - ib;
        const float ym1 = ring[(base + 1) & RING_MASK];
        const float y0 = ring[base & RING_MASK];
        const float y1 = ring[(base - 1) & RING_MASK];
        const float y2 = ring[(base - 2) & RING_MASK];
        const float a0 = y0;
        const float a1 = 0.5f * (y1 - ym1);
        const float a2 = ym1 - 2.5f * y0 + 2.0f * y1 - 0.5f * y2;
        const float a3 = 0.5f * (y2 - ym1) + 1.5f * (y0 - y1);
        const float v = a0 + fr * (a1 + fr * (a2 + fr * a3));
        out[(size_t)m * (size_t)n + i] += amp * v;
      }
    }
  }

  /* ---- pure tone, for aliasing demonstrations ------------------------- */
  if (p->tone_hz > 0.0f && p->tone_level_db > -119.0f) {
    const float amp = db_to_lin(p->tone_level_db);
    const float f = p->tone_hz;
    for (int m = 0; m < H68_NCH; ++m) {
      for (int i = 0; i < n; ++i) {
        const double ph = 6.283185307179586 *
                          ((double)f * ((double)i / (double)fs - (double)tau_s[m]));
        out[(size_t)m * (size_t)n + i] += amp * (float)sin(ph);
      }
    }
  }

  /* ---- site noise: independent per channel ---------------------------- */
  for (int m = 0; m < H68_NCH; ++m) {
    pcg32 rng;
    pcg_seed(&rng, p->seed, 200u + (unsigned int)m);
    onepole wind;
    onepole_set(&wind, p->wind_cutoff_hz, fs);
    pink_state pink;
    memset(&pink, 0, sizeof(pink));

    const float wind_amp = (p->wind_level_db > -119.0f)
                               ? db_to_lin(p->wind_level_db) * 3.0f
                               : 0.0f;
    const float bg_amp = (p->background_level_db > -119.0f)
                             ? db_to_lin(p->background_level_db)
                             : 0.0f;

    float *ch = out + (size_t)m * (size_t)n;
    for (int i = 0; i < n; ++i) {
      float v = 0.0f;
      if (wind_amp > 0.0f) {
        /* Wind noise is turbulence at the diaphragm, uncorrelated between mics
         * even though they are 27 cm apart. That is why it defeats spatial
         * processing and has to be modelled as independent. */
        v += wind_amp * onepole_lp(&wind, pcg_gauss(&rng));
      }
      if (bg_amp > 0.0f) {
        v += bg_amp * pink_next(&pink, pcg_gauss(&rng));
      }
      ch[i] += v;
    }
  }

  return H68_OK;
}
