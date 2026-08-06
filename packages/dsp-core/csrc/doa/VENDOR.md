/*
 * Vendored from het68 firmware (doa.c / doa.h) for WASM and native host use.
 *
 * Upstream: fedurca/het68 (GPLv3). Intended to track a release tag once the
 * remote is reliably available in CI; until then this tree is a frozen copy
 * plus host shims under shim/.
 *
 * Changes relative to firmware:
 *   - pico / multicore / flash replaced by host stubs
 *   - doa_core1_main infinite loop exposed as doa_reset + doa_step
 *   - doa_params_t for runtime thresholds and edge (buffers sized for max edge)
 */
