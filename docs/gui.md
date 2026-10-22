# Driving app UI: WebView2, OCR, toasts

Three ways to check what a Windows app shows, all from the host, none needing
a window on the Mac:

| | what it reads | needs | command |
|---|---|---|---|
| **DevTools** (`webview.ts`, `cdp.ts`) | the DOM of a WebView2 window (Tauri, WinUI/WPF hosts) | a policy set before the app starts | `winvm webview …` |
| **OCR** (`ocr.ts`, `assets/ocr.swift`) | the screen's pixels: anything, incl. native dialogs and menus | macOS + `swiftc` | `winvm ocr`, `winvm click --text` |
| **Toasts** (`toasts.ts`) | Windows' record of every notification an app raised | the in-guest agent | `winvm toasts` |

UI Automation (the accessibility tree) is separate work.

## Numbers

Measured on `win11-arm64-v3` (800x600 screen), M-series host, 2026-10-22,
against Maximal v0.4.47's Settings window (x64 under Prism, WebView2 152).
`jobs/maximal/settings-ui.yml` passes end to end in 21.8 s from a golden reset
(1.2 s reset, 1.1 s stage, 7 s NSIS install; the DevTools step 0.8 s, the
toast step 0.1 s, two OCR finds 0.7 s).

| operation | median | notes |
|---|---|---|
| CDP `Runtime.evaluate` on a held session | **0.4 ms** | `document.title`; p90 0.5 ms |
| CDP `text` / `waitFor` (present) / `click` on a held session | 0.4 ms / 0.4 ms / 16 ms | click = 3 `Input.dispatchMouseEvent`s + a lookup |
| CDP connect (forward check, `/json/list`, ws open) | 10 ms | once per session |
| `winvm webview eval` end to end | 35 ms | mostly bun startup (24 ms) |
| QMP screendump to PNG | 12 ms | |
| Vision OCR, accurate / fast | **300 ms** / 57 ms | whole 800x600 screen |
| `winvm ocr --find` end to end | 338 ms | screendump + OCR + startup |
| toasts read (copy WPN db + wal + shm out, sqlite) | **50 ms** | ~2 MB over the agent |
| `winvm toasts` end to end | 88 ms | |

OCR cost is per call: the helper is a fresh process that loads Vision's model
each time (in-process repeats run 80–150 ms). `--fast` trades accuracy on
small UI text for ~5x speed; the default is accurate. First `winvm ocr` also
compiles the helper (`swiftc -O`, ~0.8 s, once
per source change).

## WebView2 over DevTools

```sh
winvm webview enable maximal-shell.exe          # once; then (re)start the app
winvm webview targets
winvm webview eval 'document.title' --target /ui/settings
winvm webview wait 'nav.sidebar a[href="#apps"]' --visible --timeout 30
winvm webview click 'nav.sidebar a[href="#apps"]'
winvm webview text 'h2.section__title' --expect Account
```

`--target T` picks the page whose URL or title contains T (default: the first
page). Commands wait up to `--timeout` (10 s) for the app's port and page, so
they can follow a launch directly. `eval` awaits promises and prints JSON
(strings raw); a thrown exception exits 1, which is the way to assert.
`click` is a real mouse press/release at the element's centre
(`Input.dispatchMouseEvent`), after scrolling it into view.

For harnesses: `webview.session(name, match)` returns a `CdpSession` with
`eval`, `waitFor`, `text`, `click` and raw `send(method, params)`.

### How the port gets out

1. **The policy.** WebView2 opens a DevTools port only when its browser
   arguments say so. Tauri ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, so
   `enable` sets the machine policy
   `HKLM\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments`,
   value name = the exe's file name, data `--remote-debugging-port=9222`. It
   is read when the app creates its WebView2 environment: at app start.
2. **The relay.** Chromium binds the port to 127.0.0.1, and a slirp forward
   arrives on the guest's address (10.0.2.15), never its loopback. A Windows
   portproxy relays `0.0.0.0:19222` (port + 10000) to `127.0.0.1:9222`, with
   a firewall rule admitting 10.0.2.2 (slirp) only.
3. **The forward.** A host port to the relay, added at runtime with
   `hostfwd_add` — never on the QEMU command line, which would change every
   save's compatibility hash (same reasoning as the agent's, `agentfwd.ts`).
   Every command re-checks it, so a new QEMU process (load, stow recall,
   golden reset) gets it back on first use. State: `<instance>/webview.json`.

1 and 2 live in the guest's registry, so a save or golden taken after
`enable` keeps them. `disable <exe>` removes them.

Chromium checks the `Host` header of `/json/*`; an IP literal (what we send)
passes. Its `webSocketDebuggerUrl` echoes that host and port, so it needs no
rewriting.

## OCR

```sh
winvm ocr                                  # every line: x,y wxh  confidence  text
winvm ocr --find "MCP servers" --wait 20   # exit 1 if not there after 20 s
winvm ocr --image shot.png --json          # any image; JSON with centres
winvm click --text Cancel                  # OCR, then click the middle of the match
```

A QMP screendump (PNG, framebuffer pixels) goes through macOS Vision
(`VNRecognizeTextRequest`, accurate, en-US language correction) in
`assets/ocr.swift`, compiled on first use into
`$WINVM_HOME/cache/bin/winvm-ocr-<source hash>`. Boxes are screenshot pixels,
the same coordinates `winvm click x y` takes.

Matching folds case and accents. A whole-line match beats a line that merely
contains the text; ties go top to bottom, then left to right. A match inside a
longer line gets its own box (Vision boxes substrings), so `--text Quit` on
"Quit Maximal" clicks "Quit".

## Toasts

```sh
winvm toasts                                         # every toast still on record
winvm toasts --app maximal --find "Sign in" --since 10m --wait 30
winvm toasts --json
```

Windows records each toast it accepts in the user's WPN database,
`%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db` (SQLite, WAL,
held open by WpnUserService). The agent runs as that user, copies the db,
`-wal` and `-shm` out over HTTP, and `bun:sqlite` reads the copy (opening it
read-write, so the WAL is applied). `Notification.Payload` is the toast XML;
its `<text>` elements are the title and body. `ArrivalTime` is a FILETIME.

The image turns toast popups and the notification centre off
(`assets/logon.ps1`); toasts are recorded all the same, which is what makes
this reliable where OCR of a popup would race its animation. A toast stays in
the table until it is dismissed or expires (days), so "did it fire?" wants
`--since`. Times are the guest's clock, which winvm keeps on the host's.

## In jobs: `shell: winvm`

A step with `shell: winvm` runs each line of `run` as a winvm command **on the
host**, against the job's instance (`hoststep.ts`): split like a POSIX shell
(quotes, no expansion), `-i <instance>` added, the job's and step's env
passed. The step fails at the first line that exits non-zero.

```yaml
  - name: Settings over DevTools
    shell: winvm
    run: |
      webview wait 'nav.sidebar a[href="#apps"]' --visible --target /ui/settings --timeout 60
      webview text 'h2.section__title' --expect Account
      toasts --app co.stuffbucket.maximal --find "Sign in to GitHub" --since 10m --wait 30
      ocr --find Diagnostics
```

`jobs/maximal/settings-ui.yml` is the worked example: install the NSIS tray
app, `webview enable`, start it, read and click Settings over DevTools, check
the start-up toast, OCR Settings.

### Maximal notes

- A fresh install with no account raises **"Sign in to GitHub"** at start, and
  opens Settings at `#account` on its own. A second launch of
  `maximal-shell.exe` focuses or opens Settings.
- **"Maximal is working"** fires on the first tokens through the proxy
  (`src/lib/working-notice.ts`), so it needs a signed-in Copilot account; a
  CI guest has none. The job checks it as informational only.
