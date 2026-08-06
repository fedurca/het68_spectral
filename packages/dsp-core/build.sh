#!/usr/bin/env bash
# Builds the DSP core to WebAssembly.
#
# -ffp-contract=off is not optional. The plan is to later compile this same source
# for core1 of the RP2350 and verify it against golden vectors produced here; if
# either side is allowed to fuse multiply-add operations the results diverge in the
# last bits and the comparison becomes meaningless.
set -euo pipefail

cd "$(dirname "$0")"

# Keep the Emscripten cache inside the repo so the build works in sandboxes that
# only grant write access to the workspace.
export EM_CACHE="${EM_CACHE:-$PWD/.emcache}"
mkdir -p "$EM_CACHE" wasm

if ! command -v emcc >/dev/null 2>&1; then
  if [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
    # shellcheck disable=SC1091
    source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1
  fi
fi
command -v emcc >/dev/null 2>&1 || {
  echo "emcc not found. Install emsdk or run: source ~/emsdk/emsdk_env.sh" >&2
  exit 1
}

emcc \
  -O3 \
  -std=c11 \
  -ffp-contract=off \
  -fno-fast-math \
  -DH68_HOST=1 \
  -I csrc \
  -I csrc/doa \
  -I csrc/doa/shim \
  csrc/h68_arena.c \
  csrc/h68_fft.c \
  csrc/h68_window.c \
  csrc/h68_geometry.c \
  csrc/h68_stft.c \
  csrc/h68_bands.c \
  csrc/h68_pairs.c \
  csrc/h68_harmonic.c \
  csrc/h68_health.c \
  csrc/h68_signature.c \
  csrc/h68_synth.c \
  csrc/h68_api.c \
  csrc/kissfft/kiss_fft.c \
  csrc/kissfft/kiss_fftr.c \
  csrc/doa/doa.c \
  csrc/doa/doa_api.c \
  csrc/doa/shim/debug_io.c \
  csrc/doa/shim/entity_store.c \
  csrc/doa/shim/detection_log.c \
  csrc/doa/shim/doa_host_time.c \
  -o wasm/h68dsp.mjs \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32","HEAP32","HEAPU8"]' \
  -s STACK_SIZE=1048576 \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  -s SINGLE_FILE=1

# SINGLE_FILE embeds the wasm as base64 inside the module. At this size the ~33 %
# encoding overhead is a few tens of kilobytes, and in exchange the module loads
# identically from Vite, a Web Worker, Node and Electron with no separate asset to
# locate and no extra request to satisfy under COEP require-corp.
echo "built wasm/h68dsp.mjs ($(du -h wasm/h68dsp.mjs | cut -f1))"
