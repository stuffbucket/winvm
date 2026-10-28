# Claude computer use (`winvm cua`)

`winvm cua` lets Claude operate the guest's desktop with its computer-use
tool. Claude sees screenshots of the guest and sends clicks and key presses
back. There are two ways to use it:

- `winvm cua run` runs a complete agent loop for one task.
- `winvm cua serve` starts a local HTTP endpoint for your own agent loop.

Nothing opens a window on the Mac. Screenshots and input go through QEMU's
monitor.

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

The server listens on 127.0.0.1 only. It prints a random bearer token, and
writes the token, URL and process ID to `<instance>/cua.json` (mode 0600).
The file is removed when the server stops. Every request must send
`Authorization: Bearer <token>`. Requests run one at a time, in the order
they arrive.

| route | body | answer |
|---|---|---|
| `GET /v1/info` | | screen size, screenshot size, scale, the action names, and the tool entry to declare |
| `POST /v1/computer` | `{"action": "left_click", "coordinate": [x, y]}` | `{"content": [...], "is_error": bool, "ms": {...}}` |
| `GET /v1/extra` | | `{"tools": [...]}`: definitions for the extra tools |
| `POST /v1/extra` | `{"action": "ui_find" \| "ui_click" \| "ocr_find", ...}` | same as `/v1/computer` |

Put `content` into your `tool_result` unchanged. Invalid input comes back as
a result with `is_error: true`, not as an HTTP error.

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
