# Claude and the guest

Claude can see the guest's screen, use its mouse and keyboard, and run
commands in Windows. There are three ways to set this up:

- **Claude Code and Claude Desktop** (`winvm mcp`): add winvm as an MCP
  server once, then ask Claude in a normal conversation.
- `winvm cua run` runs a complete computer-use agent loop for one task.
- `winvm cua serve` starts a local HTTP endpoint for your own agent loop.

Nothing opens a window on the Mac. Screenshots and input go through QEMU's
monitor; commands and files go through the [in-guest agent](agent.md).

## Claude Code and Claude Desktop

**Use local MCP, not the CUA HTTP address.** `winvm mcp` speaks JSON-RPC 2.0
with newline-delimited UTF-8 messages over stdin/stdout. Claude Desktop
launches the server as a local subprocess on the Mac; no listening port or
CUA bearer token is needed. The HTTP endpoint under **Other agents** is a
different protocol for custom agent code, not an MCP connector URL.

In the app, choose **Use with Claude** in the toolbar and click **Add** next
to Claude Code or Claude Desktop. From a terminal:

```sh
winvm mcp install claude-code -i demo       # claude mcp add -s user winvm-demo -- <winvm> mcp -i demo
winvm mcp install claude-desktop -i demo    # edits Claude Desktop's settings; restart Claude Desktop
winvm mcp status -i demo                    # which of the two have it
winvm mcp uninstall claude-code -i demo     # or claude-desktop
```

Each instance becomes a server named `winvm-<instance>`. Then ask, for
example: "Take a screenshot of Windows and tell me what's open", or "In
Windows, install the latest Git and show me `git --version`".

What `install` writes:

- **Claude Code**: it runs `claude mcp add -s user winvm-<instance> --
  <winvm> mcp -i <instance>`, so the server is there in every project. Claude
  Code keeps it in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`).
  `install` finds `claude` on `PATH` or where its installers put it
  (`~/.local/bin`, `~/.claude/local`, Homebrew); `WINVM_CLAUDE` names it
  directly.
- **Claude Desktop**: it adds the server to `mcpServers` in
  `~/Library/Application Support/Claude/claude_desktop_config.json`. It
  backs the file up first, next to it, as
  `claude_desktop_config.json.winvm-backup-<time>`, keeps every other
  setting, and replaces the file in one step. Quit and reopen Claude Desktop
  to pick it up.

`<winvm>` is the app's own CLI,
`/Applications/winvm.app/Contents/MacOS/winvm`, when the app (or the
`winvm` link it installs) runs `install`. Otherwise it is the full path of
the CLI that ran it; from a source checkout, Bun and the script. If
`WINVM_HOME` or `WINVM_RUNTIME` is set, it goes into the entry too.
Running `install` again does nothing when the entry is already right, and
updates it when winvm has moved. `--json` prints the result as JSON.

To start the server by hand, for another MCP client:

```sh
winvm mcp -i demo     # MCP over stdio; logs go to stderr
```

### Why a Claude Desktop URL connector cannot reach it

Claude Desktop's **remote/custom connectors** connect from Anthropic's cloud,
not from the Mac, even when the Desktop app is local. `127.0.0.1` in that
context is not the Mac's loopback interface. winvm's CUA server deliberately
listens only on the Mac's loopback interface. There is also a protocol
mismatch: it is HTTP + JSON, not MCP over Streamable HTTP. A tunnel alone
would not make it an MCP server.

Use the local MCP integration above for a normal Claude Desktop chat. An
agent running inside a separate VM or container is another network context;
do not assume its `localhost` reaches the Mac either. Nothing here changes
the HTTP bind address or exposes control of Windows to the network.

References:

- [Claude: custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
  explains where remote connections originate and distinguishes local MCP.
- [MCP: connect local servers](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers)
  covers Claude Desktop's local server configuration and restart steps.
- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
  defines stdio and Streamable HTTP; a REST endpoint is not automatically MCP.

### The tools

Every tool takes an optional `instance`. Without it, a tool uses the
instance the server was started for (`-i`, else `WINVM_INSTANCE`, else
`default`). When that instance isn't running, the tool says so ("Instance
demo isn't running; start it with winvm start -i demo") and the server stays
up.

| tool | what it does |
|---|---|
| `screenshot` | the screen as a PNG, scaled down to fit 1280x800, with the scale |
| `click`, `double_click`, `right_click` `{x, y, modifiers?}` | click at a point in the screenshot's pixels |
| `move {x, y}` | move the pointer |
| `drag {x, y, to_x, to_y}` | press, move, release |
| `scroll {direction, amount?, x?, y?}` | the mouse wheel; left and right too |
| `type {text}` | type text; US layout, ASCII only |
| `key {keys, repeat?}` | a key or combination: `Return`, `ctrl+s`, `win+r`, `ctrl-alt-delete` |
| `find_and_click {name \| nameContains \| automationId, window?, controlType?, button?}` | click a control by its accessible name (UI Automation) |
| `find_text {text, wait?}` | find text on the screen by OCR; returns where to click |
| `run {command, shell?, timeout_seconds?, cwd?}` | run a command in Windows as the logged-on user; `powershell` (default), `pwsh` or `cmd`; returns the exit code and output |
| `list_files {path?, hidden?}` | a Windows folder (default the Desktop) |
| `copy_to_windows {mac_path, windows_path}` | copy a file or folder from the Mac into Windows |
| `copy_from_windows {windows_path, mac_path}` | copy a file or folder from Windows to the Mac |
| `status` | running or not, screen and screenshot size, Windows version |

Screen tools use the same executor and coordinates as `cua` below. `run`,
`list_files` and the copies use the in-guest agent, which winvm installs on
first use if the guest has none (that first call takes a few seconds more).
Each `run` starts a new PowerShell, which takes about 3 seconds.

The copies read and write any path your user can on the Mac, and `run` can
do anything in Windows. Claude Code and Claude Desktop ask before each tool
call unless you allow it.

## Computer use (`winvm cua`)

`winvm cua` lets Claude operate the guest's desktop with its computer-use
tool from your own code or a one-off task.

## Run a task: `winvm cua run`

```sh
winvm cua run -i ui "Open Notepad, type 'hello from winvm', and save it to C:\\work\\hello.txt"
```

Options:

| flag | default | meaning |
|---|---|---|
| `--model M` | `claude-opus-5-5` | the model |
| `--max-steps N` | 40 | stop after this many model calls |
| `--effort E` | `medium` | `low`, `medium`, `high`, `xhigh` or `max` |
| `--size WxH` | `1280x800` | the largest screenshot size sent to the model (see [Coordinates](#coordinates)) |
| `--extras` | off | also offer the [extra tools](#extra-tools) |
| `--shots DIR` | none | save every screenshot to DIR |
| `--base-url URL` | | send requests to this Anthropic-compatible endpoint |

Where requests go:

- If `ANTHROPIC_API_KEY` is set and there is no `--base-url`: the Anthropic
  API (or `ANTHROPIC_BASE_URL`).
- Otherwise: `--base-url`, or Maximal on the host at `http://localhost:4141`.

At the end, `cua run` prints the median latencies and the total tokens used.

## Your own loop: `winvm cua serve`

```sh
winvm cua serve -i ui [--port N] [--size WxH]    # also: winvm cua-serve
```

In the app, **Use with Claude** > **Other agents** starts and stops it and
shows the address and token.

This is a custom **HTTP + JSON request/response API**, not MCP, an Anthropic
Messages API endpoint, a WebSocket, or an SSE stream. It runs on the Mac
host, not inside Windows. Your agent code owns the model/tool loop and
forwards computer actions to these routes.

The server listens on `127.0.0.1` only, over plain HTTP, with no bind-address
option. By default `--port` is `0`, so the OS chooses a free port; the app
also uses that default. Read the printed address rather than assuming a
fixed port. `--port 8765` requests a fixed one.

It prints a fresh random bearer token for each server run and writes the
token, URL and process ID to `<instance>/cua.json` (mode 0600). The file is
removed when the server stops. Every request must send
`Authorization: Bearer <token>`; this is not OAuth. Requests run one at a
time, in the order they arrive.

For example, with an existing, running instance named `dev-cua`:

```sh
winvm cua serve -i dev-cua --port 8765
```

In another terminal, set `CUA_TOKEN` to the token the server printed, then:

```sh
curl --fail-with-body http://127.0.0.1:8765/v1/info \
  -H "Authorization: Bearer $CUA_TOKEN"

curl --fail-with-body http://127.0.0.1:8765/v1/computer \
  -H "Authorization: Bearer $CUA_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"action":"screenshot"}'
```

The screenshot response contains a base64-encoded PNG in its `content` blocks.
Do not share the token: it authorizes screen capture and input to Windows.

| route | body | answer |
|---|---|---|
| `GET /v1/info` | | screen size, screenshot size, scale, the action names, and the tool entry to declare |
| `POST /v1/computer` | `{"action": "left_click", "coordinate": [x, y]}` | `{"content": [...], "is_error": bool, "ms": {...}}` |
| `GET /v1/extra` | | `{"tools": [...]}`: definitions for the extra tools |
| `POST /v1/extra` | `{"action": "ui_find" \| "ui_click" \| "ocr_find", ...}` | same as `/v1/computer` |

Put `content` into your `tool_result` unchanged. Action-level errors generally
come back with HTTP 200 and `is_error: true`; check that field as well as the
HTTP status. Malformed or non-object JSON returns HTTP 400, missing or invalid
authorization returns 401, unknown routes return 404, and uncaught execution
errors return 500.

`/v1/info` returns the tool entry for the computer toolset
(`computer_toolset_20260801`) as `tool`, and an entry for the earlier
`computer_20251124` tool, with the display size, as `legacy_tool`.

## What Claude can do

`cua run` declares the computer toolset, `computer_toolset_20260801`.
Claude's tool calls name the action (`screenshot`, `left_click`, `type`, and
so on), and every `tool_result` must include `"toolset_name": "computer"`.
The server also accepts the earlier tool's `{"action": "...", ...}` form.

All 17 actions are supported:

| action | what winvm does |
|---|---|
| `screenshot` | takes a screenshot, scaled down to fit the size limit, as PNG |
| `zoom {region}` | the region at full resolution, scaled to the screenshot size |
| `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click` `{coordinate?, text?}` | moves the pointer and clicks; `text` lists modifier keys to hold |
| `left_click_drag {start_coordinate, coordinate}` | press, move in 8 steps, release |
| `mouse_move`, `left_mouse_down`, `left_mouse_up` | |
| `cursor_position` | the last position winvm moved the pointer to (QEMU cannot report it) |
| `scroll {scroll_direction, scroll_amount, coordinate?}` | wheel steps; left and right are sent as shift + wheel |
| `type {text}` | types the text on a US keyboard layout; non-ASCII characters return an error |
| `key {text, repeat?}`, `hold_key {text, duration}` | xdotool key names |
| `wait {duration}` | |

### Coordinates

Claude gives coordinates in the pixels of the screenshots it receives. winvm
scales each screenshot down to fit within `--size` (default 1280x800, at
most 2576 on a side) and scales coordinates back up before clicking. For
example, a 1920x1080 screen is sent at 1280x720. The default 800x600 screen
is sent unscaled.

Positions from the extra tools use the same scaled coordinates.

### Keys

Key names follow xdotool: `Return`, `ctrl+s`, `alt+Tab`, `super` (the
Windows key), `Page_Down`, `Prior`, `Next`, `BackSpace`, `KP_Enter`,
`F1`-`F12`, `XF86AudioMute`, shifted punctuation by name (`plus`, `exclam`,
`question`), and single characters. Case does not matter: `ctrl+S` is the
same as `ctrl+s`.

### Extra tools

These are optional custom tools a loop can declare next to the toolset:

- `ui_find` and `ui_click`: find or click an element by name, AutomationId,
  control type or window, using UI Automation (see [Driving app UI](gui.md)).
  They need the in-guest agent, which winvm installs on first use if needed.
- `ocr_find`: find text on the screen with macOS Vision.

## How fast it is

Measured 2026-10-22 on `win11-arm64-v4` with a 1920x1080 screen sent at
1280x720, on an M-series Mac. Medians of 20 runs:

| action | time |
|---|---|
| `screenshot` | 39 ms |
| `zoom` | 25 ms |
| `left_click` | 155 ms |
| `key` (one key) | 127 ms |
| `scroll` (one step) | 65 ms |
| `type` | about 64 ms per character |

Clicks and key presses are slow on purpose: winvm pauses between press and
release so the guest's USB input picks them up.

The example task above, run through Maximal with `claude-opus-5-5` at medium
effort, finished in 5 model calls and 18 actions, using about 37,500 input
and 750 output tokens. Most model calls took about 2 seconds.

## For developers

- `mcp.ts` is the MCP server: JSON-RPC 2.0 over stdio, written by hand
  (initialize, ping, tools/list, tools/call), with the tools on top of
  `cua.ts`, `cuacmds.ts`'s extras and the agent. While it runs,
  `console.log` goes to stderr, so stdout carries protocol messages only.
  State for an instance is dropped when its QEMU process changes.
- `mcpcmds.ts` has `mcp install`, `uninstall` and `status`.
- `run` wraps PowerShell commands so errors come back as text: with
  `-EncodedCommand` and redirected output, Windows PowerShell writes them as
  CLIXML.

- `cua.ts` executes actions. It turns them into QMP screendumps and
  `input-send-event` calls on the USB tablet and keyboard, as `input.ts`
  does.
- `cuacmds.ts` has the `serve` HTTP server and the `run` loop. The loop uses
  `@anthropic-ai/sdk`, which is loaded only by `cua run`.
- `cua run` sends Claude's previous responses back unchanged, including
  thinking blocks, and does not remove old screenshots, since removing them
  would invalidate later thinking blocks.
- When Claude sends several actions in one turn, they run in order. If one
  fails, the rest are answered with "Not executed: an earlier computer action
  in this turn failed."
- When talking to the Anthropic API directly, `cua run` turns on the
  server-side fallback for refusals.
