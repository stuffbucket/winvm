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
