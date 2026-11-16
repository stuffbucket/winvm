import { connect } from "node:net"

import { monitorBeside } from "./paths"
import * as qmp from "./qmp"

export const CHARDEV = "qga0"

export interface ExecResult {
  readonly exitcode: number
  readonly stdout: string
  readonly stderr: string
}

export class AgentTimeout extends Error {
  constructor(command = "", timeoutMs = 0) {
    super(command === "" ? "guest agent timed out" : `guest agent timed out: ${command} after ${String(timeoutMs / 1000)} s`)
    this.name = "AgentTimeout"
  }
}

const DELIMITER = 0xff
const NEWLINE = 0x0a

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
    let pending: Buffer[] = []
    const settle = (fn: () => void): void => {
      clearTimeout(timer)
      sock.destroy()
      fn()
    }
    const execute = payload["execute"]
    const timer = setTimeout(() => {
      settle(() => { rej(new AgentTimeout(typeof execute === "string" ? execute : "?", timeoutMs)) })
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
      settle(() => { rej(error) })
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
  readonly portOpen?: (sockPath: string) => Promise<boolean | null>
}

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

export async function waitReady(sockPath: string, timeoutMs: number, o: ReadyOptions = {}): Promise<boolean> {
  return (await untilReady(sockPath, timeoutMs, o)) === "ready"
}

export type Readiness = "ready" | "timeout" | "no-logon"

export interface ReadyOptions {
  readonly noLogonMs?: number
  readonly log?: (line: string) => void
  readonly waitFor?: (sockPath: string, timeoutMs: number) => Promise<boolean>
  readonly loggedOnUser?: (sockPath: string, timeoutMs: number) => Promise<string | null>
  readonly probeMs?: number
  readonly repairAudit?: (sockPath: string) => Promise<boolean>
  readonly pollMs?: number
  readonly repairAfterMs?: number
}

export const REPAIR_AFTER_MS = 45_000

export const PROBE_MS = 15_000
const MAX_REPAIRS = 2

export async function untilReady(sockPath: string, timeoutMs: number, o: ReadyOptions = {}): Promise<Readiness> {
  const deadline = Date.now() + timeoutMs
  if (!(await (o.waitFor ?? waitFor)(sockPath, timeoutMs))) return "timeout"
  const user = o.loggedOnUser ?? loggedOnUser
  const repair = o.repairAudit ?? repairAudit
  const repairAfter = o.repairAfterMs ?? REPAIR_AFTER_MS
  let emptySince: number | null = null
  let checked = false
  let repairs = 0
  let slowNoted = false
  while (Date.now() < deadline) {
    const probe = Math.max(1, Math.min(o.probeMs ?? PROBE_MS, deadline - Date.now()))
    const asked = Date.now()
    const u = await user(sockPath, probe)
    if (u === null && Date.now() - asked >= probe && !slowNoted) {
      slowNoted = true
      o.log?.(`the guest did not say who is logged on within ${String(Math.round(probe / 1000))} s; asking again`)
    }
    if (u !== null && u !== "" && !/\\defaultuser\d+$/i.test(u)) return "ready"
    if (u === "") {
      emptySince ??= Date.now()
      const empty = Date.now() - emptySince
      if (empty >= repairAfter && !checked && repairs < MAX_REPAIRS) {
        checked = true
        if (await repair(sockPath).catch(() => false)) {
          repairs++
          o.log?.("no one had logged on: audit mode had been interrupted; restored it and restarted the guest")
          emptySince = null
          checked = false
        }
      }
      if (emptySince !== null && o.noLogonMs !== undefined && Date.now() - emptySince >= o.noLogonMs) return "no-logon"
    } else if (u !== null) {
      emptySince = null
    }
    await new Promise((r) => setTimeout(r, o.pollMs ?? 5000))
  }
  return "timeout"
}

export async function loggedOnUser(sockPath: string, timeoutMs = PROBE_MS): Promise<string | null> {
  try {
    const r = await call(sockPath, { execute: "guest-get-users" }, timeoutMs)
    if (Array.isArray(r["return"])) return pickUser(r["return"] as readonly GuestUser[])
    if ((r["error"] as { class?: string } | undefined)?.class !== "CommandNotFound") return null
  } catch {
    return null
  }
  try {
    const r = await exec(sockPath, POWERSHELL, ["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystem).UserName"], timeoutMs)
    return r.stdout.trim()
  } catch {
    return null
  }
}

interface GuestUser {
  readonly user?: string
  readonly domain?: string
}

function pickUser(users: readonly GuestUser[]): string {
  const names = users
    .filter((u) => typeof u.user === "string" && u.user !== "")
    .map((u) => (u.domain === undefined || u.domain === "" ? (u.user ?? "") : `${u.domain}\\${u.user ?? ""}`))
  return names.find((n) => !/\\defaultuser\d+$/i.test(n)) ?? names[0] ?? ""
}

export const AUDIT_REPAIR_PS = [
  "$k = 'HKLM:\\SYSTEM\\Setup'",
  "$audit = (Get-ItemProperty \"$k\\Status\" -ErrorAction SilentlyContinue).AuditBoot",
  "$cmd = (Get-ItemProperty $k).CmdLine",
  "if ($audit -ne 1 -or $cmd -match 'windeploy\\.exe$' -or (Get-Process windeploy, audit -ErrorAction SilentlyContinue)) { 'healthy'; exit 0 }",
  "Set-ItemProperty $k -Name CmdLine -Value 'C:\\WINDOWS\\system32\\oobe\\windeploy.exe' -Type String",
  "Set-ItemProperty $k -Name OOBEInProgress -Value 1 -Type DWord",
  "Set-ItemProperty $k -Name SetupType -Value 2 -Type DWord",
  "Set-ItemProperty $k -Name SetupPhase -Value 4 -Type DWord",
  "'repaired'",
  "shutdown.exe /r /t 3 /f",
].join("\n")

async function repairAudit(sockPath: string): Promise<boolean> {
  const encoded = Buffer.from(AUDIT_REPAIR_PS, "utf16le").toString("base64")
  const r = await exec(sockPath, POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded])
  return r.stdout.includes("repaired")
}

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

export async function waitResponsive(sockPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  if (!(await waitFor(sockPath, timeoutMs))) return false
  const nonce = `winvm-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  while (Date.now() < deadline) {
    try {
      const r = await exec(sockPath, "C:\\Windows\\System32\\cmd.exe", ["/c", "echo", nonce])
      if (r.stdout.includes(nonce)) return true
    } catch {
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

export async function exec(sockPath: string, path: string, args: readonly string[], timeoutMs = 900_000): Promise<ExecResult> {
  const started = await call(sockPath, {
    execute: "guest-exec",
    arguments: { path, arg: [...args], "capture-output": true },
  })
  const pid = (started["return"] as { pid?: number } | undefined)?.pid
  if (pid === undefined) throw new Error(`guest-exec failed: ${JSON.stringify(started)}`)

  const deadline = Date.now() + timeoutMs
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

export async function shutdown(sockPath: string): Promise<void> {
  try {
    await call(sockPath, { execute: "guest-shutdown", arguments: { mode: "powerdown" } }, 5000)
  } catch {
  }
}

export async function reboot(sockPath: string): Promise<void> {
  try {
    await call(sockPath, { execute: "guest-shutdown", arguments: { mode: "reboot" } }, 5000)
  } catch {
  }
}

export async function bootTime(sockPath: string): Promise<string | null> {
  try {
    const r = await exec(sockPath, POWERSHELL, [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')",
    ])
    const t = r.stdout.trim()
    return r.exitcode === 0 && t !== "" ? t : null
  } catch {
    return null
  }
}

export interface NewBootOptions extends ReadyOptions {
  readonly bootTime?: (sockPath: string) => Promise<string | null>
  readonly untilReady?: (sockPath: string, timeoutMs: number, o: ReadyOptions) => Promise<Readiness>
  readonly settleMs?: number
}

export async function untilNewBoot(sockPath: string, before: string, timeoutMs: number, o: NewBootOptions = {}): Promise<Readiness> {
  const deadline = Date.now() + timeoutMs
  const ready = o.untilReady ?? untilReady
  const boot = o.bootTime ?? bootTime
  while (Date.now() < deadline) {
    const r = await ready(sockPath, deadline - Date.now(), o)
    if (r !== "ready") return r
    const now = await boot(sockPath)
    if (now !== null && now !== before) return "ready"
    await new Promise((res) => setTimeout(res, o.settleMs ?? 2000))
  }
  return "timeout"
}

export const READ_CHUNK = 512 * 1024
const MIN_READ_CHUNK = 16 * 1024

export interface ReadOptions {
  readonly chunk?: number
  readonly chunkTimeoutMs?: number
}

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
