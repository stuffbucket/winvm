# Driving app UI

winvm has four ways to check and drive what a Windows app shows. All of them
run from the host and none needs a window open on the Mac.

| tool | command | reads | needs |
|---|---|---|---|
| UI Automation | `winvm ui` | the accessibility tree: windows, buttons, menus, dialogs, the taskbar and tray, and WebView2 content | the in-guest agent (installed or upgraded on first use) |
| DevTools | `winvm webview` | the DOM of a WebView2 window (Tauri, WinUI and WPF apps) | `winvm webview enable` before the app starts |
| OCR | `winvm ocr`, `winvm click --text` | the text in the screen's pixels | macOS and `swiftc` (Xcode command-line tools) |
| Notifications | `winvm toasts` | every notification (toast) an app raised | the in-guest agent |

Use UI Automation to click things by name, including the tray icon and its
menu. Use DevTools to read or click inside a web page. Use OCR for anything
the other two can't see. Use `winvm toasts` to check that an app sent a
notification.

All commands take `-i <instance>`, and the instance must be running.

Measured on `win11-arm64-v3` (800x600 screen), M-series Mac, 2026-10-22,
against Maximal v0.4.47:

| operation | typical time |
|---|---|
| `ui` find an element by name in a window | 20 ms (plus about 50 ms to start `winvm`) |
| `ui click` | 130 ms |
| `ui tray Maximal --menu Settings` | 1.2 s |
| `webview eval` | 35 ms from the shell; under 1 ms per call on an open session |
| `ocr --find` | 340 ms (`--fast`: about 5x faster, less accurate on small text) |
| `toasts` | 90 ms |

## UI Automation (`winvm ui`)

```sh
winvm ui windows                                    # top-level windows, with process names
winvm ui tree --process maximal-shell --depth 8     # the element tree
winvm ui find --window Settings --name Models --type Hyperlink
winvm ui wait --process maximal-shell --window Settings --name Account --type Text --timeout 30
winvm ui click --window Settings --id Close --settle 300
winvm ui wait --process maximal-shell --window Settings --gone
winvm ui tray Maximal --menu Settings               # the tray icon by tooltip, then its menu item
winvm ui menu Exit                                  # click an item in a menu that is already open
winvm ui settle --process maximal-shell             # wait until nothing changes for 300 ms
winvm ui set --name Search --type Edit --value hello
winvm ui type --name Search --type Edit --value hello
winvm ui at 618 515                                 # what a click at x,y would hit
winvm ui ping                                       # the helper's version, DPI and screen size
```

Other actions: `rightclick`, `doubleclick`, `invoke`, `toggle`, `expand`,
`collapse`, `select`, `focus`. Run `winvm ui help` for the full list.

### Selectors

First choose which top-level windows to search. If you give more than one,
all must match:

- `--window <text>`: the title contains the text (any case), or the window
  class equals it.
- `--process <name>`: the process name; `.exe` is optional.
- `--hwnd <n>`: the window handle.

Then choose the element:

- `--name <text>`: the exact name, any case. A word right after the verb
  means `--name`.
- `--contains <text>`: the name contains the text.
- `--id <id>`: the AutomationId.
- `--type <type>`: the control type, such as Button, MenuItem, Hyperlink,
  Text, Window or Edit.
- `--class <name>`, `--index <n>`.

Without a window or process, `ui` searches the whole desktop. That works but
is slower.

### Options

- `--timeout <s>` (or `500ms`): how long to keep looking for the element.
  `click`, `wait` and the other actions default to 10 seconds. `find` does
  not wait unless you pass `--timeout`. `menu` waits 5 seconds.
- `--settle <ms>`: before acting, wait until the element's window has stopped
  changing for that long.
- `--json`: print the helper's full answer.

### Clicks

`click`, `rightclick` and `doubleclick` send real mouse input to the centre of
the element, so the app sees them exactly like a person's clicks.

Before clicking, winvm checks which window is at that point. If another
window covers the element, such as a notification or a dialog, winvm moves
the pointer out of the way and waits for it to go. If it is still covered at
the timeout, the command fails with the error code `covered` and names the
covering window.

`invoke`, `toggle`, `expand`, `select` and `set` use UI Automation patterns
instead of the mouse. They work even when the element is not visible.

`set` replaces a text field's value directly. `type` focuses the element and
types the text as key presses.

### The tray

`ui tray <tooltip text>` finds the notification-area icon whose tooltip
contains the text. Taskbar buttons don't count. If the icon is hidden, winvm
opens the "Show hidden icons" flyout and looks there. It then clicks the icon:
a right-click by default, or `--button left|double`.

With `--menu <item>`, winvm then clicks that item in the icon's context menu.
The match ignores case, the `&` accelerator marker and a trailing `…`; an
exact match wins, then a prefix. If no menu appears within 2.5 seconds, winvm
clicks the icon again, because an app that has just started may not have
attached its menu yet. Afterwards it closes the flyout.

### Waiting for the UI to settle

`ui settle` waits until the element tree has not changed for `--quiet`
milliseconds (default 300). With no window or process it watches all
top-level windows and the foreground window. If the UI is still changing at
`--timeout` (default 10 s), it prints `NOT settled` and exits with code 1.

### Errors

Failures print an error code:

| code | meaning |
|---|---|
| `notfound` | no element matched |
| `timeout` | the element did not appear (or, with `--gone`, did not go) in time |
| `covered` | another window covers the point winvm would click |
| `bad` | the request was invalid |
| `unavailable` | the guest has no UI helper |
| `fail` | anything else |

### In jobs

A `shell: winvm` step runs winvm commands on the host against the job's
instance (see [CI jobs](jobs.md)):

```yaml
  - name: Quit Maximal from the tray menu and confirm
    shell: winvm
    run: |
      ui tray Maximal --menu "Quit Maximal"
      ui click --process maximal-shell --window "Quit Maximal?" --name "Quit Maximal" --type Button --settle 200
      ui wait --process maximal-shell --gone --timeout 30
```

`jobs/maximal/nsis.yml` is a full example. It opens Settings from the tray
menu, quits from the tray menu, and checks that no processes are left.

### From TypeScript (`ui.ts`)

```ts
import { forInstance } from "./ui"
const ui = await forInstance(name)        // ensures the agent and an up-to-date helper
await ui.tray("Maximal", { menu: "Settings" })
await ui.wait({ process: "maximal-shell", window: "Settings", name: "Account", controlType: "Text" })
await ui.click({ window: "Settings", name: "Models", controlType: "Hyperlink" }, { settleMs: 200 })
const t = await ui.tree({ process: "maximal-shell" }, { depth: 6 })
// also: find, findAll, invoke, setValue, type, act(action, sel), focus, settle, menu, windows, at, ping
```

Errors are `UiError`, with a `code` from the table above.

### How UI Automation works

`winvm-ui.exe` (`assets/winvm-ui.cs`) is a C# program that uses the UI
Automation library in Windows' built-in .NET Framework. The agent's install
compiles it in the guest, and it runs natively on ARM64. It is DPI-aware, so
its element bounds, mouse coordinates and screenshot pixels all match.

The agent starts the helper on first use and talks to it over stdin and
stdout, one JSON line per request and answer. The agent exposes it as
`POST /ui`. The helper exits when the agent does. It logs every request to
`C:\ProgramData\winvm\agent\winvm-ui.log`. If a window hangs and UI
Automation never answers, the helper returns a `timeout` error.

The helper's first request after it starts takes a few hundred milliseconds
longer. `forInstance` spends that time on a `ping`. If the guest's helper is
older than the host expects (`UI_HELPER_VERSION` in `ui.ts`), `forInstance`
reinstalls the agent, which takes a few seconds. Goldens made before a helper
change therefore upgrade themselves on first use.

### Known problems

- **WebView2 builds its accessibility tree on the first query.** The first
  `find` into a new WebView2 window can miss. Use `wait`, or give `find` a
  `--timeout`.
- **Notifications are invisible to UI Automation but still catch clicks.** A
  notification that slides up over the tray does not appear in the element
  tree. This is why winvm checks for a covering window before each click.
  `ui at x y` shows both what UI Automation sees and which window would get
  the click.
- **A Windows Firewall prompt blocks clicks.** The "allow this app" prompt
  does not appear in the element tree, and clicks on the window under it do
  nothing. The agent's install turns these prompts off. If an app still
  triggers one, allow the program in an earlier step.
- **The tray's overflow flyout stays in the tree after it closes.** It is
  hidden, not removed, so `tray` checks whether it is really visible. An open
  flyout can also end up behind a window that its menu opened, so `tray`
  closes it afterwards and reopens it if its icon is covered.
- Maximal's title-bar Close button hides Settings to the tray; the process
  keeps running. `wait --gone` with only a window or process waits for the
  window to leave the tree.

## DevTools for WebView2 (`winvm webview`)

```sh
winvm webview enable maximal-shell.exe          # once; then start or restart the app
winvm webview targets
winvm webview eval 'document.title' --target /ui/settings
winvm webview wait 'nav.sidebar a[href="#apps"]' --visible --timeout 30
winvm webview click 'nav.sidebar a[href="#apps"]'
winvm webview text 'h2.section__title' --expect Account
winvm webview disable maximal-shell.exe
```

`enable` takes the program's file name, not a path. It only affects the app
the next time it starts.

- `--target <text>`: use the page whose URL or title contains the text. The
  default is the first page.
- `--timeout <s>`: how long to wait for the app's DevTools port, the page and
  the element. The default is 10 seconds, so a command can run right after
  the app is launched.
- `eval` waits for promises and prints the result as JSON (strings are
  printed as is). If the script throws, `eval` exits with code 1, so you can
  use it to assert.
- `click` scrolls the element into view and sends a real mouse click at its
  centre.
- `wait --visible` waits until the element also has a size on screen.
- `text --expect <text>` fails unless the element's text contains it (any
  case).
- `--port <n>`: the DevTools port in the guest. The default is the last one
  you enabled, else 9222.

From TypeScript, `webview.session(name, match)` returns a `CdpSession` with
`eval`, `waitFor`, `text`, `click`, and `send(method, params)` for raw
DevTools calls.

### How the DevTools port is reached

1. **A policy turns the port on.** WebView2 opens a DevTools port only when
   its browser arguments ask for one. Tauri ignores the
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable, so `enable`
   sets the machine policy
   `HKLM\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments`.
   The value name is the program's file name and the data is
   `--remote-debugging-port=9222`. WebView2 reads it when the app starts.
2. **A relay in the guest exposes it.** WebView2 listens on 127.0.0.1 only,
   and QEMU's forwards arrive on the guest's network address, not loopback. A
   Windows port proxy relays `0.0.0.0:19222` (the port plus 10000) to
   `127.0.0.1:9222`. A firewall rule allows only the host (10.0.2.2).
3. **A forward connects the host.** winvm forwards a host port to the relay at
   runtime with `hostfwd_add`, for the same reason as the agent's forward
   (see [agent.md](agent.md#connection)). Every command checks the forward and
   adds it again if a new QEMU process lost it. The host port is stored in
   `<instance>/webview.json`.

Steps 1 and 2 are stored in the guest, so a save or golden taken after
`enable` keeps them. `disable` removes them.

## OCR (`winvm ocr`)

```sh
winvm ocr                                  # every line of text: x,y wxh  confidence  text
winvm ocr --find "MCP servers" --wait 20   # exit 1 if it is not on screen within 20 s
winvm ocr --image shot.png --json          # any image; JSON includes each box's centre
winvm click --text Cancel                  # find the text, then click its centre
```

winvm takes a screenshot through QEMU and reads it with macOS Vision. The
positions are screenshot pixels, the same coordinates `winvm click x y`
takes.

The default is accurate recognition. `--fast` is about five times faster but
less accurate on small text.

Matching ignores case and accents. A line that is exactly the text wins over
a line that contains it. If several lines match equally, the top one wins,
then the leftmost. A match inside a longer line gets its own box, so
`click --text Quit` on the line "Quit Maximal" clicks the word "Quit".

The OCR helper is `assets/ocr.swift`. winvm compiles it with `swiftc` the
first time you use OCR and caches it in `$WINVM_HOME/cache/bin/`. It is
rebuilt only when its source changes.

## Notifications (`winvm toasts`)

```sh
winvm toasts                                         # every notification still on record
winvm toasts --app maximal --find "Sign in" --since 10m --wait 30
winvm toasts --json
```

- `--app <text>`: the app's ID contains the text.
- `--find <text>`: the title or body contains the text.
- `--since <time>`: an ISO time, or an age such as `90s`, `5m` or `2h`.
- `--wait <s>`: keep checking until a notification matches.

With any filter, the command exits with code 1 if nothing matches.

Windows keeps a notification in its record until it is dismissed or expires,
which can take days. To check that something happened just now, use
`--since`. Times use the guest's clock, which winvm keeps in sync with the
host.

The image turns notification pop-ups and the notification centre off.
Windows still records every notification, so this check is reliable where
OCR of a pop-up would race its animation.

How it works: Windows records notifications in the user's database,
`%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db` (SQLite). The
agent runs as that user and copies the database files to the host, where
winvm reads them with `bun:sqlite`.

## Using these in jobs

A `shell: winvm` step runs each line of `run` as a winvm command on the host,
against the job's instance. Quotes work as in a POSIX shell, with no variable
expansion. The step fails at the first line that exits with an error. See
[CI jobs](jobs.md).

```yaml
  - name: Settings over DevTools
    shell: winvm
    run: |
      webview wait 'nav.sidebar a[href="#apps"]' --visible --target /ui/settings --timeout 60
      webview text 'h2.section__title' --expect Account
      toasts --app co.stuffbucket.maximal --find "Sign in to GitHub" --since 10m --wait 30
      ocr --find Diagnostics
```

`jobs/maximal/settings-ui.yml` is a full example. It installs Maximal, runs
`webview enable`, starts the app, reads and clicks Settings over DevTools,
checks the start-up notification, and reads Settings with OCR.

### Notes on Maximal

- A fresh install with no account shows a "Sign in to GitHub" notification
  at start and opens Settings on the Account section. Launching
  `maximal-shell.exe` a second time focuses or opens Settings.
- The "Maximal is working" notification needs a signed-in Copilot account,
  which a CI guest does not have. The job does not fail if it is missing.
