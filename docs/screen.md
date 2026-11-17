# The screen

## Looking at it

- `winvm open` opens the screen in macOS Screen Sharing.
- `winvm open --web` opens it in the browser, with the instance's status and
  buttons for start, stop, pause, resume, save, load, stow and sending keys. Each button runs the
  matching `winvm` command. The page is served by `winvm web`, which
  `open --web` starts in the background. `winvm web --stop` stops it.
  `WINVM_WEB_PORT` changes its port.
- The winvm app shows the screen in its window.

`winvm status` summarizes an instance: running or not,
uptime, Windows version, whether the guest agent answers, clock offset, disk
use, saves and the idle watcher. With several instances and no `-i`, it prints
a table. `--json` is for scripts.

### Passwords

QEMU's VNC server has a password, because Screen Sharing won't connect to one
without. winvm creates a random password for each instance, stores it in
`<instance>/vncpassword`, sets it when QEMU starts, and puts it in the URL it
opens, so nothing asks for it. `winvm open --print` prints that URL for another VNC client.

The browser view listens only on 127.0.0.1 and needs a token that changes
each time the server starts. `open --web` puts the token in the URL, so other
web pages can't reach the VM.

## Clarity and motion

New QEMU processes use **lossless VNC**, including the websocket used by the app
and browser. Text should not acquire JPEG artifacts when a window moves or a
page scrolls. A client asking for its highest JPEG quality is not equivalent:
QEMU's Tight quality 9 is still lossy. The viewers request it only as a
best-effort fallback for a QEMU process started with the older `lossy=on` policy.

The policy takes effect when **QEMU next starts**, not when a viewer reconnects
or Windows reboots inside the same QEMU process. Stop/start or stow/start applies
it. It does not change the virtual GPU, base image or RAM-save compatibility;
there is no need to rebuild Windows or discard saves.

Encoding and scaling are separate. The app requests a guest resolution sized
for the window's backing pixels, and changes Windows' display scaling for its
pixel density. If the guest cannot resize, or the requested framebuffer exceeds
the driver's 30 MiB limit or VNC's dimension limits, fitting it to the window
still scales the picture. Lossless transport cannot remove that scaling blur.
Older instances using `ramfb` also have a fixed-size display; `virtio-gpu` with
the Windows display driver is needed for live resolution changes.

### Measured tradeoff

A scratch Windows 11 ARM64 instance on an Apple Silicon Mac17,6 was tested on
2026-11-04: 2 vCPUs, 4 GiB, runtime 11.1.2-2 (QEMU 11.1.2), viogpudo 22.7.38.43,
1920×1080 at 100%, and the vendored noVNC in headless Playwright WebKit at DPR 1.
A deterministic WinForms gradient/ClearType test image had either a moving
250-pixel-wide pane or full-screen horizontal scrolling. Each measurement used
a one-second warmup and a six-second sample, with the app's 15 ms VNC wake-up
messages enabled. These are painted VNC updates, not guest render FPS or
end-to-end input latency.

- **Moving pane:** about 29–30 updates/s with either JPEG or lossless Tight.
  Lossless backbuffer pixels matched fresh QMP PNG captures exactly after motion
  stopped. JPEG quality 6 left tens of thousands of differing pixels; quality 9
  did not reliably prevent JPEG in the heavier workload.
- **Full-screen scrolling:** JPEG quality 6 reached 29.2 updates/s at 5.9 MiB/s;
  quality 9 reached 31.0 at 8.9 MiB/s, but still altered text and gradient pixels.
  Lossless Tight reached 16.2 at 7.7 MiB/s and matched the settled source exactly.
  Lossless is the clarity-first default, **not a blanket throughput improvement**.
- Lowering noVNC's compression from 2 to 0 did not improve the lossless update
  rate in either workload. Scrolling traffic rose to 37.5 MiB/s. Compression
  therefore stays at its default, 2. Exploratory TightPNG runs did not establish
  a better replacement, so encoding preference is unchanged.

These small synthetic samples are not a benchmark of video, games, Retina-size
framebuffers, or UTM itself. CPU figures include guest work and do not isolate
VNC encoding cost.

### What differs from UTM

UTM's local QEMU path uses a Unix-socket SPICE connection with image compression
and video streaming disabled, then a native Metal renderer rather than noVNC's
browser canvas. That is a different rendering architecture, not another CPU
virtualization backend: both applications use QEMU with HVF for Windows.

Current UTM also documents a separate **experimental Windows 3D driver**; its
`-gl` device alone does not give our display-only viogpudo driver Direct3D.
The inspected accelerated QEMU path blocks migration (`virgl is not yet
migratable`), so replacing winvm's GPU with it would sacrifice the machine-save
contract as well as change hardware compatibility. A native display transport
is a separate avenue to investigate, not something a VNC quality knob enables.
The bundled 11.1.2-2 runtime rejects `-spice` as an invalid option; adopting SPICE
would require runtime and frontend work, not just changing launch arguments.

Source snapshots: [UTM local SPICE arguments](https://github.com/utmapp/UTM/blob/a6e0c06957ab5a32b960499ba3a286c37852e37a/Configuration/UTMQemuConfiguration%2BArguments.swift#L186-L217),
[UTM Metal renderer](https://github.com/utmapp/UTM/blob/a6e0c06957ab5a32b960499ba3a286c37852e37a/Platform/macOS/Display/VMDisplayQemuMetalWindowController.swift#L83-L105),
[experimental Windows 3D requirements](https://github.com/utmapp/docs.getutm.app/blob/4cf17c9569dcb616b9d7f156a103cc8a19027fe6/guest-support/windows.md#L40-L62),
and [migration blocker in UTM's QEMU fork](https://github.com/utmapp/qemu/blob/2934963d1778e4d74ac2f667820cf81c914ff0f5/hw/display/virtio-gpu-base.c#L192-L196).

## Driving it from a script

These commands need no window. They go through QEMU's monitor, so
coordinates are exact. Input goes wherever Windows has focus, so take a
screenshot first.

```sh
winvm screenshot              # saves a PNG and prints its path
winvm screenshot shot.png
winvm click 412 300           # screenshot pixels; --right, --middle, --double
winvm click --text "Cancel"   # find text on screen and click it
winvm move 412 300
winvm scroll 5                # positive is down
winvm key win-r               # also ctrl-alt-delete, alt-f4, enter, f5, ...
winvm type "notepad"          # US layout; a newline presses Enter
winvm ocr                     # the text on screen, with positions
```

To find and click controls by name instead of position, read a WebView2
page, or list notifications, see [Driving app UI](gui.md):

```sh
winvm ui tray Maximal --menu Settings
winvm ui click --window Settings --name Models
winvm webview text 'h2.section__title' --target /ui/settings
winvm toasts --app maximal --since 10m
```

To let Claude drive the guest, see [Claude computer use](cua.md):

```sh
winvm cua run -i ui "Open Notepad, type 'hello', and save it to C:\\work\\hello.txt"
winvm cua serve -i ui         # an endpoint for your own agent; prints the URL and token
```
