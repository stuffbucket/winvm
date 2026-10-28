---
name: winvm-gui
description: Use to see and operate the screen of a winvm Windows machine - take screenshots, click, type, press keys, find and click controls by name with UI Automation (winvm ui), read WebView2 pages over DevTools (winvm webview), read text with OCR, check notifications (winvm toasts), run Claude computer use (winvm cua), or connect Claude Code or Claude Desktop to Windows as an MCP server (winvm mcp).
---

# Driving the screen

Read the winvm skill first. Every command takes `-i NAME`; the machine must be
running and not paused. Nothing opens on the Mac.

## Pick the tool

1. **UI Automation** (`winvm ui`): click things by name. Most reliable; needs the agent.
2. **DevTools** (`winvm webview`): inside WebView2 apps (Tauri, WinUI, WPF web content).
3. **OCR** (`winvm ocr`, `click --text`): any text in the pixels.
4. **Coordinates** (`click X Y`): last resort, from a fresh screenshot.

Look before and after acting: `winvm screenshot -i NAME` prints a PNG path; open
the image. Input goes to whatever has focus.

## Screen and input

```sh
winvm screenshot -i NAME [shot.png]       # default: $WINVM_HOME/instances/NAME/screenshots/
winvm click  -i NAME 412 300 [--right|--middle] [--double]   # screenshot pixels
winvm click  -i NAME --text "Cancel" [--wait 10]             # OCR, then click its centre
winvm move   -i NAME 412 300
winvm scroll -i NAME 5                    # positive is down; or: up 3 / down 3
winvm type   -i NAME "hello"              # US layout, ASCII; a newline presses Enter
winvm key    -i NAME win-r                # ctrl-alt-delete, alt-f4, enter, f5, ctrl-shift-esc ...
winvm open   -i NAME [--web]              # let the user watch
```

## UI Automation

```sh
winvm ui -i NAME windows                                  # top-level windows and processes
winvm ui -i NAME tree --process notepad --depth 6
winvm ui -i NAME find --window Settings --name Models --type Hyperlink
winvm ui -i NAME wait --process app --name Ready --type Text --timeout 30
winvm ui -i NAME click --window Settings --id Close --settle 300
winvm ui -i NAME set --name Search --type Edit --value hello
winvm ui -i NAME tray Maximal --menu Settings             # tray icon by tooltip, then a menu item
winvm ui -i NAME wait --process app --gone --timeout 30
winvm ui -i NAME help                                     # every verb
```

- Window: `--window TEXT` (title contains, or class), `--process NAME`, `--hwnd N`.
  Element: `--name` (exact, any case), `--contains`, `--id` (AutomationId),
  `--type` (Button, Edit, MenuItem, Text, Hyperlink, ...), `--class`, `--index`.
- Other verbs: `rightclick`, `doubleclick`, `invoke`, `toggle`, `expand`, `collapse`,
  `select`, `focus`, `type`, `menu ITEM`, `settle`, `at X Y`, `ping`.
- Errors print a code: `notfound`, `timeout`, `covered` (another window is on top),
  `bad`, `unavailable`, `fail`; exit 1.
- WebView2 builds its tree on first query: use `wait` or `find --timeout`.

## WebView2 over DevTools

```sh
winvm webview -i NAME enable app.exe        # once, then (re)start the app
winvm webview -i NAME targets
winvm webview -i NAME eval 'document.title' [--target /settings]
winvm webview -i NAME wait 'nav a[href="#apps"]' --visible --timeout 30
winvm webview -i NAME click 'nav a[href="#apps"]'
winvm webview -i NAME text 'h2' --expect Account     # exit 1 unless it contains the text
winvm webview -i NAME disable app.exe
```

## OCR and notifications

```sh
winvm ocr -i NAME [--json]                          # every line with its box
winvm ocr -i NAME --find "Saved" --wait 20          # exit 1 if not there in time; --fast is ~5x quicker
winvm toasts -i NAME --app myapp --find "Done" --since 5m --wait 30 [--json]
```

OCR needs Xcode's command-line tools (`swiftc`) on the Mac.

## Computer use and MCP

```sh
winvm cua run -i NAME "Open Notepad and type hello" [--model M] [--max-steps 40] [--effort medium] [--extras] [--shots DIR]
winvm cua serve -i NAME [--port N] [--size 1280x800]      # endpoint for your own loop; prints URL and token
winvm mcp install claude-code -i NAME     # adds server winvm-NAME for Claude Code (ask first)
winvm mcp install claude-desktop -i NAME  # edits Claude Desktop's config (backed up); restart Desktop
winvm mcp status -i NAME [--json]
winvm mcp uninstall claude-code -i NAME
```

`cua run` uses `ANTHROPIC_API_KEY` if set, else `--base-url`, else Maximal on
`localhost:4141`. MCP tools: `screenshot`, `click`, `double_click`, `right_click`,
`move`, `drag`, `scroll`, `type`, `key`, `find_and_click`, `find_text`, `run`,
`list_files`, `copy_to_windows`, `copy_from_windows`, `status`; each takes an
optional `instance`. Claude Desktop reaches Windows only through these tools.
