# winvm-dev reference

## Environment variables (counted in packages/, apps/, scripts/, docs/)
| Var | Effect | Source |
|---|---|---|
| `WINVM_HOME` | State root (images, instances, saves, media, firmware); default `~/.local/state/winvm` | `packages/core/src/paths.ts` |
| `WINVM_INSTANCE` / `-i` | Instance name; default `default` | `winvm help` |
| `WINVM_IMAGE` / `--image` | Image name; default `win11-arm64` | `args.ts` |
| `WINVM_ISO` | Windows ISO path | `media.ts` |
| `WINVM_RUNTIME` | Use this unpacked runtime dir instead of cache/app | `runtime.ts findRuntime` |
| `WINVM_RUNTIME_CACHE` | Runtime cache root; default `$XDG_DATA_HOME/winvm/runtime` | `runtime.ts runtimeCache` |
| `XDG_CONFIG_HOME` / `XDG_DATA_HOME` | `settings.json`; notes and runtime cache. Ignored unless absolute | `xdg.ts` |
| `WINVM_PACKAGE_DIR` | Where `assets/ firmware/ web/` live | `paths.ts packageDirFor` |
| `WINVM_QEMU_DATA` | UEFI firmware search path | `host.ts` |
| `WINVM_WEB_PORT` | Browser view's port | `web.ts` |
| `WINVM_CLI` | Set by the CLI itself for detached children; do not export | `paths.ts` |
| `PLAYWRIGHT_DIR` | Folder with playwright installed, for render scripts | `render-checkpoints.mjs` |
| `CHECKPOINT_PICTURES` | Dir of real PNGs for the render's "real" run | `render-checkpoints.mjs` |
| `turbo` passes through | `HOME`, `TMPDIR`, `WINVM_HOME` into tests | `turbo.json` |

## Not verified in this skill's authoring run
- Cold and incremental time of `build-app.ts` (a full `tauri build`); not run.
- Whether an unsigned/ad-hoc local `.app` launches and whether the sidecar inherits `WINVM_HOME` from `open --env`.
- `tauri dev` (no `devUrl`/`beforeDevCommand` in `tauri.conf.json`).
- A scratch `WINVM_HOME` with a symlinked `images/<image>` (create/start were not run; a permission check blocked creating instances).
- `winvm start`, scenario runtime, `winvm build` duration (README says ~20 min build, ~35 s start).
- The Tauri unified log location; stderr via direct exec or `open --stderr` is from source/usage only.
- The Playwright install line (copied from the script header; `/tmp/pw` already existed).

## Facts verified by running
`pnpm install` (1.6 s, warm store), `pnpm check` (cached 2.4 s; `--force` 43 s, 526 core tests, 225 viewer tests, 30 script tests), `winvm doctor`, `winvm ls`, `winvm help`, `pnpm winvm doctor`, `bun apply-pnpm-tarball-policy.mjs --check`, `bun scripts/build-ui.ts`, `render-checkpoints.mjs` (WebKit, light and dark), per-package/per-file tests, `rustc` shim error outside `apps/viewer`.
