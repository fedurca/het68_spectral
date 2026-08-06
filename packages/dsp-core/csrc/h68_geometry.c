#include "h68_geometry.h"

#include <math.h>

/* sin(35.26439 deg) = 1/sqrt(3), cos = sqrt(2/3). */
#define H68_SIN_EL 0.5773502691896258f
#define H68_COS_EL 0.8164965809277260f
#define H68_HALF_COS 0.4082482904638630f /* COS_EL * cos(60 deg) */
#define H68_SIN60_COS 0.7071067811865476f /* COS_EL * sin(60 deg) */

const float H68_MIC_DIR[H68_NCH][3] = {
    /* mic 1: az   0, el +35.26 */ {H68_COS_EL, 0.0f, H68_SIN_EL},
    /* mic 2: az 120, el +35.26 */ {-H68_HALF_COS, H68_SIN60_COS, H68_SIN_EL},
    /* mic 3: az 240, el +35.26 */ {-H68_HALF_COS, -H68_SIN60_COS, H68_SIN_EL},
    /* mic 4: az  60, el -35.26 */ {H68_HALF_COS, H68_SIN60_COS, -H68_SIN_EL},
    /* mic 5: az 180, el -35.26 */ {-H68_COS_EL, 0.0f, -H68_SIN_EL},
    /* mic 6: az 300, el -35.26 */ {H68_HALF_COS, -H68_SIN60_COS, -H68_SIN_EL},
};

const int H68_PAIR_I[H68_NPAIRS] = {0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3, 4};
const int H68_PAIR_J[H68_NPAIRS] = {1, 2, 3, 4, 5, 2, 3, 4, 5, 3, 4, 5, 4, 5, 5};

void h68_mic_pos_mm(int mic, float edge_mm, float out_xyz[3]) {
  if (mic < 0 || mic >= H68_NCH) {
    out_xyz[0] = out_xyz[1] = out_xyz[2] = 0.0f;
    return;
  }
  const float r = edge_mm * 0.5f;
  out_xyz[0] = H68_MIC_DIR[mic][0] * r;
  out_xyz[1] = H68_MIC_DIR[mic][1] * r;
  out_xyz[2] = H68_MIC_DIR[mic][2] * r;
}

float h68_baseline_mm(int i, int j, float edge_mm) {
  float pi[3], pj[3];
  h68_mic_pos_mm(i, edge_mm, pi);
  h68_mic_pos_mm(j, edge_mm, pj);
  const float dx = pi[0] - pj[0];
  const float dy = pi[1] - pj[1];
  const float dz = pi[2] - pj[2];
  return sqrtf(dx * dx + dy * dy + dz * dz);
}

int h68_pair_is_opposite(int i, int j) {
  /* Antipodal cube face normals: (0,4), (1,5), (2,3). */
  const int a = i < j ? i : j;
  const int b = i < j ? j : i;
  return (a == 0 && b == 4) || (a == 1 && b == 5) || (a == 2 && b == 3);
}

void h68_dir_from_angles(float az_deg, float el_deg, float out_xyz[3]) {
  const float az = az_deg * (float)H68_PI / 180.0f;
  const float el = el_deg * (float)H68_PI / 180.0f;
  const float ce = cosf(el);
  out_xyz[0] = ce * cosf(az);
  out_xyz[1] = ce * sinf(az);
  out_xyz[2] = sinf(el);
}

float h68_expected_lag_samples(int i, int j, float az_deg, float el_deg,
                               float edge_mm, float c_mps, float sample_rate) {
  float pi[3], pj[3], d[3];
  h68_mic_pos_mm(i, edge_mm, pi);
  h68_mic_pos_mm(j, edge_mm, pj);
  h68_dir_from_angles(az_deg, el_deg, d);
  /* Cross-correlating x_i against x_j peaks at tau = t_j - t_i, and with
   * t_k = (R - p_k . d)/c that reduces to (p_i - p_j) . d / c. */
  const float proj_mm =
      (pi[0] - pj[0]) * d[0] + (pi[1] - pj[1]) * d[1] + (pi[2] - pj[2]) * d[2];
  return (proj_mm * 0.001f / c_mps) * sample_rate;
}

float h68_grating_hz(float baseline_mm, float c_mps) {
  if (baseline_mm <= 0.0f) return 0.0f;
  return c_mps / (2.0f * baseline_mm * 0.001f);
}

float h68_lag_quantum_mm(float c_mps, float sample_rate) {
  if (sample_rate <= 0.0f) return 0.0f;
  return c_mps / sample_rate * 1000.0f;
}

int h68_firmware_maxlag(float edge_mm, float sample_rate) {
  const float raw = edge_mm * sample_rate / (H68_C_COLD_EXTREME * 1000.0f);
  return (int)ceilf(raw) + 2;
}

int h68_firmware_span(float edge_mm, float sample_rate, int doa_n) {
  const int span = doa_n - 2 * h68_firmware_maxlag(edge_mm, sample_rate) - 48;
  return span > 0 ? span : 0;
}

float h68_angular_resolution_deg(float edge_mm, float c_mps,
                                 float sample_rate) {
  const float b_m = edge_mm * 0.001f;
  if (b_m <= 0.0f || sample_rate <= 0.0f) return 0.0f;
  float ratio = c_mps / (sample_rate * b_m);
  if (ratio > 1.0f) ratio = 1.0f;
  return asinf(ratio) * 180.0f / (float)H68_PI;
}

float h68_far_field_m(float edge_mm, float freq_hz, float c_mps) {
  if (freq_hz <= 0.0f) return 0.0f;
  const float d_m = edge_mm * 0.001f;
  const float lambda = c_mps / freq_hz;
  return 2.0f * d_m * d_m / lambda;
}

float h68_sound_speed(float temp_c, float humidity_pct, float pressure_pa) {
  /* Physical model rather than a fitted polynomial: water vapour lowers the mean
   * molar mass of the mixture and its adiabatic index, both of which raise c.
   * Accurate to a few cm/s across the range the cube will ever see, and it makes
   * the pressure dependence explicit instead of hiding it in coefficients. */
  const double T = (double)temp_c + 273.15;
  if (T <= 0.0) return H68_C_REF;

  /* Magnus saturation vapour pressure over water, Pa. */
  const double p_sat =
      610.94 * exp(17.625 * (double)temp_c / ((double)temp_c + 243.04));
  double p = (double)pressure_pa;
  if (p <= 0.0) p = 101325.0;
  double rh = (double)humidity_pct;
  if (rh < 0.0) rh = 0.0;
  if (rh > 100.0) rh = 100.0;

  /* Mole fraction of water vapour. */
  double x_w = (rh / 100.0) * p_sat / p;
  if (x_w < 0.0) x_w = 0.0;
  if (x_w > 1.0) x_w = 1.0;

  const double M_dry = 0.0289645;  /* kg/mol */
  const double M_h2o = 0.01801528; /* kg/mol */
  const double R = 8.31446261815324;

  const double M_mix = (1.0 - x_w) * M_dry + x_w * M_h2o;
  const double gamma_mix = (1.0 - x_w) * 1.4 + x_w * 1.33;

  return (float)sqrt(gamma_mix * R * T / M_mix);
}
