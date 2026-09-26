# Changelog

All notable changes to het68 spectral are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version tags follow
[SemVer](https://semver.org/) as `vX.Y.Z`.

Pre-built macOS `.dmg` and Ubuntu `.snap` builds for each tagged release are
attached on [GitHub Releases](https://github.com/fedurca/het68_spectral/releases).

## [Unreleased]

### Fixed
- CI: bump GitHub Actions to Node 24 runtimes (`checkout` v7, `setup-node` v7,
  `upload-artifact` v7, `download-artifact` v8, `pnpm/action-setup` v6,
  `setup-emsdk` v16, `action-gh-release` v3) and build on Node 24 LTS.

## [2.0.7] — 2026-09-26

### Added
- **2 kHz position** tab. It finds the loudest half-second of a tone in the
  drone band (default 2000 Hz) and marks the nearest microphone. With six
  channels it also draws an energy-weighted azimuth on the nominal cube.
  A two-channel buffer, which is what Chromium delivers from this sound card,
  is drawn as a left/right axis and labelled as a downmix.

## [2.0.6] — 2026-08-07

### Added
- Desktop: manual **Check for updates** against GitHub Releases (Debug tab); optional
  `.dmg` download into Downloads — no background auto-update.

### Changed
- README: uninstall steps for macOS.

### Fixed
- Ubuntu snap: drop plugs already in electron-builder `default` (`home`,
  `audio-playback`, `pulseaudio`) so snapcraft 9 validation succeeds; snap builds
  in a dedicated CI job and attaches to the GitHub Release.

## [2.0.5] — 2026-08-07

### Fixed
- Snap CI no longer blocks web deploy / macOS dmg (`continue-on-error` + timeouts).
- Host DOA shim emits `DET` UART lines alongside SRC/TRACKS for analyzer parity.

### Changed
- Secure-boot docs: reproducible ARM build contract for firmware.

## [2.0.4] — 2026-08-06

### Fixed
- Build the Ubuntu snap inside the existing Ubuntu CI job (and attach it with the
  macOS dmg) so a separate Linux job is not blocked by GitHub Actions outages.

## [2.0.3] — 2026-08-06

### Added
- Ubuntu `.snap` package (electron-builder core24) built in CI and attached to
  GitHub Releases alongside the macOS `.dmg`.

## [2.0.2] — 2026-08-06

### Fixed
- macOS `.dmg`: ad-hoc codesign after pack; disable broken unsigned hardened-runtime
  so Gatekeeper no longer reports "app is damaged" as the only symptom of quarantine.
- README: clear quarantine (`xattr -cr`) and how to collect Electron / unified logs.

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
