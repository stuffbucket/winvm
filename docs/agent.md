# The in-guest agent

A small HTTP+JSON server inside the Windows guest, so the host can run
commands, move files and start GUI programs in milliseconds. qemu-ga stays the
bootstrap and fallback channel; the agent is the fast one.

| | agent | qemu-ga |
|---|---|---|
| runs as | logged-on Administrator, **session 1** (desktop) | SYSTEM, session 0 |
| arch | native ARM64 bun | x64 under Prism |
| `cmd /c echo` round trip | **8.5–11.6 ms** median | 72–160 ms |
| warm PowerShell | **~10–13 ms** (cold first call ~1.2 s) | 2–7 s per call |
| 4 KiB put / get | 0.3 / 0.4 ms | ~110 ms write |
| 128 MiB put / get | **~290 / ~67 MiB/s** | base64 over serial |
| GUI launch | API 5–27 ms; window up 170–390 ms (charmap), 205–280 ms (notepad) | runinsession: window up 465–575 ms |
| install | ~7–8 s (18 s if bun has to be fetched) | — |
| after a cold `start` | answering ~3.4 s after `start` returns (Run key at logon) | — |

Measured on `win11-arm64`, M-series host, 2026-10-22. Get is slower than put
because slirp's guest-to-host direction is (curl measures the same ~65 MiB/s).

## For harnesses: the API (`agent.ts`)

```ts
import * as agent from "./agent"

const c = await agent.ensure(name)    // connect (waits up to 15 s for one starting at logon);
                                      // else adopt an agent already in the guest; else install
const c = await agent.connect(name)   // null when no agent answers (never installed, not running)
await agent.install(name, { log })   // force a (re)install

await c.exec(argv, { cwd, env, stdin, timeoutMs, verbatim })  // {code, stdout, stderr, ms, timedOut}
await c.pwsh(script)                  // warm Windows PowerShell: {code, output, ms, timedOut}
await c.put(guestPath, bytes|string|Blob|stream)  /  await c.putFile(hostPath, guestPath)
await c.get(guestPath)                /  await c.getFile(guestPath, hostPath)   // AgentError 404 if absent
await c.launch(argv, { cwd, env })    // detached, on the desktop: {pid}
await c.procs()                       // [{pid, name, session}]
await c.kill(pid, { tree })           // tree by default
await c.health()                      // {version, pid, arch, session, from, uptimeMs, ...}

agent.qgaLaunch(name, argv)           // GUI launch over qemu-ga via runinsession.exe (no agent needed, once installed)
agent.reattach(name)                  // re-add the port forward (qemu.launch already does)
```

Failures throw `AgentError` (with the HTTP `status`). `exec` takes argv, not a
shell line: for `cmd /c` with embedded quotes pass `verbatim: true`, since
Bun's MSVCRT-style quoting is not what cmd.exe parses.

CLI: `winvm agent install|status`, `winvm put <host> <guest>`, `winvm get
<guest> <host>`, `winvm launch -- <exe> [args]`. `winvm exec` uses the agent
when one answers within 1.5 s; `--qga` (or `WINVM_NO_AGENT=1`) forces qemu-ga.
Note the identity difference above: `whoami` answers `winvm\administrator`
through the agent and `nt authority\system` through qemu-ga.

## How it is reached

`127.0.0.1:<hostPort>` on the host → guest `:7801`, a QEMU user-net forward
added at runtime with HMP `hostfwd_add`, **never on the command line** — the
save compatibility hash (saves.ts) covers the hardware arguments, so a forward
there would make every existing save incompatible. The forward dies with its
QEMU process, so `qemu.launch` re-adds it (agentfwd.ts `restoreForward`) for
every instance that has an agent: start, load, stow recall, rewind into a
stopped instance, golden and runner loads. A forward added before an
`-incoming` load survives it: the agent answered 13 ms after `winvm load`
returned. `loadvm` within a running QEMU keeps it.

`<instance>/agent.json` (0600) holds `{token, hostPort}`. The host port is
picked free on first use and kept; if it is taken later, a new one is chosen.

The guest can reach the host at `http://10.0.2.2:<port>` (slirp maps it to the
host's loopback); `install` uses that to serve bun when the guest has none.

## Auth

A per-instance random token (32 bytes), written by the host over qemu-ga to
`C:\ProgramData\winvm\agent\token` (ACL: Administrators and SYSTEM). Every
request carries `Authorization: Bearer <token>`. The agent re-reads the file
when it changes, so the host can set or rotate it at any time without a
restart — which is how an agent baked into an image, or restored from a save
another instance took, is adopted (`ensure`, ~12 ms). No token file: every
request is refused. The agent also accepts connections only from 10.0.2.2 and
loopback, and the firewall rule allows the port for that program from
10.0.2.2 only.

## In the guest

`C:\ProgramData\winvm\agent\`: `bun.exe` (its own copy, from
`C:\payload\bun-windows-aarch64` or served by the host), `guestagent.ts`,
`runinsession.exe` (compiled in the guest from `assets/runinsession.cs` with
Add-Type), `token`, `agent.log`. The HKLM Run key `winvm-agent` starts
`conhost.exe --headless bun.exe guestagent.ts --supervise …` at every logon, in
the user's session; `--supervise` restarts it if it dies (2.6 s measured). It
also closes the audit-mode Sysprep dialog after logon.

Process tree: supervisor → agent (HTTP) → spawner. Everything that starts a
process runs in the spawner, which is started **before** the agent listens.
That is the fix for the worst bug found: on Windows Bun's sockets are
inheritable and libuv spawns with `bInheritHandles`, so every child got the
listening socket, and a GUI program started through `/launch` held `:7801`
after the agent exited — the next agent could not listen. bun:ffi is not in
the Windows ARM64 build, so the flag cannot be cleared; the spawner never has
the socket. Launched programs are spawned detached (outside libuv's
kill-on-close job) and survive agent restarts.

## Baking it into an image

`assets/agent-install.ps1 -Source <dir with guestagent.ts, runinsession.cs> -NoStart`
from provisioning: installs everything and sets the Run key, with no token.
Instances from that image then need only `agent.ensure(name)`, which writes the
token over qemu-ga and adds the forward. At runtime, `agent.install(name)`
stages the same files over qemu-ga and runs the same script.

## Bun quirks met on the way (1.3.14)

- `Bun.write(path, response)` spins at 100% CPU forever on a response through
  slirp; `getFile` streams chunk by chunk instead.
- `mkdirSync(dir, {recursive: true})` throws EEXIST for `C:\Users\Public`.
- bun:ffi `dlopen` is unavailable on Windows ARM64 ("TinyCC is disabled").
