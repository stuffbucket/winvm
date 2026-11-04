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
(Terminal, Files in Windows, Checkpoints, Use with Claude); input (Capture
Keyboard); view (Fit to
window, Open in Screen Sharing, Details). Nothing else: no meters, no
heading repeating the window title.

**Keyboard capture.** The safe default is not captured: macOS owns Command
shortcuts, left Command is never sent to Windows, and right Command is the
deliberate Windows modifier (right Command-R is Windows-R). The Input menu
also sends a Windows-key press or Ctrl-Alt-Delete directly. Capture Keyboard
in the toolbar or Input menu, or Control-Option, enters an explicit mode:
macOS global hotkeys are suspended, every key goes to Windows, the toolbar
says that capture is on, and Control-Option releases it. Losing focus or
hiding the window always releases capture and every held guest key. A held
Windows key is neutralized with a Ctrl press/release before it is released,
so cleanup cannot open Start.

**The machine picker** is one trigger, a computer icon, the machine's name
or title and a chevron, with the tooltip "Windows machine", so nothing next
to the traffic lights goes unexplained. It opens the **Windows machines**
menu (`components/Menu.tsx`, Base UI's Menu in the window's style), in three
runs: the machines (a check on this one, each with its state at the right,
a dot and a word: Running, Starting, Paused, Asleep, Stopped, Saved, Not set
up); then the commands, New Machine… and Rename… with their glyphs; then, apart
and red, Delete "<name>"…. It opens with one machine too, so New Machine… is
always there. See [`components.md`](components.md) → *Menus*. Rename… edits the
title in place of the picker; Window → Rename Window… does the same. Both set
the machine's *title* (`winvm config title=`, shown in place of its name); a
machine's name, the folder everything is kept under, is not renamed.

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

**Pause** holds the machine until Resume; nothing else resumes it. While held
the toolbar says Paused (or Asleep), the screen takes no input, a resize waits
and is asked for once it runs, the meters say Paused instead of Windows'
figures, and nothing calls Windows' agent. The screen dims under
`--scrim-paused` with a large pause glyph, fading in and out (150 ms).
Option-click or right-click on Pause shows a native menu: **Show Pause
Overlay** (a check; off for clean screenshots; kept in winvm's user settings),
then **Sleep** (Windows is locked, then the machine held as Asleep; the glyph
is a moon, and the first key pressed in the screen wakes it and isn't typed)
and **Lock (Ctrl+Alt+Del)** (back to Windows' sign-in screen). Asleep, the
button reads Wake.

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
action. What you can do with the machine sits under it (below), and drops
out when the display is too short for it. Everything else is in the panel:
Resources and Status open by default, This Mac open only when something is
missing.

**What you can do** (`features/help/`), a `--text-sm` muted title over one
outlined list (a hairline border and `--radius-card`, no fill, rows split by
hairlines) of five rows: Open a Windows terminal, Copy files between your Mac
and Windows, Save a checkpoint, Go back to a checkpoint, Use winvm from
Claude Code and Claude Desktop. The title is the same whatever the state;
the rows say what the state allows. A row is a button: the toolbar button's
own glyph in a column of its own (`--size-md`, `--link`), the label in
`--text-base`, and a muted chevron at the end. The columns are fixed and
top-aligned, so a label that wraps stays under its first line. Hover and the open row step to `--surface-control`.
Up and Down, Home and End move between rows; Tab still visits each. The list is the
overview column's full width (the column is in [`layout.md`](layout.md) → *The
overview*), so it is as wide as the note above it. It drops out when the display is
under 46rem tall, the height the whole screen needs.

**What the state allows** (`features/help/availability.ts`, which names the
code each rule follows). The list is on the overview of a machine that is off,
put away or not set up, so most rows are unavailable there:

| Topic | Running | Paused | Stopped, suspended | No machine |
|---|---|---|---|---|
| Open a Windows terminal | yes | Resume Windows first | Start Windows first | Set up Windows first |
| Copy files between your Mac and Windows | yes | Resume Windows first | Start Windows first | Set up Windows first |
| Save a checkpoint | yes | yes | Start Windows first | Set up Windows first |
| Go back to a checkpoint | yes | yes | yes (it starts Windows from the checkpoint) | Set up Windows first |
| Use winvm from Claude Code and Claude Desktop | yes | Resume Windows first | Start Windows first | Set up Windows first |

Asleep is the same as paused except that Save a checkpoint also asks to
resume (the Checkpoints view takes one only while Windows runs or is paused),
and while Windows is starting every row but Go back to a checkpoint waits
("Windows is still starting"). An unavailable row is `aria-disabled="true"`,
not `disabled`: it stays in the Tab order and opens its help, because help is
information and only the action is unavailable. It looks like every other row, with the reason under the label in
`--text-sm` muted (a muted row beside one bright row reads as that one being
selected). Its popover
reads exactly like any other: help is documentation, never written to the state
of the machine in front of it (a requirement such as "Windows has to be running"
belongs in the text itself). A row that works looks as it always does.

A row opens a **help popover** (`components/HelpPopover.tsx`, see
[`components.md`](components.md)): a screenshot of the real window, the
topic's title, one sentence, three numbered steps and one thing worth
knowing, with previous and next topic at the foot. The words are
`help.<topic>.*` in `en.json`; the pictures are `features/help/img/`, made
by `scripts/render-help.mjs` (below). Each claim is one the app, the CLI or
`docs/` makes: the Terminal and Files windows and the toolbar's buttons
(above), Checkpoints and their automatic kinds (`docs/saves.md`,
`docs/background.md`), and Use with Claude (`docs/cua.md`).

**The help pictures.** `bun scripts/build-ui.ts`, then
`PLAYWRIGHT_DIR=… node scripts/render-help.mjs` from `apps/viewer` renders
the Terminal window (against `tests/render/help-term-server.ts`, a fake guest
that plays a short session), the Files window, the Checkpoints view (new
checkpoint; browsing; one selected, with Go Back to This) and the Use with
Claude panel, in WebKit against `tests/render/fake-tauri.js` and
`fake-help.js`, on a fixed clock so Today and Yesterday read the same every
time. It writes `<topic>-<figure>.light.jpg` and `.dark.jpg` (1200 × 675)
into `features/help/img/`; commit them. They are the real windows, so run it
again, and commit, whenever the Terminal, Files, Checkpoints or Use with
Claude panel changes shape. `--preview <dir>` also screenshots the list and
every popover at three sizes, and the list of a suspended machine with the
help of an unavailable row open.

**Resources**, while the machine runs: CPU and Memory, each a label, its
value ("19%", "2.1 GB of 4 GB") and the last minute and a half as a line;
Disk, Windows' C: drive as a bar ("C: 12 GB of 63 GB"). No captions. CPU is
Windows' own figure, with what QEMU spends on the Mac as a second, dashed
line on the same chart; the disk bar carries what the machine's changes take
on the Mac as a strip on the same track; hovering or focusing either names
each value (see Resource meters in `components.md`). Memory is what Windows has
in use (total less available, as Task Manager counts it), or, until Windows
answers, what QEMU holds on the Mac, said so in its value. Read every 2.5 s
while the window shows, never while the machine is off, with one `ps` and
one agent call, no CLI.

**Shared folder** (`features/sharedfolder/`), closed unless Windows needs
its setup, with "Off" or "Z: in Windows" beside the title: the Mac folder
on one line under `~` (the middle gives way, its last part stays) with a
Show in Finder icon button, "In File Explorer as Mac (Z:)", a Windows can
only read it checkbox, Choose folder… (the folder panel) and Stop sharing.
A change made while Windows runs waits for its next start, and one hint
line says so. When Windows lacks the driver, Set up in Windows… confirms
first (Windows restarts twice, a few minutes), then a hint holds the place
while it runs. A machine that can't share (the fixed 800 × 600 display, an
older runtime) shows `winvm share status`'s reason and no buttons. It reads
`winvm share -i <name> status --json` while the panel is open, and again
when the machine starts, stops or its agent answers.

**The clipboard** has no control: text goes both ways while the window is
in front (`features/screen/clipboard.ts`). What Windows copies goes on the
Mac's clipboard; the Mac's goes to Windows when the window comes forward and
once on connecting, only when it changed, and never back to where it came
from. QEMU's qemu-vdagent carries it, through noVNC's extended clipboard.

## The suspended screen

A machine that is suspended (stowed) shows its own overview with two things
the others don't: a note, and a backdrop (`features/overview/`).

**The heading names the machine** ("Windows machine `Work PC` is suspended"; an
off machine says "is off"), the name in the mono face, and the name is where it
is renamed: click it, press Return on it or F2 and it becomes a field in place;
see [`components.md`](components.md) → *A name edited in its heading*. It sets
the same title as Rename… in the machine menu, which stays for the states with
no such heading (running, paused).

**The note** is the person's, about this machine: a text area under the
heading, with a quiet placeholder ("Add a note about this machine"). It
saves as they type (after a pause, 800 ms), on Esc and on leaving the field,
and when the screen goes away (Start) or another machine is shown: no Save
button. If a save fails it says so under the note and tries again at the next
chance. It is kept by `winvm note -i <name>` (`packages/core/src/machinenote.ts`)
in `$XDG_DATA_HOME/winvm/machine-notes/<instance>.json`, apart from the notes
on checkpoints, and goes with the machine when it is deleted. It takes no key
the app uses: Esc finishes writing (saves, leaves the field), everything else
is typing. Nothing is captured for Windows here; the machine isn't running.

**It grows upward.** The heading and the note are one block, aligned to its
bottom, between the top of the screen and the controls. As the note grows the
heading rises with it; when the heading reaches the top of the column (its
`--space-7` padding, so 48 points below the toolbar that carries the traffic
lights; on a window taller than the column's cap, below the column's top) the
note stops growing and scrolls inside. At rest the note has three lines, five
on a taller display and seven on a tall one, so extra height is room to write. The facts, Start and the rest below it
never move, because the block, not they, takes up the slack. This is layout
only (flex, and the wrapper's `data-value` copy of the text drawn invisibly in
the same grid cell, which gives the area the height of its text): no
measuring in script. `scripts/render-overview.mjs` measures it in WebKit.

**The backdrop** is behind the whole screen: the screenshot from when the
machine was put away (else the newest checkpoint's picture), at 16% opacity,
blurred (`--space-6`), saturation 0.8, contrast 0.85, brightness 0.75, out of
the layout so nothing moves when it arrives; it fades in once loaded. A
machine with no picture gets a drawn wallpaper under the same treatment: soft
dunes and a low sun in `--link`, `--accent`, `--brand` and the backdrop
tokens (so it follows light and dark), with no icons, no marks and no text.
Over it, text is `--text-strong`, `--text-base-color` (the labels that are
`--text-muted` elsewhere on this screen, which wouldn't clear 4.5:1 over a pure
white or black picture at this opacity), `--status-error`, and `--link` for
glyphs; `tests/overview.test.tsx` measures each against the worst picture, in
both themes.

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

**In and out.** A change of mode in this window, so it happens where it
is: the view fades in over the window's own screen, settling from 99% to full
size in 200 ms, already showing Now and the newest checkpoints; Done, Esc or a
click on Now fades it out in 180 ms (`checkpoints.css`, the surface's
`data-phase`). Nothing flies in from the display and nothing slides, so it
never reads as a separate window. Under reduced motion it is a cut. The
window behind dims and blurs (the live screen, copied a couple of times a
second and blurred; `backdrop-filter` where there is no screen), closed in by
a vignette and sinking into the surface color toward the top, where the oldest
checkpoints are: the view is the whole window, with no chrome at its top.
Nothing of ours sits by the traffic lights (no title chip; the native title
bar names the window); only a strip across the top still moves the window.
Going back to a checkpoint leaves the same way, once Windows is back at that
moment. The camera still flies *within* the view (below).

**Layout.** Time runs up the canvas, as Time Machine's windows recede into
the screen. Now, the running machine (its live screen, copied into the card
a few times a second; its state when it is off), is the large card at the
front, at the bottom. Above it, one block per day with checkpoints, the
newest day nearest, its date above it (Today, Yesterday, a weekday this
week, else the date): the day's checkpoints left to right as taken, six to
a line. Each older day is drawn a little smaller and fainter (7% a day, down
to 62%), so the stack reads as going back in time and in depth. Far out,
where the dates no longer fit, only the months are named, beside the stack.
The view opens on everything when it fits with cards at least 40% of life
size (a short history), else on Now and the newest two days, and at the zoom
it was left at once it has been left anywhere else.

**A card** is its picture (a 16:10 frame, the screenshot fitted inside it;
"No picture" for checkpoints taken before screenshots) and nothing else: its
words hang below it, so the picture is the hero. Those are its title (its
notes' title, else its name, with a notes mark when it has notes), then when it
was taken as Finder says it and its size. A kind that isn't Manual is a small
tag on the picture's corner. One that can't load here is dashed and grey, with
"Can't load here" on its picture (the reason is its tooltip and part of its
accessible name; the panel says it in full).

**Words read at any zoom.** Card words are drawn at least 12 px on screen
(`--text-sm` at 86%), scaled up in the world as the camera pulls back rather than
shrinking with the card, so the gaps between lines and days leave room for
them. As a card gets small the words thin out by its width on screen: 168 px
and up, the name, time and size; 110 px, the kind's tag; 84 px, the name only;
under that, the picture alone (its name and time are its tooltip). Strokes
(outline, selection ring) are scaled the same way, so they stay lines.

**Picking out.** Pointing at a day on the timeline, or at the Automatic
filter, gives the matching cards a soft accent ring and glow, and the rest
step back a little. Search dims what doesn't match, as before.

**Moving cards.** Dragging a card moves it, wherever it is put: cards can be
grouped however a person likes. Dragging empty canvas still pans, and a click,
Enter or Space on a card still selects and looks. With a card selected,
⌥ and the arrows move it (⇧ for more), for anyone who can't drag. Esc while
carrying puts it back. Now can't be moved. A card keeps its place as an
offset from its slot, so it moves with its day when days are added. Moves are
kept per machine in the settings below; the Reset layout button at the end of
the control bar (dimmed while nothing is moved) puts everything back.

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

**The control bar** floats at the bottom of the window, one compact bar
(Settings' glass is opaque here: cards pass under it): search, New, back to
the newest, Automatic, zoom (out, in, show everything), Reset layout and Done.
Each is a button with an accessible name and a tooltip, the keys in the
tooltip. **New** is a plus and a word; its tooltip says why when it can't
(Windows isn't running).

**Search** (⌘F, or the magnifier) matches every word against names, titles,
notes, tags, kinds and dates, newest first. It is a magnifier until used,
then the field eases out to its left (200 ms, instant with reduced motion)
and folds back when it loses focus empty; the field is out of the Tab order
while folded. Cards that don't match fade while it is open, and choosing one
flies to it. **Automatic** is an icon filter, pressed when automatic
checkpoints show: it shows or hides the checkpoints winvm takes by itself
(autosaves and the stow).

**The zoom's figure** (53%) is only there while the zoom is changing, and under
the pointer or focus: it eases out 1.6 s after the zoom rests, and the buttons
close up.

The view's settings (whether automatic checkpoints show, the zoom it was
left at, and the cards moved, by machine and checkpoint) are in `$XDG_CONFIG_HOME/winvm/settings.json` under
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
| ⌥ arrows (⇧ for more) | move the selected checkpoint |
| ⌘↑ ⌘↓ | the checkpoint older, newer |
| Space | Quick Look the selected checkpoint |
| ⌘F | search |
| ⌘⌫ | delete the selected checkpoint (it asks first) |

`bun scripts/build-ui.ts`, then `PLAYWRIGHT_DIR=… node
scripts/render-checkpoints.mjs` renders it in WebKit against a fake app
(`tests/render/fake-tauri.js`, 14 checkpoints: manual, automatic, one with no
picture, and ones that can't load here because of a different display or QEMU):
the way in and out, the opening view and the bar at rest, the highlights, a card
dragged and the layout reset, zooms, the timeline, a selection, Quick Look,
search, the confirmations, New Checkpoint and 400 checkpoints, light and dark.
`scripts/render-help.mjs` also photographs this view for two help popovers
(*What you can do with this Windows machine* under *Disclosure*): when the
canvas changes, run it again.

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
