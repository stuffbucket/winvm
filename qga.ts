/**
 * The QEMU guest agent client — the whole reason this VM is scriptable.
 *
 * qemu-ga listens on a virtio-serial port and speaks line-delimited JSON. That
 * gives "run a command in the guest, get stdout, stderr and the exit code" with
 * no SSH, no listening TCP port, and no dependency on guest networking.
 *
 * The alternative was UTM's `utmctl exec`, which does the same thing over Apple
 * Events and therefore needs a logged-in Aqua session plus an interactive TCC
 * grant — upstream's own error text says it "does not work from SSH sessions or
 * before logging in".
 */
import { connect } from "node:net"

import { monitorBeside } from "./paths"
import * as qmp from "./qmp"

/** The chardev id qemu.ts gives the guest agent's socket. */
export const CHARDEV = "qga0"

export interface ExecResult {
  readonly exitcode: number
  readonly stdout: string
  readonly stderr: string
}

/** A call the agent did not answer in time. Distinct so a caller can recover from it. */
export class AgentTimeout extends Error {
  constructor() {
    super("guest agent timed out")
    this.name = "AgentTimeout"
  }
}

/** Byte that delimits guest-sync-delimited's reply. Never appears in UTF-8 JSON. */
const DELIMITER = 0xff
const NEWLINE = 0x0a

/**
 * One request, one reply — on a channel that is synced first.
 *
 * THE SYNC IS NOT OPTIONAL. The agent sits behind a single virtio-serial port
 * and answers every request it was sent, whether or not anyone is still
 * listening. A call that timed out leaves its reply in flight, and the next
 * connection — this process or another one — used to read that stale reply as
 * its own: a `guest-exec` handed the previous call's pid, a status poll handed
 * another command's output. So every call first sends guest-sync-delimited
 * with a random id. The agent answers requests in order, so anything still
 * owed to an earlier caller arrives before the 0xFF that opens our sync reply;
 * everything before a delimiter, and any sync reply carrying another id, is
 * discarded. The leading 0xFF the client sends also makes the agent drop any
 * half-received request a previous caller abandoned mid-write.
 */
export async function call(
  sockPath: string,
  payload: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const id = Math.floor(Math.random() * 2 ** 31)
  return await new Promise((res, rej) => {
    const sock = connect(sockPath)
    let synced = false
    let inSyncReply = false
    // The current line so far, kept as chunks so a multi-megabyte reply is not
    // re-copied on every read.
    let pending: Buffer[] = []
    const settle = (fn: () => void): void => {
      clearTimeout(timer)
      sock.destroy()
      fn()
    }
    const timer = setTimeout(() => {
      settle(() => rej(new AgentTimeout()))
    }, timeoutMs)
    sock.on("connect", () => {
      const sync = JSON.stringify({ execute: "guest-sync-delimited", arguments: { id } })
      sock.write(Buffer.concat([Buffer.from([DELIMITER]), Buffer.from(`${sync}\n`)]))
    })
    sock.on("data", (chunk: Buffer) => {
      let data = chunk
      while (!synced) {
        if (!inSyncReply) {
          const ff = data.indexOf(DELIMITER)
          if (ff < 0) return
          data = data.subarray(ff + 1)
          inSyncReply = true
        }
        const nl = data.indexOf(NEWLINE)
        if (nl < 0) {
          pending.push(data)
          return
        }
        const line = Buffer.concat([...pending, data.subarray(0, nl)]).toString("utf8")
        data = data.subarray(nl + 1)
        pending = []
        inSyncReply = false
        if (syncReplyId(line) === id) {
          synced = true
          sock.write(`${JSON.stringify(payload)}\n`)
        }
      }
      const nl = data.indexOf(NEWLINE)
      if (nl < 0) {
        pending.push(data)
        return
      }
      const line = Buffer.concat([...pending, data.subarray(0, nl)]).toString("utf8")
      settle(() => {
        try {
          res(JSON.parse(line) as Record<string, unknown>)
        } catch (error) {
          rej(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
    sock.on("error", (error) => {
      settle(() => rej(error))
    })
  })
}

function syncReplyId(line: string): unknown {
  try {
    return (JSON.parse(line) as { return?: unknown }).return
  } catch {
    return undefined
  }
}

/**
 * Whether qemu-ga in the guest has its end of the virtio-serial port open, as
 * QEMU sees it (query-chardev's "frontend-open"). Null when the monitor does
 * not say: unknown, so the caller should just try the agent.
 */
export async function portOpen(sockPath: string): Promise<boolean | null> {
  try {
    const r = (await qmp.execute(monitorBeside(sockPath), "query-chardev", undefined, 2000)) as {
      readonly label: string
      readonly "frontend-open": boolean
    }[]
    return r.find((c) => c.label === CHARDEV)?.["frontend-open"] ?? null
  } catch {
    return null
  }
}

export interface WaitOptions {
  /** Injectable for tests; QEMU's monitor otherwise. */
  readonly portOpen?: (sockPath: string) => Promise<boolean | null>
}

/**
 * Poll until the agent answers. A cold boot to a responsive agent is ~10-25 s.
 *
 * DO NOT CONNECT BEFORE THE GUEST HAS OPENED ITS PORT. QEMU on macOS cannot
 * see a client hang up while the guest end is closed: char-socket watches for
 * the hangup with a G_IO_HUP-only source, and GLib polls with select() on
 * macOS (poll() is marked broken there), which has no way to ask for HUP —
 * so the only way QEMU learns of it is by reading, and it reads only while
 * the guest can take the data. A probe that gave up before qemu-ga started
 * therefore left QEMU holding a dead connection; the socket accepts one
 * client at a time with a backlog of one, so the next probe sat unanswered
 * and the one after was refused outright (Bun reports that as ENOENT). It
 * cleared itself once qemu-ga opened the port, but by then the probes were
 * spaced seconds apart. Measured on a fresh boot: a client closed at 8 s was
 * held as connected until qemu-ga opened at 14.3 s.
 *
 * So wait on QEMU's view of the port first (one monitor round trip), and ping
 * only once it is open. Measured on fresh boots: no connection at all until
 * qemu-ga opened the port at ~10.8 s, and the ping answered 0.1 s after.
 * Anything else that connects early (a stray `status`, a script) can still
 * leave a dead client behind; it clears when qemu-ga opens the port.
 */
export async function waitFor(sockPath: string, timeoutMs: number, o: WaitOptions = {}): Promise<boolean> {
  const isOpen = o.portOpen ?? portOpen
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await isOpen(sockPath)) === false) {
      await new Promise((r) => setTimeout(r, 250))
      continue
    }
    try {
      await call(sockPath, { execute: "guest-ping" }, 4000)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  return false
}

/**
 * Poll until Windows has FINISHED STARTING — a state of the OS, not a sign of
 * life from the channel.
 *
 * THE DISTINCTION IS THE WHOLE POINT, AND GETTING IT WRONG COSTS INSTANCES.
 * qemu-ga runs as SYSTEM and answers long before any logon, so `guest-ping`
 * succeeds throughout OOBE — and so does `guest-exec`, and so does anything else
 * that merely asks whether the agent is alive. A guest sitting on "Just a
 * moment, checking for updates" satisfies every one of those probes while being
 * nowhere near settled. Two earlier versions of this function gated on exactly
 * that and were meaningless: `start` reported the guest up, `smoke` returned
 * correct answers, and the machine was still in OOBE the entire time.
 *
 * WHAT IS ASKED INSTEAD: has the REAL account logged on?
 *
 * Windows runs the out-of-box experience under a temporary account called
 * `defaultuser0`, and it runs a full session as it — Explorer included. While
 * that session is on screen showing "Checking for updates", the guest already
 * reports `OOBEInProgress = 0` AND `SystemSetupInProgress = 0` AND a running
 * `explorer.exe`. Every one of those was tried here and every one was true too
 * early. `Win32_ComputerSystem.UserName` is not: it reads `<HOST>\defaultuser0`
 * throughout OOBE and only becomes the answer file's account once AutoLogon has
 * actually taken the machine to its desktop. That is the end of the lifecycle,
 * and it is unambiguous.
 *
 * It matters beyond tidiness: freezing a guest mid-OOBE and restoring it
 * LIVELOCKS the machine — every vCPU at 100%, no disk I/O, recoverable only by
 * killing it. Snapshots must not be taken until this returns true.
 */
export async function waitReady(sockPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  if (!(await waitFor(sockPath, timeoutMs))) return false
  while (Date.now() < deadline) {
    try {
      const r = await exec(sockPath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_ComputerSystem).UserName",
      ])
      const user = r.stdout.trim()
      // Matched by SHAPE, not by name: this file knows nothing about which
      // account a caller's answer file creates, only that OOBE's own temporary
      // one is `defaultuser<n>`.
      if (user !== "" && !/\\defaultuser\d+$/i.test(user)) return true
    } catch {
      // The agent drops in and out across OOBE's reboots; keep asking.
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  return false
}

/**
 * After a rewind: the restored guest is already past OOBE (a snapshot can only
 * be taken once `waitReady` passed), so all that matters is that the agent is
 * serving commands again. `waitReady`'s PowerShell + CIM probe costs ~20 s per
 * try on ARM64; one `cmd /c echo` costs ~2 s. The nonce makes sure the answer
 * came from a command started after the restore, not a reply left over from
 * before it.
 */
export async function waitResponsive(sockPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  if (!(await waitFor(sockPath, timeoutMs))) return false
  const nonce = `winvm-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  while (Date.now() < deadline) {
    try {
      const r = await exec(sockPath, "C:\\Windows\\System32\\cmd.exe", ["/c", "echo", nonce])
      if (r.stdout.includes(nonce)) return true
    } catch {
      // The agent reconnects after the restore; keep asking.
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/**
 * `guest-exec` starts a process and returns immediately; the output is only
 * available once `guest-exec-status` reports it exited, so this polls. Output
 * arrives base64-encoded.
 */
export async function exec(sockPath: string, path: string, args: readonly string[]): Promise<ExecResult> {
  const started = await call(sockPath, {
    execute: "guest-exec",
    arguments: { path, arg: [...args], "capture-output": true },
  })
  const pid = (started["return"] as { pid?: number } | undefined)?.pid
  if (pid === undefined) throw new Error(`guest-exec failed: ${JSON.stringify(started)}`)

  const deadline = Date.now() + 900_000
  // Poll fast first, then back off: most commands finish in well under a
  // second, and a fixed 1 s poll made every exec cost at least that (measured:
  // `cmd /c echo` 1.06 s at 1 s, 75-190 ms at 25 ms). Long commands settle at
  // 500 ms so a 15-minute install doesn't hammer the agent.
  let pollMs = 25
  while (Date.now() < deadline) {
    const st = (await call(sockPath, { execute: "guest-exec-status", arguments: { pid } }))["return"] as
      | { exited?: boolean; exitcode?: number; "out-data"?: string; "err-data"?: string }
      | undefined
    if (st?.exited === true) {
      const dec = (s: string | undefined): string =>
        s === undefined ? "" : Buffer.from(s, "base64").toString("utf8")
      return { exitcode: st.exitcode ?? 0, stdout: dec(st["out-data"]), stderr: dec(st["err-data"]) }
    }
    await new Promise((r) => setTimeout(r, pollMs))
    pollMs = Math.min(pollMs * 2, 500)
  }
  throw new Error("guest command timed out")
}

/** Ask the guest to power down. The socket drops as it goes; that is success. */
export async function shutdown(sockPath: string): Promise<void> {
  try {
    await call(sockPath, { execute: "guest-shutdown", arguments: { mode: "powerdown" } }, 5000)
  } catch {
    // Expected: the agent stops answering mid-request.
  }
}

/**
 * guest-file-read's count. KEPT WELL UNDER WHAT THE AGENT CAN ANSWER: measured
 * against qemu-ga on the Windows 11 ARM64 guest, a read of 1,900,000 bytes
 * comes back in ~15 ms and one of 1,950,000 never comes back at all — no
 * reply, no error, while the file position still advances past the data. A
 * count of 4 MiB therefore hung every read of a file larger than about 1.9 MB.
 * Smaller is slower — each chunk is a round trip; 6 MiB took ~0.7 s at 1 MiB,
 * ~1.1 s at 512 KiB, ~2.3 s at 256 KiB — so this keeps a wide margin under the
 * ceiling without paying much for it.
 */
export const READ_CHUNK = 512 * 1024
const MIN_READ_CHUNK = 16 * 1024

export interface ReadOptions {
  readonly chunk?: number
  /** Per guest-file-read. A chunk is milliseconds of work; waiting longer only delays the recovery below. */
  readonly chunkTimeoutMs?: number
}

/**
 * Read a guest file whole, in chunks. Null if it cannot be opened.
 *
 * A chunk whose reply never arrives is retried smaller, after seeking back:
 * the guest moved its file position whether or not the reply made it, so a
 * plain retry would silently skip that data. That covers a guest whose ceiling
 * sits lower than the one measured above.
 */
export async function readFile(sockPath: string, guestPath: string, o: ReadOptions = {}): Promise<Buffer | null> {
  const open = await call(sockPath, { execute: "guest-file-open", arguments: { path: guestPath, mode: "rb" } })
  const handle = open["return"]
  if (typeof handle !== "number") return null
  const parts: Buffer[] = []
  let offset = 0
  let count = o.chunk ?? READ_CHUNK
  try {
    for (;;) {
      let r: Record<string, unknown>
      try {
        r = await call(sockPath, { execute: "guest-file-read", arguments: { handle, count } }, o.chunkTimeoutMs ?? 15_000)
      } catch (error) {
        if (!(error instanceof AgentTimeout) || count <= MIN_READ_CHUNK) throw error
        const seek = await call(sockPath, { execute: "guest-file-seek", arguments: { handle, offset, whence: "set" } })
        if (seek["error"] !== undefined) throw new Error(`guest-file-seek ${guestPath}: ${JSON.stringify(seek["error"])}`)
        count = Math.max(MIN_READ_CHUNK, Math.floor(count / 2))
        continue
      }
      const ret = r["return"] as { "buf-b64"?: string; count?: number; eof?: boolean } | undefined
      if (ret === undefined) throw new Error(`guest-file-read ${guestPath}: ${JSON.stringify(r["error"] ?? r)}`)
      const bytes = Buffer.from(ret["buf-b64"] ?? "", "base64")
      parts.push(bytes)
      offset += bytes.length
      if (ret.eof === true || bytes.length === 0) break
    }
  } finally {
    await call(sockPath, { execute: "guest-file-close", arguments: { handle } }).catch(() => undefined)
  }
  return Buffer.concat(parts)
}
