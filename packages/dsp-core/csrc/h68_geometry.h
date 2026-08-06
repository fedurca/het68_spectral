/*
 * Detection cube geometry.
 *
 * The cube stands on a vertex, so its body diagonal is vertical and the six face
 * normals split into two groups of three: mics 1-3 at elevation +35.264 deg with
 * azimuths 0/120/240, mics 4-6 at -35.264 deg with azimuths interleaved at
 * 60/180/300. Azimuth 0 is +X and points at mic 1; +Z is up. Channel n of the
 * WAV is mic n with no permutation.
 *
 * The six directions are mutually orthogonal or antipodal because they are cube
 * face normals, which gives exactly two baseline lengths:
 *   - 3 opposite pairs  (1-5, 2-6, 3-4) at `edge`
 *   - 12 adjacent pairs at `edge / sqrt(2)`
 * Those two families alias at different frequencies and must be evaluated
 * separately.
 */
#ifndef H68_GEOMETRY_H
#define H68_GEOMETRY_H

#include "h68_dsp.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Unit face normals in world coordinates, mic index 0..5. */
extern const float H68_MIC_DIR[H68_NCH][3];

/* Pair tables: H68_PAIR_I[p], H68_PAIR_J[p] for p in 0..14, ordered
 * (0,1),(0,2)...(0,5),(1,2)...(4,5). */
extern const int H68_PAIR_I[H68_NPAIRS];
extern const int H68_PAIR_J[H68_NPAIRS];

/* Microphone position in millimetres for a given edge length. */
void h68_mic_pos_mm(int mic, float edge_mm, float out_xyz[3]);

/* Baseline length in millimetres between two mics. */
float h68_baseline_mm(int i, int j, float edge_mm);

/* True when the pair is one of the three antipodal (long baseline) pairs. */
int h68_pair_is_opposite(int i, int j);

/* Unit vector pointing from the array towards a source at (az, el), degrees. */
void h68_dir_from_angles(float az_deg, float el_deg, float out_xyz[3]);

/* Expected TDOA for a plane wave from (az, el), expressed as the lag in samples
 * at which cross-correlating channel i against channel j peaks. Positive lag
 * means channel j is delayed relative to channel i. */
float h68_expected_lag_samples(int i, int j, float az_deg, float el_deg,
                               float edge_mm, float c_mps, float sample_rate);

/* Spatial aliasing onset for a baseline: above c/(2*b) a single tone no longer
 * has a unique delay. */
float h68_grating_hz(float baseline_mm, float c_mps);

/* Path-difference quantum: one sample of lag equals this many millimetres. */
float h68_lag_quantum_mm(float c_mps, float sample_rate);

/* The firmware's correlation budget, reproduced exactly as doa.c computes it:
 *   DOA_MAXLAG = ceil(edge_mm * fs / (c_cold * 1000)) + 2
 *   span       = doa_n - 2*maxlag - 48
 * The 48 is the DOA_STREAM_CHUNK guard. Returns maxlag and writes the usable
 * coherent span in samples. */
int h68_firmware_maxlag(float edge_mm, float sample_rate);
int h68_firmware_span(float edge_mm, float sample_rate, int doa_n);

/* Angular resolution implied by one sample of lag on the longest baseline. */
float h68_angular_resolution_deg(float edge_mm, float c_mps, float sample_rate);

/* Far-field threshold 2*d^2/lambda in metres for the longest baseline. */
float h68_far_field_m(float edge_mm, float freq_hz, float c_mps);

/* Speed of sound from temperature, humidity and pressure using the Cramer
 * approximation the firmware applies to its DPS310 readings. */
float h68_sound_speed(float temp_c, float humidity_pct, float pressure_pa);

#ifdef __cplusplus
}
#endif

#endif /* H68_GEOMETRY_H */
