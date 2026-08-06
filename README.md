# het68 spectral

Spectrogram analyzer for the het68 six-microphone detection cube. It reads a
six-channel recording or a live USB sound card, shows all six spectrograms on a shared
time axis, measures the differences between microphones, and builds acoustic signatures
of individual drones. The first target is the DJI Neo 2.

The DSP is written in C and compiled twice: to WebAssembly for this application and,
later, for the second core of the RP2350 in the firmware. That is the reason for the C:
a threshold tuned here has to mean the same thing on the device, and it cannot if the
two run different arithmetic.

## What it does

- **Spectrograms** of all six channels in WebGL2, shared colour scale, linear, log or
  mel frequency axis, cursor readout of time, frequency, magnitude and phase.
- **Watched bands** with per-band energy, signal-to-noise and tonality over time.
- **Microphone differences**: GCC and GCC-PHAT for all fifteen pairs, the lag-by-time
  surface, coherence, and the grating lobes the cube's spacing implies.
- **Array health**: levels, DC, clipping, self-noise, cross-correlation, and a channel
  mapping check against the firmware's calibration tone. A swapped pair rotates every
  azimuth the array will ever report and nothing else can detect it.
- **Drone signatures**: blade-pass frequency through cepstrum and harmonic product
  spectrum, rotor speed in rev/min, comb tracking across frames, template extraction and
  a matched detector. Signatures are relative, not tied to an absolute f0, because the
  Dronetag Mini's 32 g changes the hover speed of the drone carrying it.
- **Ground truth** from a Dronetag Mini: raw ASTM F3411 payloads decoded from hex,
  converted to azimuth and elevation in the cube's frame, resampled onto the analysis
  rate, with the angular error's GNSS ceiling drawn alongside it.
- **A synthetic scene generator** in the same C core, which is the only source of known
  truth until real recordings exist.
- **DOA**: the firmware `doa.c` engine compiled to WebAssembly — SRC/TRACKS lines,
  runtime `doa_params_t`, PARAM import/export, and 1D threshold sweeps against synth
  truth.
- **H68P licensing** (analyzer-side): secp256k1-signed parameter blobs and PARAM import
  gating. See `docs/licensing-and-secure-boot.md` for the firmware secure-boot contract.
- **Debug everything**: every intermediate is inspectable per frame and per bin, and
  everything exports to CSV or JSON.

## Layout

```
packages/dsp-core   C DSP + vendored doa.c → WebAssembly, plus native tests
packages/io         WAV, annotations, ASTM F3411, geodesy, export
packages/license    H68P blob schema, secp256k1 verify, PARAM gate
packages/ui         design tokens, plots, the WebGL spectrogram
apps/web            the analyzer itself
apps/desktop        Electron shell, ffmpeg capture, serial
src/worker.js       Cloudflare Worker: Basic Auth, COOP/COEP, assets
docs/               recording protocol, licensing / secure-boot contract
```

## Licensing note

The analyzer application code is proprietary to the project. Vendored
`packages/dsp-core/csrc/doa/` (`doa.c` / `doa.h` and its host shims) is **GPL-3.0**.
Building the WebAssembly artifact that includes DOA therefore produces a GPL-covered
binary; see `packages/dsp-core/csrc/doa/LICENSE.GPL3` and `VENDOR.md`. Deployments
already sit behind Basic Auth; that is access control, not a substitute for GPL
compliance if you redistribute the WASM.

## Downloads

Pre-built desktop builds for each tagged release are published on GitHub Releases,
with release notes / changelog:

**https://github.com/fedurca/het68_spectral/releases**

Create a GitHub Release whose tag is SemVer ([semver.org](https://semver.org/)) —
`vX.Y.Z` (e.g. `v2.0.1`) — and CI builds the web bundle, deploys
`spectral.het68.cz`, builds the unsigned macOS `.dmg`, and attaches it to that
release. The full history lives in [`CHANGELOG.md`](CHANGELOG.md).

```bash
# list releases
gh release list -R fedurca/het68_spectral

# download the macOS dmg for a tag
gh release download v2.0.1 -R fedurca/het68_spectral -p '*.dmg'
```

The `.dmg` is unsigned until an Apple Developer identity is configured in CI; the
first launch needs Gatekeeper to be overridden by hand.

## Requirements

- Node 20 or newer and pnpm 11 (`corepack enable pnpm`).
- Emscripten 4.0.19 to build the WebAssembly. Only needed when the C changes; CI
  installs it.
- clang for the native C tests.
- ffmpeg for live capture in the desktop build. It is found on `PATH` or in the usual
  Homebrew locations.

## Building

```bash
pnpm install
pnpm run build:dsp     # C to WebAssembly, needs emcc on PATH
pnpm run build         # DSP, build stamp, web bundle
pnpm run dev           # Vite dev server on 5173, with COOP/COEP set
```

Tests:

```bash
pnpm run test:dsp      # native C: geometry, STFT, GCC-PHAT, f0, signatures
pnpm run test          # TypeScript: WAV, annotations, ODID, geodesy
pnpm run typecheck
```

The native tests are the ones that matter for correctness. They check the DSP against
synthetic scenes with a known answer: a delay recovered to a twentieth of a sample, a
comb found at the frequency it was generated at, a signature that survives a ten per
cent change in rotor speed.

## Desktop

```bash
pnpm run desktop       # builds the web bundle and starts Electron
pnpm run desktop:dmg   # unsigned dmg in apps/desktop/release
```

The renderer is the same bundle the website serves, loaded from a `het68://` scheme
rather than from a file. A `file://` document has an opaque origin, and that costs both
the secure context and cross-origin isolation, so `SharedArrayBuffer` would disappear in
the desktop build alone.

```bash
pnpm --filter @het68/desktop run selftest
```

loads the renderer, checks the origin, isolation, fonts, WebGL2 and the preload bridge,
prints what it found and exits. It is how a packaging change is verified without
clicking through the application.

Live capture on macOS goes through `ffmpeg -f avfoundation`, which is the only reliable
way to get six channels; the browser downmixes to stereo and says nothing about it. The
dmg is unsigned, so the first launch needs Gatekeeper to be overridden by hand.

## Deployment

`spectral.het68.cz`, Cloudflare Workers with assets, behind Basic Auth. GitHub Actions
builds and deploys on push to `main` and on `v*` tags.

Two secrets are needed on the worker, and there is no default: without them every
request gets a 503 rather than a password that is written down in this repository.

```bash
npx wrangler secret put BASIC_AUTH_USER
npx wrangler secret put BASIC_AUTH_PASS
```

For local work the same two names go in `.dev.vars`, which is not committed:

```bash
printf 'BASIC_AUTH_USER="dev"\nBASIC_AUTH_PASS="dev"\n' > .dev.vars
npx wrangler dev
```

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` live in the repository's `production`
environment.

The worker sets `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, which is what makes `SharedArrayBuffer`
available to the live capture ring. The cost is that every subresource must be
same-origin, which is why Manrope is served from `apps/web/public/fonts` instead of from
Google.

## Before the first flight

Read `docs/recording-protocol.md`. It lists the mistakes that cannot be corrected
afterwards: an unmeasured cube position, a missing bearing for microphone 1, no
calibration take, and no time synchronisation between the audio and the Remote ID
stream.

Licensing and the RP2350 secure-boot / OTP contract for firmware: `docs/licensing-and-secure-boot.md`.
