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

### Symbols Nerd Font Mono 3.4.0 (subset) — `apps/viewer/ui/src/styles/fonts/`

The app's Files window draws file-type icons and its sort chevrons with 24
glyphs cut from Symbols Nerd Font Mono, from the Nerd Fonts v3.4.0 release
(<https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0>,
`NerdFontsSymbolsOnly.zip` SHA-256
`8e617904b980fe3648a4b116808788fe50c99d2d495376cb7c0badbd8a564c47`). The
subset (`symbols-nerd-font-mono-3.4.0-subset.woff2`, ~5 KB) was made with
fonttools' `pyftsubset`; the code points it keeps are the ones named in
`apps/viewer/ui/src/features/files/kinds.ts`.

- Nerd Fonts (Symbols Only): Copyright (c) 2014 Ryan L McIntyre. **MIT**.
- Every glyph kept is from GitHub's Octicons (Copyright (c) 2023 GitHub Inc.,
  **MIT**) or Seti-UI (Copyright (c) 2014 Jesse Weed, **MIT**), as Nerd Fonts'
  `license-audit.md` records. They are unchanged apart from being cut out of
  the font.
- Full texts: [`apps/viewer/ui/src/styles/fonts/LICENSE-nerd-fonts.txt`](apps/viewer/ui/src/styles/fonts/LICENSE-nerd-fonts.txt).

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
  <https://gitlab.com/qemu-project/qemu>. It also installs the SPICE agent
  (`vdservice`/`vdagent`, with an ARM64 build; GPL-2.0, Red Hat), which
  carries winvm's clipboard: <https://gitlab.freedesktop.org/spice/win32/vd_agent>.

### viofs (virtio-win 0.1.302) — the shared folder's driver

`winvm share install` and `winvm build` fetch four files of virtio-win's
`viofs/w11/ARM64` (`viofs.inf`, `viofs.sys`, `viofs.cat`, `virtiofs.exe`) from
<https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.302-1/virtio-win-0.1.302.iso>,
reading them out of the ISO by HTTP ranges, into the state directory, and
pin each by SHA-256 (`VIOFS_FILES` in `sharemedia.ts`). Copyright Red Hat,
Inc. and the virtio-win authors; BSD 3-clause, the same terms as the
virtio-win drivers above (`virtio-win_license.txt` on that ISO). They could be
redistributed with the notice, but are fetched like the other guest files.
Source: <https://github.com/virtio-win/kvm-guest-drivers-windows>.

### WinFsp 2.1 — `winfsp-2.1.25156.msi`

WinFsp - Windows File System Proxy, Copyright (C) Bill Zissimopoulos.
<https://github.com/winfsp/winfsp>. Fetched by `winvm share install` and
`winvm build` from
<https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-2.1.25156.msi>,
pinned by SHA-256 (`WINFSP_SHA256` in `sharemedia.ts`), and installed in the
user's own Windows guest. viofs's `virtiofs.exe` links its DLL; winvm itself
links nothing of it.

WinFsp is **GPLv3 with a FLOSS exception**. The exception lets FLOSS software
(1) link the platform WinFsp DLL and (2) "distribute unmodified binary
releases of the WinFsp installer", provided that the software (1) is under a
licence meeting the Free Software or Open Source Definition, (2) includes the
notice "WinFsp - Windows File System Proxy, Copyright (C) Bill Zissimopoulos"
and a link to the WinFsp repository in its user interface and any user-facing
documentation, and (3) "is not linked or distributed with proprietary
(non-FLOSS) software".

**Why it is downloaded, not bundled.** winvm's own code is MIT, which meets
(1), and this file gives the notice for (2). Condition (3) is the unclear
one: the signed winvm app ships beside things that are not FLOSS, and every
image it builds contains Windows. Without the exception, bundling the MSI
would be plain GPLv3 conveyance, with its source-offer duty. So winvm does
not redistribute WinFsp: the host downloads the unmodified release from
WinFsp's own GitHub release, as the user, and copies it into their own guest,
as it does with the UTM guest tools. Bundling it later would need the notice
in the app's UI as well, and a decision on (3).

### virtiofsd and the rest of the runtime

QEMU, `virtiofsd` (Chris Thomas's macOS port, Apache-2.0 AND BSD-3-Clause,
with its crates' notices under `share/licenses/virtiofsd/`) and the other
runtime components come from the winvm runtime, which carries their licences
and sources: <https://github.com/stuffbucket/winvm-runtime>.

### Windows 11 ARM64 installation media

Never redistributed and never cached by this tool. The user supplies their own
ISO with `winvm build --iso`, under Microsoft's own licence terms; the harness
symlinks it rather than copying it.
