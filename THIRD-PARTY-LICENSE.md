# Third-party software in winvm

This directory redistributes some third-party software and downloads more at
run time. Notices for both are kept in this file so the obligations travel with the
tool wherever it is copied.

---

## Redistributed here

### TianoCore EDK2 UEFI firmware — `packages/core/firmware/`

`packages/core/firmware/edk2-aarch64-code.fd.gz` and `packages/core/firmware/edk2-arm-vars.fd.gz` are the
AArch64 UEFI firmware images QEMU ships, stored gzipped (they are ~99% zero
padding: 128 MiB becomes 1.6 MB) and expanded into the state directory on first
use.

- Copyright (c) 2019, TianoCore and contributors. All rights reserved.
- **SPDX-License-Identifier: BSD-2-Clause-Patent**
- Full text: [`packages/core/firmware/edk2-licenses.txt`](packages/core/firmware/edk2-licenses.txt)

Binary redistribution is permitted provided the copyright notice, this list of
conditions and the disclaimer are reproduced — which is what this file and
`edk2-licenses.txt` do.

They are vendored so the harness does not depend on where a particular QEMU
packaging put its data files. Set `WINVM_QEMU_DATA` to use a system copy instead.

### noVNC 1.7.0 — `packages/core/web/novnc/`

The browser view (`winvm open --web`) uses noVNC's client library, vendored
unmodified from the v1.7.0 release
(<https://github.com/novnc/noVNC/releases/tag/v1.7.0>, tarball SHA-256
`b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6`). Only what
the page loads is kept: `core/` and `vendor/pako/`, with the licence files
(~740 KB). noVNC's own app (`vnc.html`, `app/`) is not included; `packages/core/web/index.html`
and `packages/core/web/app.js` are this project's.

- `core/`: Copyright (C) noVNC authors (see `packages/core/web/novnc/AUTHORS`).
  **SPDX-License-Identifier: MPL-2.0**, except `core/crypto/des.js` (BSD-style,
  see its header) and `core/base64.js` (MPL-2.0).
- `vendor/pako/`: Copyright (C) 2014-2016 Vitaly Puzrin.
  **MIT**.
- Full texts: [`packages/core/web/novnc/LICENSE.txt`](packages/core/web/novnc/LICENSE.txt),
  [`packages/core/web/novnc/docs/LICENSE.MPL-2.0`](packages/core/web/novnc/docs/LICENSE.MPL-2.0),
  [`packages/core/web/novnc/docs/LICENSE.BSD-2-Clause`](packages/core/web/novnc/docs/LICENSE.BSD-2-Clause),
  [`packages/core/web/novnc/docs/LICENSE.BSD-3-Clause`](packages/core/web/novnc/docs/LICENSE.BSD-3-Clause),
  [`packages/core/web/novnc/vendor/pako/LICENSE`](packages/core/web/novnc/vendor/pako/LICENSE).

MPL-2.0 is file-level copyleft: these files stay under MPL-2.0 and their source
is this source. Modifying one means publishing that file's changes under MPL-2.0;
nothing else in winvm is affected. None are modified.

---

## Downloaded at run time, NOT redistributed here

### UTM guest tools — `utm-guest-tools-latest.iso`

Fetched by `winvm build` / `winvm setup` from
<https://getutm.app/downloads/utm-guest-tools-latest.iso> into the state
directory, and pinned by SHA-256 (see `TOOLS_SHA256` in `host.ts`).

**Deliberately not vendored.** The ISO is ~121 MB and does not compress (its
payload is already compressed), and its installer carries `qemu-ga`, which is
**GPL-2.0**. Redistributing that would oblige this project to make the
corresponding source available for as long as it ships the binary — a standing
duty for what is only a developer test fixture. Downloading it at run time
leaves the user obtaining it directly from upstream, as they would any tool.

The ISO itself carries:

- **virtio-win drivers** — Copyright Red Hat, Inc.; Google, Inc.; Virtuozzo,
  Inc.; IBM Corporation. Redistributable in binary form under a BSD-style
  three-clause licence; the full text ships on the ISO as
  `virtio-win_license.txt`.
- **`utm-guest-tools-*.exe`** — the UTM guest tools installer, which bundles
  `qemu-ga` (**GPL-2.0**, © the QEMU authors). Source for QEMU is at
  <https://gitlab.com/qemu-project/qemu>.

### Windows 11 ARM64 installation media

Never redistributed and never cached by this tool. The user supplies their own
ISO with `winvm build --iso`, under Microsoft's own licence terms; the harness
symlinks it rather than copying it.
