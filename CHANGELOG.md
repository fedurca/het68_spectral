# Changelog

All notable changes to het68 spectral are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version tags follow
[SemVer](https://semver.org/) as `vX.Y.Z`.

Pre-built macOS `.dmg` builds for each tagged release are attached on
[GitHub Releases](https://github.com/fedurca/het68_spectral/releases).

## [2.0.1] — 2026-08-06

### Changed
- README: Downloads section linking to GitHub Releases (same pattern as het68 firmware).
- CI: attach the macOS `.dmg` to the GitHub Release for each `v*` tag.

## [2.0.0] — 2026-08-06

### Added
- Firmware `doa.c` vendored into `@het68/dsp-core` and compiled to WebAssembly.
- Runtime `doa_params_t`, PARAM import/export, re-run, and 1D parameter sweeps.
- DOA tab: SRC/TRACKS lines, comparison to synthetic truth when available.
- Analyzer-side H68P licensing (`@het68/license`): secp256k1 verify and PARAM gate.
- `docs/licensing-and-secure-boot.md` — firmware secure-boot / OTP contract.

### Notes
- Vendored DOA is GPL-3.0; see README licensing note.
- Synth azimuth vs DOA azimuth may still disagree (MIC_DIR vs analyzer geometry);
  detection and line grammar are covered by tests first.

## [1.0.0] — 2026-08-06

### Added
- V1 spectrogram analyzer: six-channel STFT, bands, GCC-PHAT pairs, array health,
  drone signatures, Remote ID ground truth, synthetic scenes, live capture shell.
- Cloudflare Worker deploy at `spectral.het68.cz` (Basic Auth, COOP/COEP).
- Electron desktop packaging (unsigned macOS `.dmg` on `v*` tags).
