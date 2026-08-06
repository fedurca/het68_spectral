/*
 * Native tests for the DSP core.
 *
 * These run on the host with clang, not through wasm, for two reasons: failures
 * are debuggable, and the same source later has to build for arm-none-eabi, so a
 * plain C test is the thing that will still work then. The checks that matter are
 * the end-to-end ones: render a scene from a known direction and confirm GCC-PHAT
 * returns the lag geometry predicts, because that is the only way to tell a bug in
 * the code from a bug in the data once real recordings arrive.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "h68_bands.h"
#include "h68_geometry.h"
#include "h68_harmonic.h"
#include "h68_health.h"
#include "h68_pairs.h"
#include "h68_signature.h"
#include "h68_stft.h"
#include "h68_synth.h"
#include "h68_window.h"

static int g_fail;
static int g_checks;

static void check(int cond, const char *what) {
  ++g_checks;
  if (!cond) {
    ++g_fail;
    printf("  FAIL %s\n", what);
  }
}

static void check_near(double got, double want, double tol, const char *what) {
  ++g_checks;
  if (!(fabs(got - want) <= tol)) {
    ++g_fail;
    printf("  FAIL %s: got %.6f want %.6f (tol %.6f)\n", what, got, want, tol);
  }
}

/* ---------------------------------------------------------------- geometry */

static void test_geometry(void) {
  printf("geometry\n");

  /* The six directions are cube face normals, so every pair is either orthogonal
   * or antipodal. If this breaks, every azimuth the array reports is wrong. */
  for (int i = 0; i < H68_NCH; ++i) {
    double norm = 0.0;
    for (int k = 0; k < 3; ++k) norm += H68_MIC_DIR[i][k] * H68_MIC_DIR[i][k];
    check_near(norm, 1.0, 1e-6, "mic direction is a unit vector");
    for (int j = i + 1; j < H68_NCH; ++j) {
      double dot = 0.0;
      for (int k = 0; k < 3; ++k) dot += H68_MIC_DIR[i][k] * H68_MIC_DIR[j][k];
      const int opposite = h68_pair_is_opposite(i, j);
      check_near(dot, opposite ? -1.0 : 0.0, 1e-6,
                 "pair is orthogonal or antipodal");
    }
  }

  /* Two baseline families only: 3 long, 12 short. */
  int n_long = 0, n_short = 0;
  const float edge = 384.0f;
  for (int p = 0; p < H68_NPAIRS; ++p) {
    const float b = h68_baseline_mm(H68_PAIR_I[p], H68_PAIR_J[p], edge);
    if (fabsf(b - edge) < 0.01f) {
      ++n_long;
    } else if (fabsf(b - edge / sqrtf(2.0f)) < 0.01f) {
      ++n_short;
    }
  }
  check(n_long == 3, "3 opposite pairs at the full edge");
  check(n_short == 12, "12 adjacent pairs at edge/sqrt(2)");

  /* The numbers the plan quotes for the chosen 384 mm edge. */
  check(h68_firmware_maxlag(384.0f, 48000.0f) == 64, "firmware maxlag is 64");
  check(h68_firmware_span(384.0f, 48000.0f, 256) == 80, "coherent span is 80");
  check(h68_firmware_maxlag(512.0f, 48000.0f) == 84, "512 mm maxlag is 84");
  check(h68_firmware_span(512.0f, 48000.0f, 256) == 40, "512 mm span is 40");

  check_near(h68_grating_hz(384.0f, 343.0f), 446.6, 1.0, "grating at 384 mm");
  check_near(h68_angular_resolution_deg(384.0f, 343.0f, 48000.0f), 1.07, 0.02,
             "angular resolution at 384 mm");
  check_near(h68_lag_quantum_mm(343.0f, 48000.0f), 7.146, 0.01,
             "one lag sample in mm");
  check_near(h68_far_field_m(400.0f, 6000.0f, 343.0f), 5.6, 0.05,
             "far field at 400 mm and 6 kHz");

  /* Sound speed: 20 C dry air is the textbook 343 m/s, and humidity raises it. */
  check_near(h68_sound_speed(20.0f, 0.0f, 101325.0f), 343.2, 0.5,
             "sound speed at 20 C dry");
  check(h68_sound_speed(20.0f, 90.0f, 101325.0f) >
            h68_sound_speed(20.0f, 0.0f, 101325.0f),
        "humid air is faster");

  /* A source on mic 1's axis must be closest to mic 1 and furthest from mic 5. */
  const float lag = h68_expected_lag_samples(0, 4, 0.0f, 35.264f, 384.0f, 343.0f,
                                             48000.0f);
  check(lag > 50.0f && lag < 56.0f, "on-axis lag approaches edge/c");
}

/* ----------------------------------------------------------------- windows */

static void test_windows(void) {
  printf("windows\n");
  static float w[4096];
  float cg, enbw, nenbw, scallop, sidelobe;

  h68_window_fill(w, 1024, H68_WIN_RECT, 0.0f);
  h68_window_metrics(w, 1024, &cg, &enbw, &nenbw, &scallop, &sidelobe);
  check_near(cg, 1.0, 1e-5, "rect coherent gain");
  check_near(enbw, 1.0, 1e-4, "rect ENBW is 1 bin");
  check_near(scallop, -3.92, 0.05, "rect scalloping loss");
  check_near(sidelobe, -13.26, 0.4, "rect highest sidelobe");

  h68_window_fill(w, 1024, H68_WIN_HANN, 0.0f);
  h68_window_metrics(w, 1024, &cg, &enbw, &nenbw, &scallop, &sidelobe);
  check_near(cg, 0.5, 1e-3, "hann coherent gain");
  check_near(enbw, 1.5, 1e-3, "hann ENBW is 1.5 bins");
  check_near(scallop, -1.42, 0.05, "hann scalloping loss");
  check_near(sidelobe, -31.5, 1.5, "hann highest sidelobe");

  h68_window_fill(w, 1024, H68_WIN_HAMMING, 0.0f);
  h68_window_metrics(w, 1024, &cg, &enbw, &nenbw, &scallop, &sidelobe);
  check_near(cg, 0.54, 1e-3, "hamming coherent gain");
  check_near(enbw, 1.363, 5e-3, "hamming ENBW");

  h68_window_fill(w, 1024, H68_WIN_BLACKMAN_HARRIS, 0.0f);
  h68_window_metrics(w, 1024, &cg, &enbw, &nenbw, &scallop, &sidelobe);
  check(sidelobe < -85.0f, "blackman-harris sidelobes below -85 dB");
  check_near(enbw, 2.004, 0.02, "blackman-harris ENBW");
}

/* -------------------------------------------------------------------- STFT */

static void test_stft(void) {
  printf("stft\n");
  const float fs = 48000.0f;
  const int n = 16384;
  static float x[16384];
  static float db[64 * 8193];

  /* A full-scale sine on an exact bin centre must read 0 dBFS whatever the
   * transform size, otherwise a threshold tuned at one FFT size means something
   * different at another. */
  const int sizes[] = {1024, 4096, 8192};
  for (int s = 0; s < 3; ++s) {
    const int nfft = sizes[s];
    const int k0 = nfft / 8;
    const float f0 = (float)k0 * fs / (float)nfft;
    for (int i = 0; i < n; ++i) {
      x[i] = sinf(2.0f * (float)H68_PI * f0 * (float)i / fs);
    }
    check(h68_stft_configure(nfft, nfft, nfft / 2, H68_WIN_HANN, 0.0f, fs) ==
              H68_OK,
          "configure");
    const int bins = h68_stft_bins();
    const int frames = h68_stft_frame_count(n);
    check(frames > 0 && bins == nfft / 2 + 1, "frame and bin counts");
    check(h68_stft_analyze(x, n, -160.0f, db, NULL) == H68_OK, "analyze");
    char msg[96];
    snprintf(msg, sizeof(msg), "full-scale sine reads 0 dBFS at nfft=%d", nfft);
    check_near(db[bins + k0], 0.0, 0.05, msg);
  }

  /* Metrics track the configuration. */
  check(h68_stft_configure(4096, 4096, 1024, H68_WIN_HANN, 0.0f, fs) == H68_OK,
        "configure for metrics");
  const h68_stft_metrics *m = h68_stft_metrics_get();
  check(m != NULL, "metrics available");
  check_near(m->bin_hz, 11.71875, 1e-4, "bin width at 4096");
  check_near(m->window_ms, 85.333, 0.01, "window length in ms");
  check_near(m->overlap, 0.75, 1e-6, "overlap fraction");
}

/* ------------------------------------------------- synthesis and GCC-PHAT */

/* The central claim of the whole design: at a 384 mm edge the entire drone band
 * sits above the grating frequency, so a single tone is ambiguous, but broadband
 * content resolves the delay correctly. Both halves are checked. */
static void test_gcc_against_truth(void) {
  printf("gcc-phat against known truth\n");

  const float fs = 48000.0f;
  const int n = 24000; /* 0.5 s */
  static float audio[H68_NCH * 24000];

  h68_synth_params p;
  h68_synth_defaults_neo2(&p, fs, n);
  p.edge_mm = 384.0f;
  p.az_deg = 35.0f;
  p.el_deg = 20.0f;
  p.distance_m = 20.0f;
  p.wind_level_db = -120.0f;
  p.background_level_db = -120.0f;
  check(h68_synth_render(&p, audio) == H68_OK, "render scene");

  const float c = h68_sound_speed(p.temp_c, p.humidity_pct, p.pressure_pa);
  const int block = 8192;
  const int nfft = 16384;
  const int max_lag = 70;
  static float corr[2 * 70 + 1];

  int agree = 0;
  double worst = 0.0;
  for (int pr = 0; pr < H68_NPAIRS; ++pr) {
    const int i = H68_PAIR_I[pr], j = H68_PAIR_J[pr];
    const float want = h68_expected_lag_samples(i, j, p.az_deg, p.el_deg,
                                                p.edge_mm, c, fs);
    h68_gcc_result r;
    const h68_status st = h68_gcc_column(
        audio + (size_t)i * (size_t)n, audio + (size_t)j * (size_t)n, block,
        nfft, 1, max_lag, 700.0f, 9000.0f, fs, corr, &r);
    check(st == H68_OK, "gcc column runs");
    const double err = fabs((double)r.peak_lag - (double)want);
    if (err > worst) worst = err;
    if (err <= 1.0) ++agree;
  }
  printf("  broadband: %d/%d pairs within 1 sample, worst error %.2f samples\n",
         agree, H68_NPAIRS, worst);
  check(agree == H68_NPAIRS, "broadband GCC-PHAT recovers every pair's lag");

  /* Now a single tone well above the grating frequency of both baseline families
   * (447 Hz long, 632 Hz short). The competing peak should be comparable to the
   * true one, which is what makes single-harmonic DOA unusable here. */
  h68_synth_params t;
  h68_synth_defaults_neo2(&t, fs, n);
  t.edge_mm = 384.0f;
  t.az_deg = 35.0f;
  t.el_deg = 20.0f;
  t.n_rotors = 0;
  t.broadband_level_db = -120.0f;
  t.wind_level_db = -120.0f;
  t.background_level_db = -120.0f;
  t.tone_hz = 3000.0f;
  t.tone_level_db = -6.0f;
  t.air_absorption = 0;
  check(h68_synth_render(&t, audio) == H68_OK, "render single tone");

  int ambiguous = 0;
  for (int pr = 0; pr < H68_NPAIRS; ++pr) {
    const int i = H68_PAIR_I[pr], j = H68_PAIR_J[pr];
    h68_gcc_result r;
    h68_gcc_column(audio + (size_t)i * (size_t)n, audio + (size_t)j * (size_t)n,
                   block, nfft, 1, max_lag, 2800.0f, 3200.0f, fs, corr, &r);
    /* A competitor within 3 dB of the peak means the lag is not determined. */
    if (r.peak_ratio < 1.42f) ++ambiguous;
  }
  printf("  single 3 kHz tone: %d/%d pairs ambiguous\n", ambiguous, H68_NPAIRS);
  check(ambiguous >= 12, "a single tone above grating is ambiguous on most pairs");
}

/* --------------------------------------------------------- harmonic search */

static void test_f0(void) {
  printf("f0 and rpm\n");
  const float fs = 48000.0f;
  const int n = 48000;
  static float audio[H68_NCH * 48000];
  static float mag[8193];

  h68_synth_params p;
  h68_synth_defaults_neo2(&p, fs, n);
  /* One rotor, so there is a single unambiguous answer to check against. */
  p.n_rotors = 1;
  p.rpm[0] = 27000.0f;
  p.rpm_jitter_pct = 0.0f;
  p.broadband_level_db = -40.0f;
  p.wind_level_db = -120.0f;
  p.background_level_db = -70.0f;
  p.distance_m = 10.0f;
  check(h68_synth_render(&p, audio) == H68_OK, "render single rotor");

  const float want_f0 = 27000.0f / 60.0f * 2.0f; /* 900 Hz */

  check(h68_stft_configure(8192, 8192, 4096, H68_WIN_HANN, 0.0f, fs) == H68_OK,
        "configure 8192");
  const int bins = h68_stft_bins();
  check(h68_stft_frame_complex(audio, NULL, NULL) == H68_OK, "frame runs");

  /* Build a linear magnitude spectrum for the first frame. */
  static float re[8193], im[8193];
  h68_stft_frame_complex(audio, re, im);
  for (int k = 0; k < bins; ++k) {
    mag[k] = sqrtf(re[k] * re[k] + im[k] * im[k]);
  }

  h68_f0_candidate c[H68_MAX_F0_CANDIDATES];
  int nc = 0;
  const float bin_hz = fs / 8192.0f;
  check(h68_f0_candidates(mag, bins, bin_hz, 500.0f, 1400.0f, 9, 2, c,
                          H68_MAX_F0_CANDIDATES, &nc) == H68_OK,
        "f0 search runs");
  check(nc > 0, "at least one candidate");
  if (nc > 0) {
    printf("  best f0 %.1f Hz (want %.1f), rpm %.0f, hnr %.1f dB, %d harmonics\n",
           c[0].f0_hz, want_f0, c[0].rpm, c[0].hnr_db, c[0].n_harmonics);
    check_near(c[0].f0_hz, want_f0, 2.0 * bin_hz, "f0 within two bins");
    check_near(c[0].rpm, 27000.0, 400.0, "rpm reads back correctly");
    check(c[0].hnr_db > 0.0f, "tonal signal has positive HNR");
  }

  /* Four rotors a few percent apart: the comb salience has to separate them, which
   * only works because the peak narrows with harmonic count. */
  h68_synth_params q;
  h68_synth_defaults_neo2(&q, fs, n);
  q.rpm_jitter_pct = 0.0f;
  q.broadband_level_db = -50.0f;
  q.wind_level_db = -120.0f;
  q.background_level_db = -80.0f;
  q.distance_m = 10.0f;
  check(h68_synth_render(&q, audio) == H68_OK, "render four rotors");
  h68_stft_frame_complex(audio, re, im);
  for (int k = 0; k < bins; ++k) mag[k] = sqrtf(re[k] * re[k] + im[k] * im[k]);
  nc = 0;
  h68_f0_candidates(mag, bins, bin_hz, 500.0f, 1400.0f, 9, 2, c,
                    H68_MAX_F0_CANDIDATES, &nc);
  printf("  four rotors -> %d candidates:", nc);
  for (int i = 0; i < nc && i < 6; ++i) printf(" %.0f", c[i].f0_hz);
  printf(" Hz\n");
  check(nc >= 2, "multiple rotors produce multiple candidates");
}

/* ------------------------------------------------------ health and mapping */

static void test_health(void) {
  printf("health\n");
  const int n = 48000;
  static float planar[H68_NCH * 48000];
  memset(planar, 0, sizeof(planar));

  /* Channel 0 normal, channel 1 dead, channel 2 clipped, channel 3 with DC. */
  for (int i = 0; i < n; ++i) {
    planar[i] = 0.2f * sinf(2.0f * (float)H68_PI * 1000.0f * (float)i / 48000.0f);
    planar[(size_t)1 * n + i] = 0.0f;
    planar[(size_t)2 * n + i] = (i % 2) ? 1.0f : -1.0f;
    planar[(size_t)3 * n + i] = 0.3f + 0.01f * sinf((float)i * 0.01f);
  }

  h68_channel_stats s;
  h68_channel_stats_compute(planar, n, 0.999f, &s);
  check_near(s.rms, 0.2f / sqrtf(2.0f), 1e-3, "rms of a sine");
  check(!s.dead && !s.saturated, "normal channel is healthy");

  h68_channel_stats_compute(planar + n, n, 0.999f, &s);
  check(s.dead, "silent channel flagged dead");

  h68_channel_stats_compute(planar + 2 * (size_t)n, n, 0.999f, &s);
  check(s.saturated, "full-scale square flagged saturated");

  h68_channel_stats_compute(planar + 3 * (size_t)n, n, 0.999f, &s);
  check_near(s.dc, 0.3, 0.01, "DC offset measured");
  check(s.dead == 0, "a channel with DC and signal is not dead");

  /* Mapping probe: a 1 kHz burst that moves between channels every 100 ms is how
   * the LR-flip file exposes a channel swap. */
  memset(planar, 0, sizeof(planar));
  const int slot = 4800;             /* 100 ms */
  const int n_slots = n / slot;      /* the probe uses the same channel stride */
  for (int s2 = 0; s2 < n_slots; ++s2) {
    const int ch = s2 % H68_NCH;
    for (int i = 0; i < slot; ++i) {
      const int idx = s2 * slot + i;
      planar[(size_t)ch * n + idx] =
          0.45f * sinf(2.0f * (float)H68_PI * 1000.0f * (float)idx / 48000.0f);
    }
  }
  int active[16];
  float margin[16];
  int slots = 0;
  check(h68_mapping_probe(planar, H68_NCH, n, 48000.0f, 1000.0f, 100.0f, active,
                          margin, 16, &slots) == H68_OK,
        "mapping probe runs");
  check(slots == n_slots, "all slots found");
  int correct = 0;
  for (int i = 0; i < slots; ++i) {
    if (active[i] == i % H68_NCH) ++correct;
  }
  check(correct == slots, "every slot maps to the right channel");
}

/* ---------------------------------------------------------- determinism */

static void test_determinism(void) {
  printf("determinism\n");
  const float fs = 48000.0f;
  const int n = 4800;
  static float a[H68_NCH * 4800];
  static float b[H68_NCH * 4800];

  h68_synth_params p;
  h68_synth_defaults_neo2(&p, fs, n);
  p.seed = 12345u;
  h68_synth_render(&p, a);
  h68_synth_render(&p, b);
  check(memcmp(a, b, sizeof(a)) == 0, "same seed gives identical samples");

  p.seed = 12346u;
  h68_synth_render(&p, b);
  check(memcmp(a, b, sizeof(a)) != 0, "a different seed changes the noise");
}

/* --------------------------------------------------------- signatures */

static void test_signature(void) {
  printf("signatures\n");
  const float fs = 48000.0f;
  const int n = 48000;
  static float audio[H68_NCH * 48000];
  static float mag[64 * 4097];

  const float bands[5] = {300.0f, 800.0f, 2000.0f, 6000.0f, 12000.0f};

  h68_synth_params p;
  h68_synth_defaults_neo2(&p, fs, n);
  p.distance_m = 15.0f;
  h68_synth_render(&p, audio);

  check(h68_stft_configure(4096, 4096, 2048, H68_WIN_HANN, 0.0f, fs) == H68_OK,
        "configure 4096");
  const int bins = h68_stft_bins();
  const int frames = h68_stft_frame_count(n);
  const float bin_hz = fs / 4096.0f;

  /* Linear magnitudes, frame by frame. */
  for (int f = 0; f < frames; ++f) {
    static float re[4097], im[4097];
    h68_stft_frame_complex(audio + (size_t)f * 2048u, re, im);
    float *row = mag + (size_t)f * (size_t)bins;
    for (int k = 0; k < bins; ++k) row[k] = sqrtf(re[k] * re[k] + im[k] * im[k]);
  }

  h68_signature sig;
  check(h68_signature_extract(mag, frames, bins, bin_hz, 500.0f, 1400.0f, 9, 2,
                              bands, 4, &sig) == H68_OK,
        "signature extraction runs");
  printf("  template from %d/%d frames, hnr %.1f dB, drift %.2f%%, %d combs\n",
         sig.n_frames, frames, sig.hnr_db, sig.f0_drift_pct, sig.n_combs);
  check(sig.n_frames > 0, "template used at least one frame");
  check(sig.f0_gate_lo_hz > 0.0f && sig.f0_gate_hi_hz > sig.f0_gate_lo_hz,
        "gate is a valid range");

  /* The template must match the material it came from. */
  float f0 = 0.0f;
  const float self_score =
      h68_signature_match(&sig, mag + (size_t)(frames / 2) * (size_t)bins, bins,
                          bin_hz, bands, &f0);
  printf("  self match score %.3f at f0 %.0f Hz\n", self_score, f0);
  check(self_score > 0.5f, "template matches its own source material");

  /* A template is invariant to absolute rotor speed by construction: the same
   * airframe 10 percent faster, which is what fitting the 32 g RID module does,
   * must still look like the same machine. */
  h68_synth_params fast = p;
  for (int i = 0; i < H68_SYNTH_MAX_ROTORS; ++i) fast.rpm[i] = p.rpm[i] * 1.10f;
  h68_synth_render(&fast, audio);
  for (int f = 0; f < frames; ++f) {
    static float re[4097], im[4097];
    h68_stft_frame_complex(audio + (size_t)f * 2048u, re, im);
    float *row = mag + (size_t)f * (size_t)bins;
    for (int k = 0; k < bins; ++k) row[k] = sqrtf(re[k] * re[k] + im[k] * im[k]);
  }
  h68_signature sig_fast;
  h68_signature_extract(mag, frames, bins, bin_hz, 500.0f, 1600.0f, 9, 2, bands,
                        4, &sig_fast);
  const float d = h68_signature_distance(&sig, &sig_fast);
  printf("  distance to the same airframe 10%% faster: %.3f\n", d);
  check(sig_fast.n_frames > 0, "faster variant also produced a template");
  /* Measured at 0.34, so a limit of 1.0 leaves headroom while still catching any
   * regression that reintroduces a dependence on absolute rotor speed. */
  check(d < 1.0f, "a 10 percent speed shift stays recognisable");
}

/* ------------------------------------------------------------------ bands */

static void test_bands(void) {
  printf("watched bands\n");

  const float fs = 48000.0f;
  const int n = 48000;
  static float x[48000];
  static float mag[H68_MAX_BINS];

  /* A full-scale 1 kHz tone plus a little noise everywhere else. The tone band must
   * read close to 0 dBFS and must be far more tonal than a band containing only the
   * noise; that contrast is the whole basis of the tonality readout. */
  unsigned int rng = 12345u;
  for (int i = 0; i < n; ++i) {
    rng = rng * 1664525u + 1013904223u;
    const float noise = ((float)(rng >> 8) / 8388608.0f - 1.0f) * 0.001f;
    x[i] = sinf(2.0f * (float)H68_PI * 1000.0f * (float)i / fs) + noise;
  }

  check(h68_stft_configure(4096, 4096, 1024, H68_WIN_HANN, 0.0f, fs) == H68_OK,
        "configure for bands");
  const int bins = h68_stft_bins();
  const h68_stft_metrics *m = h68_stft_metrics_get();
  check(h68_stft_frame_magnitude(x, mag) == H68_OK, "frame magnitude");

  /* The same frame through the dB path must agree, since a band threshold read off
   * the spectrogram has to mean the same as one computed here. */
  static float db[8193];
  check(h68_stft_analyze(x, 4096, -200.0f, db, NULL) == H68_OK, "analyze one frame");
  const int k1k = (int)(1000.0f / m->bin_hz + 0.5f);
  check_near(20.0 * log10(mag[k1k]), db[k1k], 0.01,
             "frame magnitude matches the dB path");

  const h68_band_frame tone =
      h68_band_frame_metrics(mag, bins, m->bin_hz, 900.0f, 1100.0f);
  const h68_band_frame quiet =
      h68_band_frame_metrics(mag, bins, m->bin_hz, 4000.0f, 6000.0f);

  check_near(tone.peak_hz, 1000.0, m->bin_hz, "band peak lands on the tone");
  check(tone.peak_db > -1.0f && tone.peak_db < 0.5f,
        "full-scale tone peaks at 0 dBFS in its band");
  check(tone.energy_db > quiet.energy_db + 40.0f,
        "tone band is far louder than an empty one");
  check(tone.tonality_db > quiet.tonality_db + 10.0f,
        "tone band is far more tonal than a noise band");

  /* A band narrower than one bin still reports something rather than nothing. */
  const h68_band_frame narrow =
      h68_band_frame_metrics(mag, bins, m->bin_hz, 1000.0f, 1001.0f);
  check(narrow.energy_db > -200.0f, "sub-bin band collapses to one bin");

  /* The histogram percentile has to behave like a quantile on a known ramp. */
  static float series[1000];
  for (int i = 0; i < 1000; ++i) series[i] = -100.0f + (float)i * 0.1f;
  check_near(h68_db_percentile(series, 1000, 0.0f), -100.0f, 0.3,
             "0th percentile");
  check_near(h68_db_percentile(series, 1000, 0.5f), -50.0f, 0.3, "median");
  check_near(h68_db_percentile(series, 1000, 1.0f), -0.1f, 0.3,
             "100th percentile");
}

int main(void) {
  test_geometry();
  test_windows();
  test_stft();
  test_bands();
  test_gcc_against_truth();
  test_f0();
  test_health();
  test_determinism();
  test_signature();

  printf("\n%d checks, %d failures\n", g_checks, g_fail);
  return g_fail ? 1 : 0;
}
