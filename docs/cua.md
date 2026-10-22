# Claude computer use (`winvm cua`)

`cua.ts` executes Claude's computer-use tool against a guest; `cuacmds.ts`
serves it over HTTP (`cua serve`) and runs a small agent loop with it
(`cua run`). Nothing opens a window on the host: screenshots are QMP
screendumps and input is QMP `input-send-event` on the USB tablet and
keyboard, as in `input.ts`.

## Which tool version

The current tool is the **computer toolset**, `computer_toolset_20260801`:
one `tools` entry `{"type": "computer_toolset_20260801"}` with no name, no
display size and no beta header. Claude's calls arrive as `tool_use` blocks
whose `name` is the member (`screenshot`, `left_click`, `type`, `zoom`, ...)
with `"toolset_name": "computer"`, often several per turn (a batch, run in
order); every `tool_result` must echo `"toolset_name": "computer"`. Claude
Opus 5.5 / Sonnet 5.5 / Haiku 5.5 on the Claude API accept only the toolset;
the earlier `computer_20251124` tool (beta header, `display_width_px`,
`input.action`) 400s there. `cua run` sends the toolset.

The executor takes both shapes: a member name plus its input, or
`{"action": "...", ...}` (the earlier tool's shape, and the server's wire
format). All 17 members are implemented:

| member | how |
|---|---|
| `screenshot` | screendump, scaled to fit the box (below), PNG |
| `zoom {region}` | the region at full resolution, fitted to the screenshot size |
| `left_click` `right_click` `middle_click` `double_click` `triple_click` `{coordinate?, text?}` | tablet move + button events; `text` = modifiers held for the click |
| `left_click_drag {start_coordinate, coordinate}` | press, 8 intermediate moves, release |
| `mouse_move`, `left_mouse_down`, `left_mouse_up` | |
| `cursor_position` | the last position this executor moved to (QMP can't report it) |
| `scroll {scroll_direction, scroll_amount, coordinate?}` | wheel notches; left/right is shift+wheel (the USB tablet has no horizontal wheel) |
| `type {text}` | US-layout key strokes; non-ASCII is refused with an error |
| `key {text, repeat?}`, `hold_key {text, duration}` | xdotool keysym names -> QMP qcodes |
| `wait {duration}` | |

**Coordinates.** The toolset takes no display size: the screenshots you
return *are* the coordinate space, and the API doesn't downscale. Screenshots
are fitted into a box (`--size`, default 1280x800, the docs' recommended
range; the hard limit is 2576 px on the long edge); the scale is
`min(1, boxW/w, boxH/h)` and a coordinate maps back as `x / scale`, clamped.
A 1920x1080 guest is sent at 1280x720; the default 800x600 is sent as is (via
QEMU's own PNG encoder, ~12 ms). UIA bounds and OCR boxes in the extra
actions are converted to the same space.

**Keys.** `Return`, `ctrl+s`, `alt+Tab`, `super` (Windows key), `Page_Down`
/ `Prior` / `Next`, `BackSpace`, `KP_Enter`, `F1`-`F12`, `XF86AudioMute`,
shifted punctuation by keysym (`plus`, `exclam`, `question`), single
characters. Letters ignore case (`ctrl+S` is ctrl+s), as in xdotool.

## `winvm cua serve`

```sh
winvm cua serve -i ui [--port N] [--size WxH]    # also: winvm cua-serve
```

Binds 127.0.0.1 only. A random bearer token is printed and written, with the
URL and pid, to `<instance>/cua.json` (mode 0600), which is removed on
SIGINT/SIGTERM. Requests run one at a time in arrival order.

| route | body | answer |
|---|---|---|
| `GET /v1/info` | | `native`, `scale`, `size`, `actions`, the `tool` entry to declare (and `legacy_tool` with display size for `computer_20251124`) |
| `POST /v1/computer` | `{"action": "left_click", "coordinate": [x, y]}` | `{"content": [...], "is_error": bool, "ms": {...}}` |
| `GET /v1/extra` | | `{"tools": [...]}`: custom tool definitions for the extras |
| `POST /v1/extra` | `{"action": "ui_find" \| "ui_click" \| "ocr_find", ...}` | same shape as `/v1/computer` |

`content` goes into the `tool_result` unchanged. Bad input is an `is_error`
result, not an HTTP error.

The extras are non-standard tools a harness can declare beside the toolset:
`ui_find` / `ui_click` (UI Automation by name, automationId, control type,
window; needs the in-guest agent, installed on first use, ~10 s) and
`ocr_find` (macOS Vision). Their coordinates are screenshot coordinates.

## `winvm cua run`

```sh
winvm cua run -i ui "Open Notepad, type 'hello from winvm', and save it to C:\\work\\hello.txt" \
  [--model claude-opus-5-5] [--max-steps 40] [--effort medium] [--size WxH] [--extras] [--shots DIR] [--base-url URL]
```

A manual tool-use loop on `@anthropic-ai/sdk` (loaded only by this verb).
API access: `ANTHROPIC_API_KEY` if set (Anthropic's API, with the server-side
refusal fallback on); otherwise Maximal at `http://localhost:4141`
(Anthropic-compatible, the toolset passes through), or `--base-url`. Default
model `claude-opus-5-5` (Opus 5.5 via Maximal; the toolset is also supported
on Sonnet 5.5 and Haiku 5.5). The assistant's content goes back unchanged
(thinking blocks included) and screenshots are not pruned client-side —
on the 5.5 models pruning invalidates later thinking blocks. A batch stops at
its first failed action and the rest are answered "Not executed: an earlier
computer action in this turn failed.", as the docs require. `--shots` saves
every screenshot; at the end it prints median latencies and token totals.

## Numbers

Measured 2026-10-22 on `win11-arm64-v4` at 1920x1080 (virtio-gpu), sent at
1280x720, M-series host.

Executor, 20 runs each (median / p90 ms):

| action | median | p90 |
|---|---|---|
| `screenshot` total | **38.7** | 45.5 |
| — capture (QMP screendump, raw PPM) | 20.1 | 25.5 |
| — scale 1920x1080 -> 1280x720 + PNG encode | 18.6 | 19.8 |
| `zoom` (crop, upscale, encode) | 25.3 | 26.9 |
| `mouse_move` | 1.5 | 1.6 |
| `left_click` (move, settle, press, release) | 154.7 | 155.3 |
| `key` (one key) | 126.5 | 128.4 |
| `scroll` (one notch) | 64.7 | 66.3 |
| `type` (10 characters) | 643 | |

Clicks and keys are dominated by the deliberate press/release gaps
(input.ts's `GAP_MS`, 30 ms, which the USB HID poll needs); typing is ~64 ms
a character. The PNG is 150-750 KB depending on the screen (the default
wallpaper is the worst case).

End to end, `cua run` through Maximal with `claude-opus-5-5`, effort medium,
task "Open Notepad, type 'hello from winvm', and save it to
C:\work\hello.txt": **done in 5 model calls**, 18 actions (Win+R, type, Enter,
click, type, Ctrl+S, triple-click the file name, Ctrl+A, type the path, Enter,
plus waits and screenshots); model calls median 2.2 s (8.5 s for the final
summary), 37.5k input / 750 output tokens; the file was verified over the
agent (`hello from winvm`, 16 bytes).
