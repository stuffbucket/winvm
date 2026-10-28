# The in-guest agent

The agent is a small HTTP server that runs inside the Windows guest. winvm
uses it to run commands, copy files, and start programs on the guest's
desktop. It is much faster than the QEMU guest agent (qemu-ga), which winvm
uses to install the agent and as a fallback when the agent is not running.

## Using it

```sh
winvm agent install            # install (or reinstall) the agent in a running guest
winvm agent status [--json]    # is it answering, which version, which host port
winvm exec -- cmd /c ver       # runs through the agent when it answers
winvm exec --qga -- whoami     # force qemu-ga instead
winvm put  <host path> <guest path>   # a file, or a folder and everything in it
winvm get  <guest path> <host path>   # a file, or a folder and everything in it
winvm dir  ['C:\Users']          # a guest folder (default the Desktop); --all, --places, --json
winvm launch -- notepad.exe    # start a program on the desktop and return at once
winvm terminal                 # a shell in the guest, in this terminal
```

All of these take `-i <instance>`. Images built by `winvm build` already
contain the agent, so you usually don't need `agent install`.

`exec`, `put`, `get` and `launch` use the agent if it answers within 1.5
seconds. Otherwise they fall back to qemu-ga. Pass `--qga`, or set
`WINVM_NO_AGENT=1`, to always use qemu-ga. For other ways to move files, see
[Getting files in and out](files.md).

The two channels run as different users:

| | agent | qemu-ga |
|---|---|---|
| runs as | the logged-on Administrator, in the desktop session | SYSTEM, in session 0 |
| programs it starts | appear on the desktop | are invisible |
| `%LOCALAPPDATA%`, `HKCU` | the user's | SYSTEM's |

So `whoami` prints the Administrator account through the agent and
`nt authority\system` through qemu-ga.

### How fast it is

Measured on `win11-arm64`, M-series Mac, 2026-10-22:

| | agent | qemu-ga |
|---|---|---|
| `cmd /c echo` round trip | about 10 ms | 70-160 ms |
| PowerShell command | about 10-13 ms (first call about 1.2 s) | 2-7 s |
| copy 128 MiB in / out | about 290 / 67 MiB/s | much slower (base64 over a serial channel) |
| GUI program's window appears | 170-390 ms | about 500 ms |

After a cold `winvm start`, the agent answers about 3.4 seconds after `start`
returns.

### Terminal

`winvm terminal` opens a shell in the guest in your Mac terminal. Every key
goes to the guest, Ctrl-C included, and resizing your window resizes the
guest's. It ends when the shell does, with the shell's exit code.

```sh
winvm terminal [-i name] [--shell pwsh|powershell|cmd] [--cwd PATH]
winvm terminal [-i name] [--shell ..] [--cwd ..] --connect --json
```

The shell is PowerShell 7 (`pwsh`) unless you pick Windows PowerShell or
`cmd`, and starts in the user's profile folder unless you give `--cwd`. An
image built before PowerShell 7 was part of images gets Windows PowerShell
instead, with a note in the terminal saying so.

Shells run as the logged-on Administrator, elevated: images have UAC off, so
`whoami /groups` shows `High Mandatory Level`. For a SYSTEM command line, use
`winvm exec --qga`.

`--connect --json` is for another program that shows the terminal itself,
such as the Mac app. It makes sure the agent is current and answering, then
prints one line:

```json
{"url":"ws://127.0.0.1:<hostPort>/term?shell=pwsh","protocols":["winvm-term","winvm-token.<token>"]}
```

Open a WebSocket to `url` (add `&cols=N&rows=M` for the starting size),
offering `protocols`. The agent answers with the `winvm-term` subprotocol.
Then:

- binary frames are terminal bytes, both ways: keystrokes in, output out;
- the client may send the text frame `{"type":"resize","cols":N,"rows":M}`;
- when the shell exits, the agent sends `{"type":"exit","code":N}` and closes;
- on a failure it sends `{"type":"error","message":"..."}` and closes.

Closing the WebSocket ends the shell and everything started from it. Several
terminals can be open at once. A client that can set headers may send
`Authorization: Bearer <token>` instead of the token subprotocol.

## Using it from TypeScript (`agent.ts`)

```ts
import * as agent from "./agent"

const c = await agent.ensure(name)    // connect; else adopt an agent already in the guest; else install
const c = await agent.connect(name)   // null when no agent answers
await agent.install(name, { log })    // force a (re)install

await c.exec(argv, { cwd, env, stdin, timeoutMs, verbatim })  // {code, stdout, stderr, ms, timedOut}
await c.pwsh(script)                  // a warm Windows PowerShell: {code, output, ms, timedOut}
await c.put(guestPath, data)          // data: bytes, string, Blob or stream
await c.putFile(hostPath, guestPath)
await c.get(guestPath)                // throws AgentError with status 404 if the file is missing
await c.getFile(guestPath, hostPath)
await c.list(guestPath, { hidden, limit })  // a folder: {path, parent, entries, total, places}
await c.launch(argv, { cwd, env })    // start on the desktop, detached: {pid}
await c.procs()                       // [{pid, name, session}]
await c.kill(pid, { tree })           // kills the whole tree unless tree is false
await c.health()                      // {version, pid, arch, session, uptimeMs, ...}
await c.ui({ op, ... })               // UI Automation; use ui.ts instead (see gui.md)
await c.display({ op, ... })          // screen size and scaling; use guestdisplay.ts (windows-vm-qemu.md#the-display)

agent.qgaLaunch(name, argv)           // start a GUI program over qemu-ga, without the agent
```

`ensure` waits up to 15 seconds for an agent that is still starting after
logon, before it decides to install one.

Errors throw `AgentError`, which has the HTTP `status`, and a `code` when the
agent gives one: `list` throws `notfound` (404), `denied` (403) or `notdir`
(400).

`list` returns folders first, then files, each sorted by name as Explorer
sorts them. Each entry is `{name, dir, size, modified, hidden}`; `size` and
`modified` are null when Windows won't say. Hidden and system entries are
left out unless you pass `hidden: true`. A folder with more than `limit`
entries (5000 by default) returns the first `limit`, and `total` says how many
there are. `places` lists the known folders that exist: the agent user's
Desktop, Documents and Downloads, their profile, `C:\work`, and the drives.
With no path, `list` lists the Desktop.

`exec` takes an argument list, not a shell command line. Bun quotes arguments
in a way that `cmd.exe` does not always parse. For `cmd /c` with embedded
quotes, pass `verbatim: true`.

## For developers: how it works

### Connection

The host reaches the agent at `127.0.0.1:<hostPort>`, which QEMU forwards to
port 7801 in the guest. winvm adds this forward at runtime with the HMP
command `hostfwd_add`. It is not on the QEMU command line, because the
command line is part of a save's compatibility hash (saves.ts), and adding a
forward there would make existing saves incompatible.

The forward ends when its QEMU process ends. `qemu.launch` adds it again for
every instance that has an agent (agentfwd.ts `restoreForward`), so it
survives start, load, stow and golden resets.

`<instance>/agent.json` (mode 0600) holds `{token, hostPort}`. winvm picks a
free host port the first time and keeps it. If that port is taken later, it
picks a new one.

Inside the guest, `http://10.0.2.2:<port>` reaches the host's loopback.
`agent install` uses this to serve bun to a guest that has none.

### Authentication

Each instance has a random 32-byte token. The host writes it over qemu-ga to
`C:\ProgramData\winvm\agent\token`, readable only by Administrators and
SYSTEM. Every request must send `Authorization: Bearer <token>`, except that
`GET /term` may offer the subprotocol `winvm-token.<token>` instead, because a
browser's WebSocket cannot set headers (see [Terminal](#terminal)). Without a
token file, the agent refuses every request.

The agent re-reads the token file when it changes. This lets the host take
over an agent that was built into the image or restored from another
instance's save: it writes its own token, and the agent accepts it without a
restart.

The agent accepts connections only from 10.0.2.2 (the host) and loopback. A
firewall rule allows the port for the agent's program from 10.0.2.2 only.

### Files in the guest

Everything is in `C:\ProgramData\winvm\agent\`:

- `bun.exe`: the agent's own copy of bun.
- `guestagent.ts`: the agent.
- `winvm-ui.exe`: the UI Automation helper behind `POST /ui`, compiled at
  install from `assets/winvm-ui.cs`. See [gui.md](gui.md#how-ui-automation-works).
- `runinsession.exe`: starts programs detached, compiled at install from
  `assets/runinsession.cs`.
- `conpty.exe`: one terminal session, compiled at install from
  `assets/conpty.cs`. See [Terminals](#terminals).
- `token` and `agent.log`.

The registry value `HKLM\...\Run\winvm-agent` starts the agent at every logon
in the user's session, through `conhost.exe --headless` so it has no window.
It runs with `--supervise`, which restarts the agent if it exits. The agent
also closes the audit-mode Sysprep dialog after logon.

### Folder listings

`GET /fs/list` reads the folder with `readdir` and stats only the entries it
returns, plus links (to learn whether they lead to a folder), 256 at a time.
`C:\Windows\WinSxS`, about 17,000 entries, lists its first 5000 in about half a
second.
Node can't read Windows' hidden attribute, so the spawner runs `cmd /u /c dir
/b /a:h` alongside `readdir`. `/u` makes cmd write UTF-16 to the pipe, so names
outside the OEM code page survive.

### Processes

The agent runs as three processes: a supervisor, the HTTP server, and a
spawner. Every program the agent starts is started by the spawner, and the
spawner starts before the HTTP server listens.

The reason: on Windows, Bun's sockets are inheritable, and Bun starts child
processes with handle inheritance on. A program started by the HTTP server
would inherit the listening socket and keep port 7801 open after the agent
exited, so a new agent could not listen. bun:ffi is not available on Windows
ARM64, so the socket flag cannot be cleared. The spawner never has the
socket, so its children cannot inherit it.

The spawner starts launched programs through `runinsession.exe --self
--hidden`, which calls CreateProcess with no inherited handles and then exits.
Launched programs therefore keep running when the agent restarts. Console
programs get a console with no window. Node-style `detached` is not used: it
starts programs with no console at all, and Windows PowerShell started that
way exits without running anything.

### Terminals

`GET /term` upgrades to a WebSocket. The HTTP server cannot start programs
itself (see Processes), so for each terminal the spawner starts `conpty.exe`
through `runinsession.exe`. `conpty.exe` creates a pseudo-console
(`CreatePseudoConsole`) at the requested size, starts the shell in it, and
connects back to a loopback port the agent listens on, naming its session
with a one-time key. Over that connection the two exchange small frames:
keystrokes and resizes one way, output and the exit code the other. The agent
relays them to and from the WebSocket.

The shell and everything it starts run in a job object that only
`conpty.exe` holds, and `conpty.exe` exits when its connection ends. So
closing the WebSocket, or the agent dying, ends the whole tree: nothing is
left running. A program started from a terminal, even a GUI one, closes with
the terminal; use `winvm launch` for programs that should stay.

`conpty.exe` is a separate program per session, started without inherited
handles, so it never holds the agent's listening socket, and a restarted
agent serves new terminals at once.

### Built into images

`winvm build` puts the agent on the setup media: `guestagent.ts`,
`agent-install.ps1`, the C# sources, and a Windows ARM64 `bun.exe`. During
setup, `provision.ps1` runs `agent-install.ps1 -NoStart`, which installs
everything and sets the Run key, with no token. An instance of that image
then needs only `agent.ensure(name)`: it writes the token, adds the forward,
and waits for the agent that started at logon.

For an image without the agent, `ensure` falls back to `agent.install`, which
copies the same files over qemu-ga and runs the same script.

### Bun issues found

Seen with Bun 1.3.14 on Windows ARM64:

- `Bun.write(path, response)` spins at 100% CPU forever on a response that
  comes through QEMU's user network. `getFile` streams the body in chunks
  instead.
- `mkdirSync(dir, { recursive: true })` throws EEXIST for `C:\Users\Public`.
- bun:ffi `dlopen` is not available ("TinyCC is disabled").
