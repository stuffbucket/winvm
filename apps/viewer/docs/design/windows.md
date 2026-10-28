# The winvm window

One window shows one Windows machine (see *Words* below). It follows the
rest of these rules, which come from maximal v0.4.48's `docs/design/` and
apply here unchanged except where this page says otherwise.

## Words

The CLI and the code say *instance*, *image* and *save*; the app never does.
A person asked "instance of what?", so in every UI string:

| In the code | In the app |
|---|---|
| instance | Windows machine, or machine once it is clear ("Windows machines", "New Machine…", "this machine") |
| image (the base disk an instance starts from) | Windows image |
| save (`winvm save`: the whole machine, RAM and disk, at a moment) | checkpoint ("New Checkpoint", "Go Back to This", "Keep checkpoints"); never "save", which a person reads as saving a document |

Keep `-i`, `instance`, `image` and `save` in the CLI, its help and these
docs' code references; they are the command line's words. Kinds of
checkpoint read as Manual, Automatic (auto), First start (baseline), Put away
(stow) and For tests (golden).

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
2. **Floating.** The toolbar's popovers and the confirmation dialog
   (`<dialog>`, top layer). Files and terminals are windows of their own.
3. **Full window.** Checkpoints (below), over everything in the window,
   the window's own screen blurred behind it. Its confirmations are the
   same `<dialog>`, above it. Nothing else covers the window.

## Toolbar

The title bar is an overlay (`TitleBarStyle::Overlay`, hidden title), so
the toolbar is the drag region and leaves room for the traffic lights.
Left to right: the machine picker; what is happening, in words; power
(Start or Shut down, Restart, Pause or Resume); things to do in Windows
(Terminal, Files in Windows, Checkpoints, Use with Claude); view (Fit to
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
with it everything in Windows) and the checkpoints too, unless Keep
checkpoints is ticked, and that it can't be undone. A running machine is
turned off first, and the button says so: Turn Off and Delete. It runs
`winvm destroy [--keep-saves]` and shows the next machine.

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

## The Files window

A window of its own per instance, as Finder is, so files sit beside the
screen. The toolbar's folder button opens it, or brings it forward; its
title names the folder and the instance ("Desktop — demo"). Option-click or
right-click on the button shows a native menu: Open Files in Windows, then
Open in Finder: Home and Open in Finder: C:\, disabled and marked "coming
soon" until the guest's drives can be mounted on the Mac
(`revealGuestPath` in `backend.ts` is the hook).

Listing, renaming, moving, copying within Windows and deleting go straight
to the in-guest agent over HTTP (`agent_fetch`, `src-tauri/src/agent.rs`):
a few milliseconds each, where a `winvm` command costs a process start. The
app asks `winvm agent connect --json` where the agent is once per machine.
Copies to and from the Mac still run `winvm put` and `winvm get`.

- **Title bar**: an overlay (traffic lights, hidden title), like the main
  window's. The lights sit over the sidebar; the toolbar beside them holds
  back, forward, up, the path and refresh, and the rest of it drags the
  window. The path's last part is the folder shown, in bold; earlier parts
  give way first as the window narrows, and in a narrow window only the
  folder shown is left. ⌘L or ⌘⇧G types a path instead.
- **Sidebar**: the known folders the agent reports (Desktop, Documents,
  Downloads, the profile, `C:\work`), then the drives.
- **List**: Name, Date modified, Size and Kind, as Finder orders them. A
  click on a heading sorts by it (names A to Z, dates and sizes biggest
  first), and another click reverses it; the chevron says which. Folders
  stay first whatever the sort, and a missing date or size goes last either
  way. Each row has a file-type glyph (`--font-symbols`: Octicons and Seti
  from Symbols Nerd Font Mono, mapped in `features/files/kinds.ts`); folders
  are `--link`, the rest `--text-muted`. Dates read as Finder's do ("Today
  at 1:33 PM", "Yesterday at 9:02 AM", "Oct 19, 2026 at 2:02 PM"),
  shortening to "10/19/26, 2:02 PM" and then "10/19/26" as the list
  narrows, after Kind has gone. Dates and sizes use tabular figures. Only
  the rows in view are drawn, so a folder of 5000 scrolls smoothly.
- **Status bar**: how many items, or how many are selected; while
  something is dragged, where it would go ("Move to Projects", "Copy to
  Desktop"); a copy's progress; what an operation did, with Show in Finder
  after a copy out. Failures are a callout above the list.
- **No Done button**: it is a window, and ⌘W closes it.

**Menus.** A right-click, Control-click or Option-click shows a native
menu. On items: Open (a folder), Copy to Mac…, Rename, Move to Recycle Bin,
Copy path, Open in Terminal (a new tab in the Terminal window, started in
that folder, or in the folder shown for a file), New folder. On empty
space: New folder, Copy from Mac…, Open Terminal here, Copy path, Refresh.

**Renaming** is in place, as in Finder: Return (or Rename) edits the name
with the part before the extension selected; Return or a click elsewhere
keeps it, Esc puts it back. Names Windows refuses (`\ / : * ? " < > |`,
CON and the like, a trailing dot or space, a name already there) are
refused with the reason. New folder makes "New folder" ("New folder (2)"
when that is taken, as Explorer does) and starts its rename.

**Deleting** moves items to the Recycle Bin (the agent uses shell32 with
undo, so Explorer can put them back). From 10 items on it asks first.

**Dragging.**

- Inside the window: drag a selection onto a folder row or a sidebar place
  to move it there; hold Option to copy instead. The target is ringed in
  the accent. Moves and copies never replace anything; a clash gets
  Explorer's "name (2)".
- Out to Finder or the Desktop: dragging past the window's edge hands the
  drag to macOS as file promises (`src-tauri/src/dragout.rs`). Nothing is
  fetched until it is dropped; then each item, file or folder, is written
  where Finder asks with `winvm get`, and the status bar shows it. Once
  handed over, the drag can't come back into the window as a move.
- In from the Mac: drop files anywhere on the window. Over a folder row or
  a place they go into it; anywhere else, into the folder shown (the whole
  list is ringed). Copies never replace a Windows file.

Copy to Mac… asks where with the native panels: the save panel for one
file, the folder panel for anything else (copies never replace a Mac file;
Finder's "name 2" is used instead). Files dropped on the main window go to
the Desktop in Windows; there, a copy's progress and result are callouts
above the display.

| Keys (in the Files window) | |
|---|---|
| ↑ ↓, Home, End, Page Up, Page Down | move; with ⇧, extend the selection |
| ⌘A | select all |
| Return | rename |
| ⌘O, ⌘↓, double-click | open a folder |
| ⌘↑ | the enclosing folder |
| ⌘[ ⌘] | back, forward |
| ⌘⌫ | move to the Recycle Bin |
| ⌘⇧N | new folder |
| ⌥⌘C | copy the path |
| ⌘R | read the folder again |
| ⌘L, ⌘⇧G | type a path |
| a letter or two | the next name starting with them |
| Esc | cancel a rename or a drag; clear the selection |
| ⌘W | close the window |

## Checkpoints

Time Machine's way back, for a Windows machine: every checkpoint on an
infinite canvas (`features/checkpoints/`, on `@winvm/canvas`, monimal's
spatial canvas). The toolbar's clock opens it, as do ⌘⇧T and File →
Checkpoints…; Option-click or right-click on the clock shows a native menu
with Take a Checkpoint Now and Show Checkpoints….

**In and out.** The view eases in: the window's own screen becomes the
"Now" card where it stands (the camera starts with the card exactly over the
display) and the camera pulls back to show Now and the newest checkpoints,
while the window behind dims and blurs (the live screen, copied a couple of
times a second and blurred; `backdrop-filter` where there is no screen).
Done, Esc or a click on Now flies back into the screen the same way. Going
back to a checkpoint flies that checkpoint's picture into the screen once
Windows is back at that moment.

**Layout.** Time runs up the canvas, as Time Machine's windows recede into
the screen. Now, the running machine (its live screen, copied into the card
a few times a second; its state when it is off), is the large card at the
front, at the bottom. Above it, one block per day with checkpoints, the
newest day nearest, its date above it (Today, Yesterday, a weekday this
week, else the date): the day's checkpoints left to right as taken, six to
a line. Each older day is drawn a little smaller (7% a day, down to 62%),
so the stack reads as going back in time and in depth. Far out, where the
dates no longer fit, only the months are named, beside the stack.

**A card** is the checkpoint's screenshot (a 16:10 frame, the picture
fitted inside it; "No picture" for checkpoints taken before screenshots),
then its title (its notes' title, else its name), when it was taken as
Finder says it, its kind and size, and a notes mark when it has notes. One
that can't load here is dashed and grey, and says why over its picture
("Made with a different display, so it can't load here"). Far out, cards
are their pictures only.

**The timeline**, down the right edge: a tick per day with checkpoints,
evenly spaced (by turn, not by time, so a busy day and a quiet month take
the same room), months named where they start, Now at the bottom. The day
in view is named in `--link`; hovering names any day. Click or drag flies
there; the chevrons above and below step one checkpoint older or newer.

**Moving around.** Every camera move eases in and out (log-space zoom; a
flight pans while zoomed out, then closes in) and, with reduced motion,
jumps. Pinch, ⌘-scroll or ⌘+ / ⌘− zoom (about the pointer for pinch and
scroll); two-finger scroll, dragging anywhere or the arrow keys pan. The
camera never leaves the stack behind, and zooms between seeing everything
and three times life size.

**A selected card** comes up close, centred in the space the panel leaves,
and the panel beside the timeline shows a larger screenshot (click it, or
press Space, for Quick Look), its notes (title, markdown text and tags,
written as they are typed to `$XDG_DATA_HOME/winvm/notes/<instance>/<save>.json`
through `winvm saves note`), when it was taken, its kind, size, whether it
loads here and its name in winvm; then Delete… and Go Back to This.

- **Go Back to This** confirms: "Windows returns to exactly how it was at
  that moment. What it's doing now is replaced, unless you keep it as a
  checkpoint first.", with Cancel, Save Current First (while Windows runs:
  it takes "Before going back to …" first) and Go Back. It is disabled,
  with the reason, for a checkpoint that can't load here.
- **Delete…** confirms, destructive: its picture and notes go with it.
  First start (baseline) and For tests (golden) checkpoints can't be deleted
  here, as `rewind` and tests depend on them; the button's tooltip says so.

**New Checkpoint** asks for a name (empty: named by the time). The name
becomes its title, and a directory-safe form of it the save's name. The
view pulls back to Now and today, Now says "Taking a checkpoint…", and the
new card flies out of Now into its place, screenshot and all.

**Search** (⌘F) matches every word against names, titles, notes, tags,
kinds and dates, newest first; cards that don't match fade while the
results are open, and choosing one flies to it. **Automatic** shows or
hides the checkpoints winvm takes by itself (autosaves and the stow).

The view's settings (whether automatic checkpoints show, the zoom it was
left at) are in `$XDG_CONFIG_HOME/winvm/settings.json` under
`"checkpoints"`, read and written by the app (`src-tauri/src/checkpoints.rs`).
Screenshots come through `checkpoint_image`, which serves only
`saves/<instance>/<save>/{thumb,screen}.png`, as bytes shown as `blob:`
URLs (which the CSP already allows). Only the cards in view are drawn and
only their pictures fetched, four at a time, thumbnails until a card is
large on screen, so hundreds of checkpoints pan smoothly.

| Keys (in Checkpoints) | |
|---|---|
| ⌘⇧T, Esc | back to Windows (Esc first closes Quick Look, New Checkpoint, search or the selection) |
| ⌘+ ⌘− | zoom in, out |
| ⌘0 | show every checkpoint |
| arrows (⇧ for more) | pan |
| ⌘↑ ⌘↓ | the checkpoint older, newer |
| Space | Quick Look the selected checkpoint |
| ⌘F | search |
| ⌘⌫ | delete the selected checkpoint (it asks first) |

`bun scripts/build-ui.ts`, then `PLAYWRIGHT_DIR=… node
scripts/render-checkpoints.mjs` renders it in WebKit against a fake app
(`tests/render/fake-tauri.js`): the way in and out, zooms, the timeline, a
selection, Quick Look, search, the confirmations, New Checkpoint and 400
checkpoints, light and dark.

## Use with Claude

The toolbar's bot button opens a popover with one row per Claude app,
Claude Code and Claude Desktop (from `winvm mcp status`): an Add button, or a
quiet "Added" with a check and a ghost Remove; "Update" in place of "Added"
when the app runs another copy of winvm; "Not installed" and no button when
the app isn't on this Mac. Claude Desktop's Add confirms inline first (it
edits that app's settings file). After a change, one hint line says what to
do next: start a new Claude Code session, or quit and reopen Claude Desktop.
It works with Windows off; Claude's tools then say how to start it.

The HTTP endpoint for other agents (`winvm cua serve`) sits under a
collapsed "Other agents" disclosure: a summary line, not a card. The
address and token are each one unwrapped line with a copy icon button; a
token too long for the line loses its middle, never its ends.

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
