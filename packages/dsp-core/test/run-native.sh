#!/usr/bin/env bash
# Builds and runs the DSP core tests natively.
#
# Same flags as the wasm build where it matters (-ffp-contract=off), so a result
# verified here means the same thing there. -Werror because this code is destined
# for a microcontroller, where a warning ignored today is a hard fault later.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p test/bin

CC="${CC:-clang}"

$CC \
  -O2 \
  -std=c11 \
  -ffp-contract=off \
  -Wall -Wextra -Werror \
  -Wno-unused-function \
  -I csrc \
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
  csrc/kissfft/kiss_fft.c \
  csrc/kissfft/kiss_fftr.c \
  test/test_dsp.c \
  -lm \
  -o test/bin/test_dsp

exec ./test/bin/test_dsp
