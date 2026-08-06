/*
 * Loads the built wasm module directly and exercises the flat API the TypeScript
 * wrapper sits on. Runs with plain node, so a broken binding shows up without a
 * test runner or a bundler in the way.
 */
import createModule from "../wasm/h68dsp.mjs";

const m = await createModule();

const fail = [];
const ok = (cond, what) => {
  if (!cond) fail.push(what);
};
const near = (got, want, tol, what) => {
  if (!(Math.abs(got - want) <= tol)) {
    fail.push(`${what}: got ${got} want ${want} (tol ${tol})`);
  }
};

console.log("api version", m._h68_version(), "max fft", m._h68_max_fft());

near(m._h68_api_sound_speed(20, 0, 101325), 343.2, 0.5, "sound speed");
near(m._h68_api_grating_hz(384, 343), 446.6, 1, "grating at 384 mm");
ok(m._h68_api_firmware_maxlag(384, 48000) === 64, "firmware maxlag");
ok(m._h68_api_firmware_span(384, 48000, 256) === 80, "firmware span");

// Render a scene from a known direction, then confirm GCC-PHAT agrees with the
// geometry. This is the same end-to-end check the native tests make, repeated here
// so a mistake in the wasm build or the exports cannot pass unnoticed.
const fs = 48000;
const n = 24000;
const SYNTH_FLOATS = 34;

const pParams = m._h68_malloc(SYNTH_FLOATS * 4);
m._h68_api_synth_defaults_neo2(fs, n, pParams);
const params = m.HEAPF32.subarray(pParams >> 2, (pParams >> 2) + SYNTH_FLOATS);
const AZ = 35;
const EL = 20;
params[7] = AZ;
params[8] = EL;
params[9] = 20; // distance
params[20] = -120; // wind off
params[22] = -120; // background off

const pAudio = m._h68_malloc(6 * n * 4);
ok(m._h68_api_synth_render(pParams, pAudio) === 0, "synth render");

const c = m._h68_api_sound_speed(15, 60, 101325);
const maxLag = 70;
const span = 2 * maxLag + 1;
const pCorr = m._h68_malloc(span * 4);
const pStats = m._h68_malloc(6 * 4);

let worst = 0;
for (let i = 0; i < 6; i++) {
  for (let j = i + 1; j < 6; j++) {
    const want = m._h68_api_expected_lag(i, j, AZ, EL, 384, c, fs);
    const rc = m._h68_api_gcc_column(
      pAudio + i * n * 4,
      pAudio + j * n * 4,
      8192,
      16384,
      1,
      maxLag,
      700,
      9000,
      fs,
      pCorr,
      pStats,
    );
    ok(rc === 0, `gcc column ${i}-${j}`);
    const got = m.HEAPF32[pStats >> 2];
    worst = Math.max(worst, Math.abs(got - want));
  }
}
console.log(`worst lag error across 15 pairs: ${worst.toFixed(3)} samples`);
ok(worst < 1.0, "gcc-phat matches geometry through wasm");

// STFT normalisation must survive the wasm build too.
const pTone = m._h68_malloc(n * 4);
const tone = m.HEAPF32.subarray(pTone >> 2, (pTone >> 2) + n);
const k0 = 512;
const f0 = (k0 * fs) / 4096;
for (let i = 0; i < n; i++) tone[i] = Math.sin((2 * Math.PI * f0 * i) / fs);
ok(m._h68_api_stft_configure(4096, 4096, 2048, 1, 0, fs) === 0, "configure");
const bins = m._h68_api_stft_bins();
const frames = m._h68_api_stft_frames(n);
const pDb = m._h68_malloc(frames * bins * 4);
ok(m._h68_api_stft_analyze(pTone, n, -160, pDb, 0) === 0, "analyze");
near(m.HEAPF32[(pDb >> 2) + bins + k0], 0, 0.05, "full-scale sine reads 0 dBFS");

console.log(
  "arena",
  m._h68_arena_used_bytes(),
  "/",
  m._h68_arena_capacity_bytes(),
  "bytes,",
  m._h68_fft_plan_count(),
  "fft plans",
);

if (fail.length) {
  console.error("\nFAILURES:");
  for (const f of fail) console.error("  " + f);
  process.exit(1);
}
console.log("\nwasm smoke test passed");
