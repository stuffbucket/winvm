# The winvm window

One window shows one Windows machine (see *Words* below). It follows the
rest of these rules, which come from maximal v0.4.48's `docs/design/` and
apply here unchanged except where this page says otherwise.

## Words

The CLI and the code say *instance* and *image*; the app never does. A
person asked "instance of what?", so in every UI string:

| In the code | In the app |
|---|---|
| instance | Windows machine, or machine once it is clear ("Windows machines", "New Machine…", "this machine") |
| image (the base disk an instance starts from) | Windows image |

Keep `-i`, `instance` and `image` in the CLI, its help and these docs' code
references; they are the command line's words.

## Layers

Back to front:

0. **The display.** A frame with the guest display's own shape (800 × 600
   for the firmware framebuffer, the configured size for virtio-gpu), as
   large as fits beside the panel. Whatever is in it is about the guest's
   screen: the live screen when Windows is on, otherwise the overview (the
   state, what the machine is, how to start it, what else it does) or the
   start progress. The frame and its size label are what say "Windows'
   screen goes here"; no monitor art.
1. **Docked.** The toolbar, always; callouts above the display; the panel
   when open. They take space and push the display, never cover it.
2. **Floating.** The toolbar's popovers; the Files sheet and the
   confirmation dialog (`<dialog>`, top layer). Nothing else floats.

## Toolbar

The title bar is an overlay (`TitleBarStyle::Overlay`, hidden title), so
the toolbar is the drag region and leaves room for the traffic lights.
Left to right: the machine picker; what is happening, in words; power
(Start or Shut down, Restart, Pause or Resume); things to do in Windows
(Terminal, Files in Windows, Saves, Share with an agent); view (Fit to
window, Open in Screen Sharing, Details). Nothing else: no meters, no
heading repeating the window title.

**The machine picker** is one trigger, a computer icon, the machine's name
or title and a chevron, with the tooltip "Windows machine", so nothing next
to the traffic lights goes unexplained. It opens the **Windows machines**
menu (`components/Menu.tsx`, Base UI's Menu in the window's style): every
machine by name or title with its state on the right (Running, Starting,
Paused, Stopped, Saved) and a check on this one; under a separator, New
Machine…, Rename… and Delete "<name>"…. It opens with one machine too, so
New Machine… is always there. Rename… edits the title in place of the
picker; Window → Rename Window… does the same.

**New Machine…** is a small dialog: a name, checked as the CLI checks
instance names (letters, digits, dots, dashes and underscores, starting with
a letter or digit; not taken) and saying why as it is typed; under
Advanced, folded, the Windows image (`winvm ls --json`) and Start it now
(on). It runs `winvm create`, shows the new machine, and starts it if asked.

**Delete "<name>"…** is the confirmation dialog: it says the disk goes (and
with it everything in Windows) and the saves too, unless Keep saves is
ticked, and that it can't be undone. A running machine is turned off first,
and the button says so: Turn Off and Delete. It runs `winvm destroy
[--keep-saves]` and shows the next machine.

A button that can't act now is disabled, and its tooltip says why ("Start
Windows to open a terminal"), not only what it is.

## Resizing the window

On virtio-gpu the guest's screen follows the window, one guest pixel per
device pixel. While the window's edge moves, the last picture is held over
the view, stretched to fill it: no blank, no picture pinned to a corner, no
jumps as Windows passes through sizes. Windows is asked for the new size
when the mouse is let go (or after the size has been still for 250 ms), and
the held picture gives way once Windows has drawn a frame at that size. The
app logs each one: "resize: 2048x1280 drawn 1:1 140 ms after the resize
ended" on its stderr.

## Disclosure

The overview says the least it can: one display heading (Fraunces, the
window's one display moment), one sentence, one fact line, one primary
action. The commands for developers sit under it, and drop out when the
display is too short for them. Everything else is in the panel: Resources
and Status open by default, This Mac open only when something is missing.

**Resources**, while the machine runs: CPU and Memory, each a label, its
value ("19%", "2.1 GB of 4 GB") and the last minute and a half as a line;
Disk, Windows' C: drive as a hairline bar ("C: 12 GB of 63 GB") and what
the machine's changes take on the Mac. Marks are `--accent`, values
`--text-strong`, notes `--text-muted`; no dots. CPU is QEMU's share of the
machine's processors; Memory is what Windows has in use (total less
available, as Task Manager counts it), or, until Windows answers, what QEMU
holds on the Mac, said so. Read every 2.5 s while the window shows, never
while the machine is off, with one `ps` and one agent call, no CLI.

## Files

The toolbar's folder button opens a sheet: a `<dialog>` hung from under the
toolbar, nearly the window's size, rather than a popover. A file list needs
the room (name, size and date columns still fit at the 640 px minimum), and
a modal keeps the keyboard in the list.

- Left: the known folders the agent reports (Desktop, Documents, Downloads,
  the profile, `C:\work`), then the drives under a hairline.
- Top: back, forward, up, the path as crumbs (they wrap, never clip), and
  refresh. A click beside the crumbs, ⌘L or ⌘⇧G types a path instead.
- Middle: folders first, then files. Names that don't fit end in an
  ellipsis, with the whole name in the row's tooltip. As the list narrows,
  the time of day goes first, then the date.
- Foot: what a copy is doing, or where a drop lands, then Copy from Mac…,
  Copy to Mac… (primary) and Done.

Copy to Mac… asks where with the native panels: the save panel for one file,
the folder panel for anything else (copies never replace a Mac file; Finder's
"name 2" is used instead). Copy from Mac… and a drop anywhere on the window
copy into the folder the sheet last showed, the Desktop until it has shown
another; copies never replace a Windows file either (Explorer's "name (2)").
The drop target names that folder: "Drop to copy to Desktop in Windows".
While the sheet is closed, a copy's progress and result are callouts above
the display.

| Keys (in the sheet) | |
|---|---|
| ↑ ↓, Home, End | move; with ⇧, extend the selection |
| ⌘A | select all |
| Return, ⌘↓, double-click | open a folder |
| ⌘↑ | the enclosing folder |
| ⌘[ ⌘] | back, forward |
| ⌘R | read the folder again |
| ⌘L, ⌘⇧G | type a path |
| a letter or two | the next name starting with them |
| Esc | close |

## Window behaviour

The window opens hidden and is shown once the first frame is committed (a
hidden WKWebView gets no animation frames, so not on `requestAnimationFrame`).
Closing the window never stops Windows.

## The Terminal window

A second window, so shells can sit beside the screen. The toolbar's >_ opens
it, or brings it forward, with a new PowerShell 7 tab in the home folder;
Option-click or right-click on >_ (or on the window's +) shows a native menu
of shells (PowerShell 7, Windows PowerShell, Command Prompt), in the home
folder or started in another place. The menu is data
(`features/terminal/shells.ts`), so more rows, Run as administrator or Run
as SYSTEM, are added there.

- **Tabs**, titled by what the shell sets (OSC 0/2), or by the shell's name
  when that is only its program path. File → New Terminal Tab (Cmd-T) and
  Close (Cmd-W) act on tabs while this window is in front; Cmd-Shift-[ / ]
  and Cmd-1…9 move between them.
- **A shell's end**: exiting with 0 closes the tab; any other end (a code, a
  lost connection) keeps the tab and its scrollback, in italics, with a
  status line offering Open again and Close tab. Closing the last tab closes
  the window.
- **No run-as toggle.** winvm's images run Windows as the built-in
  Administrator with UAC off, so every shell is already elevated. The tab
  strip says so once, quietly ("Administrator"), rather than offering a
  choice that changes nothing.
- **Colours and type** are the window's tokens: the ground is
  `--surface-base`, text `--text-base-color`, the cursor `--link`, the
  selection `--terminal-selection`, in `--font-mono` at `--text-sm`. The
  sixteen ANSI colours are the terminal package's light and dark palettes,
  lifted to 4.5:1 against the ground. It follows the OS between light and
  dark.
- The window has a native title bar, titled after the active tab.
