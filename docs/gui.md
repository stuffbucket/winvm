# Driving app UI: UI Automation, WebView2, OCR, toasts

Four ways to check (and drive) what a Windows app shows, all from the host,
none needing a window on the Mac:

| | what it reads | needs | command |
|---|---|---|---|
| **UI Automation** (`ui.ts`, `assets/winvm-ui.cs`) | the accessibility tree: native windows, the taskbar and tray, Win32 menus, dialogs, and WebView2 content too | the in-guest agent (v4+) | `winvm ui …` |
| **DevTools** (`webview.ts`, `cdp.ts`) | the DOM of a WebView2 window (Tauri, WinUI/WPF hosts) | a policy set before the app starts | `winvm webview …` |
| **OCR** (`ocr.ts`, `assets/ocr.swift`) | the screen's pixels: anything, incl. native dialogs and menus | macOS + `swiftc` | `winvm ocr`, `winvm click --text` |
| **Toasts** (`toasts.ts`) | Windows' record of every notification an app raised | the in-guest agent | `winvm toasts` |

UI Automation is the one that also *drives* the shell around an app: the
notification-area icon, its context menu, a TaskDialog. See
[UI Automation](#ui-automation-winvm-ui) below.

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

## UI Automation (`winvm ui`)

```sh
winvm ui windows                                   # top-level windows, with process names
winvm ui tree --process maximal-shell --depth 8     # the element tree
winvm ui find --window Settings --name Models --type Hyperlink
winvm ui wait --process maximal-shell --window Settings --name Account --type Text --timeout 30
winvm ui click --window Settings --id Close --settle 300
winvm ui wait --process maximal-shell --window Settings --gone
winvm ui tray Maximal --menu Settings               # tray icon by tooltip, then its menu item
winvm ui click --window "Quit Maximal?" --name "Quit Maximal" --type Button
winvm ui settle --process maximal-shell             # until nothing changes for 300 ms
winvm ui invoke | toggle | expand | collapse | select | focus  [selector]
winvm ui set --name Search --type Edit --value hello    # ValuePattern; `type` sends keys instead
winvm ui at 618 515                                 # what a click at x,y would hit
```

**Selectors.** A scope picks top-level windows — `--window` (title contains,
case-insensitive, or class equals), `--process` (name, `.exe` optional),
`--hwnd` — and both together must hold. Then the element: `--name` (exact,
case-insensitive; a bare word after the verb means `--name`), `--contains`,
`--id` (AutomationId), `--type` (ControlType: Button, MenuItem, Hyperlink,
Text, Window, Edit, …), `--class`, `--index`. With no scope the whole desktop
is searched: correct, ~10 ms slower. `--timeout` (seconds, or `500ms`) is
how long to keep looking; `click` and friends default to 10 s, `find` to none.
`--json` prints the helper's answer.

**Clicks are real input** (SendInput: move, 40 ms hover, press, release) at
the element's centre, so they go through hit-testing, focus and hover exactly
like a person's. So before each click the helper hit-tests the point
(`WindowFromPoint`): if another top-level window is there — a toast sliding up
over the tray, a dialog — it parks the pointer at the screen's left edge (a
toast never times out under the pointer) and waits, up to the timeout, then
fails with code `covered` naming the window. `--settle <ms>` first waits for
the element's window to stop changing, then finds it again. `invoke`/`toggle`/`expand`/`select`/`set` use
UIA patterns instead and need nothing on screen.

**The tray.** `ui tray <tooltip part>` looks for the icon on the taskbar's
notification area (task buttons don't count: "Maximal - 1 running window" is
not the tray icon), else opens the overflow flyout with "Show Hidden Icons"
and looks there; waits for the icon to stop moving; clicks it (right by
default, `--button left|double`). With `--menu <item>` it then clicks that
item in the context menu (`#32768`, matched without `&`, the accelerator and
a trailing `…`; exact first, then prefix), clicking the icon again if no menu
appears within 2.5 s — right after start an app may not have attached its
menu yet — and closes the flyout afterwards. `ui menu <item>` alone clicks an
item of a menu that is already open.

**Settling.** `ui settle` polls the scope's element tree every 50 ms (one
cached cross-process walk each; names, types, bounds, enabled/offscreen,
values, toggle states) and returns once it has been identical for `--quiet`
ms (300). No scope: every top-level window plus the foreground window's
subtree. It reports `settled: false` (exit 1) at `--timeout` (10 s) rather
than throwing.

In jobs, `shell: winvm` lines (see below):

```yaml
  - name: Quit Maximal from the tray menu and confirm
    shell: winvm
    run: |
      ui tray Maximal --menu "Quit Maximal"
      ui click --process maximal-shell --window "Quit Maximal?" --name "Quit Maximal" --type Button --settle 200
      ui wait --process maximal-shell --gone --timeout 30
```

`jobs/maximal/nsis.yml` is the worked example: Settings opened from the tray
menu, and a real Quit from the tray menu followed by the no-orphan check.

For harnesses, `ui.ts`:

```ts
import { forInstance } from "./ui"
const ui = await forInstance(name)        // agent.ensure, helper version check, warm-up
await ui.tray("Maximal", { menu: "Settings" })
await ui.wait({ process: "maximal-shell", window: "Settings", name: "Account", controlType: "Text" })
await ui.click({ window: "Settings", name: "Models", controlType: "Hyperlink" }, { settleMs: 200 })
const t = await ui.tree({ process: "maximal-shell" }, { depth: 6 })
// also: find, findAll, invoke, setValue, type, act(action, sel), focus, settle, menu, windows, ping
```

Errors are `UiError` with a `code`: `notfound`, `timeout`, `covered`, `bad`,
`unavailable` (no helper: off Windows, or an agent older than v4), `fail`.

### How it works

`winvm-ui.exe` (`assets/winvm-ui.cs`, C# 5) is compiled in the guest by
`agent-install.ps1` with Add-Type against the in-box .NET Framework 4.8.1
(`System.Windows.Automation`): AnyCPU, so it runs **native ARM64**, per-monitor
DPI aware (UIA bounds = SendInput coordinates = screendump pixels). The
agent's spawner starts it on first use and talks to it over stdin/stdout, one
JSON line each way, answers matched by id so a long `wait` holds up nothing
else; the agent exposes that as `POST /ui` (`AgentClient.ui`). It exits when
its stdin closes, so it never outlives the agent. Every request is logged to
`C:\ProgramData\winvm\agent\winvm-ui.log`; one that UIA never answers (a
hung window) is answered with a `timeout` error after 2 × its timeout + 25 s.
`ui.forInstance` reinstalls the agent when the guest's helper is older than
`UI_HELPER_VERSION`, so goldens made before a helper change upgrade
themselves on first use (~5 s).

### Things learned

- **WebView2 builds its accessibility tree on the first UIA query.** The very
  first `find` into a fresh Chromium window can miss; `wait` (or any
  `--timeout`) covers it. After that the web content is ordinary elements
  (ListItem, Hyperlink, Text, Button, ComboBox …) in the app's window.
- **Toasts are invisible to UI Automation but take clicks.** Maximal's "Sign
  in to GitHub" toast (a `Windows.UI.Core.CoreWindow` of ShellExperienceHost,
  "New notification") slides up over the tray right after start, and neither
  the UIA tree nor `AutomationElement.FromPoint` shows it — the first nsis
  runs right-clicked the toast and opened *its* context menu. Hence the
  Win32 hit test above; `ui at x y` shows both views.
- **A higher-integrity window on top swallows real clicks.** Windows
  Firewall's "allow this app" prompt (a Bun-compiled sidecar listening on
  0.0.0.0 shows as "Bun") does not appear in the UIA tree, and input aimed at
  the window under it goes nowhere. Allow the program first (the job's first
  step); `agent-install.ps1` now also turns the firewall's desktop prompts off.
- Maximal's title-bar Close hides Settings to the tray (the process stays);
  `wait --gone` with only a scope waits for the window to leave the tree.
- **The overflow flyout lies about being open.** A closed flyout stays in the
  UIA tree with its old bounds and not offscreen — it is only DWM-cloaked —
  so `tray` asks `IsWindowVisible` and `DWMWA_CLOAKED`. An open one stays open
  after its icon's menu is used and sinks behind the window the item opened
  (Settings, 820x620, covers the whole 800x600 screen); `tray` closes it
  afterwards, and if it finds its icon covered anyway it closes and reopens
  the flyout (a covering toast is waited out the same way).


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
