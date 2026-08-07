# Licensing and secure boot (analyzer ↔ firmware contract)

This document is the contract between **het68_spectral** (analyzer) and the
**het68** firmware repository. The analyzer ships H68P verify and PARAM gating
under `v2.0.0`. Real OTP key shares, PICOBOOT disable, and in-SRAM encrypted
boot belong in firmware — they cannot ship as working silicon code from this
monorepo alone.

## H68P blob (analyzer)

Little-endian layout, 136 bytes:

| Offset | Size | Field |
|--------|------|--------|
| 0 | 4 | magic `H68P` |
| 4 | 2 | version `1` |
| 6 | 8 | CHIPID |
| 14 | 4 | expiry unix epoch (`0` = none) |
| 18 | 4 | feature flags |
| 22 | 2 | reserved (alignment) |
| 24 | 48 | `doa_params` flat (12×f32) |
| 72 | 64 | secp256k1 compact signature over bytes 0..71 (SHA-256 digest) |

Feature flags:

- `PARAM_IMPORT` (bit 0)
- `DOA_SWEEP` (bit 1)
- `ADVANCED_THRESHOLDS` (bit 2)

The analyzer verifies with a **test** secp256k1 public key (see
`@het68/license`). Production devices must use a verifying key derived from OTP
key shares, never this test key.

Private signing material for CI fixtures may live in
`packages/license/.test-keys/test-priv.hex` (gitignored) or `H68P_TEST_PRIV`.
The default generator key (`…0001`) is for local/CI convenience only.

## CHIPID / RANDID

- **CHIPID**: unique per RP2350 (or mock `68680000deadbeef` in the analyzer).
- **RANDID**: device-random identity for anti-clone; analyzer exposes
  `MOCK_RANDID` only as a placeholder for UI/dev tools.

Firmware should bind H68P to CHIPID (and optionally RANDID) before accepting
PARAM IMPORT over USB/UART.

## PARAM text

Same spirit as the analyzer DOA panel:

```
PARAM edge_mm=384
PARAM drone_conf_min=0.28
```

The analyzer rejects non-default protected thresholds unless a verified H68P
license carries `PARAM_IMPORT` and `ADVANCED_THRESHOLDS`.

## Time-limited license without RTC (open firmware work)

Suggested approaches (not implemented here):

1. **OTP rollback / monotonic counter** — burn a slot on each activation window.
2. **Duty-hour counter** — accumulate powered runtime in OTP or flash with
   anti-rollback; require re-activation when exhausted.
3. **Mandatory re-activation** — signed H68P with short expiry; host tool
   contacts a signing service with CHIPID proof.

## Secure / encrypted boot (firmware only)

Deferred from this repository:

- Writing OTP key shares and locking.
- Disabling PICOBOOT / SWD in production.
- AES image decrypt in SRAM before execute.
- Production signing service and HSM.

When those land in `het68`, bump a `v3.0.0` (or firmware tag) and point this
doc at the concrete OTP layout and boot stages.

## Reproducible ARM firmware build (firmware repo)

The analyzer WASM and the RP2350 image must share the same C sources and
`-ffp-contract=off`. Firmware CI should:

1. Pin `doa.c` (or submodule) to the same revision noted in
   `packages/dsp-core/csrc/doa/VENDOR.md`.
2. Build with `arm-none-eabi-gcc` and identical floating-point contract flags.
3. Publish `.uf2` / `.elf` with `SHA256SUMS.txt` (as `fedurca/het68` releases do).

Signing the encrypted image and writing OTP shares is out of scope here; the
analyzer only verifies H68P PARAM blobs and documents the contract above.
