import type { FakeAgent } from "./agent"
import type { FakeQmp } from "./qmp"

type Json = Record<string, unknown>

interface Ran {
  readonly stdout: string
  readonly bootQuery: boolean
}

export class FakeGuest {
  status = "running"
  bootTime = "2026-11-17T08:00:00.0000000+00:00"
  offsetMs = 0
  reboots = 0
  resetDelayMs = 0
  bootDelayMs = 0
  holdBootQuery = false
  shutdownRequests: string[] = []
  private readonly runs = new Map<number, Ran>()
  private nextPid = 4000
  private readonly qmp: FakeQmp

  constructor(qmp: FakeQmp, agent: FakeAgent) {
    this.qmp = qmp
    qmp.handler = (cmd) => this.monitor(cmd)
    agent.handler = (req) => this.guest(req)
  }

  private monitor(cmd: Json): Json {
    switch (cmd.execute) {
      case "query-status":
        return {
          return: { status: this.status, running: this.status === "running" },
        }
      case "query-chardev":
        return { return: [{ label: "qga0", "frontend-open": true }] }
      case "stop":
        this.status = "paused"
        this.qmp.emit({
          event: "STOP",
          timestamp: { seconds: 1, microseconds: 0 },
        })
        return { return: {} }
      case "cont":
        this.status = "running"
        this.qmp.emit({
          event: "RESUME",
          timestamp: { seconds: 2, microseconds: 0 },
        })
        return { return: {} }
      default:
        return { return: {} }
    }
  }

  private exec(a: Json): Json {
    const path = String(a.path)
    const arg = Array.isArray(a.arg) ? a.arg.map(String) : []
    const script = arg.join(" ")
    let stdout = ""
    if (path.toLowerCase().endsWith("cmd.exe"))
      stdout = `${arg.at(-1) ?? ""}\r\n`
    else if (script.includes("LastBootUpTime")) stdout = `${this.bootTime}\r\n`
    else if (script.includes("UserName")) stdout = "PC\\winvm\r\n"
    this.nextPid += 1
    this.runs.set(this.nextPid, {
      stdout,
      bootQuery: script.includes("LastBootUpTime"),
    })
    return { return: { pid: this.nextPid } }
  }

  private reboot(): void {
    this.reboots += 1
    const next = `2026-11-17T09:00:${String(this.reboots).padStart(2, "0")}.0000000+00:00`
    if (this.bootDelayMs === 0) this.bootTime = next
    else
      setTimeout(() => {
        this.bootTime = next
      }, this.bootDelayMs)
    setTimeout(() => {
      this.qmp.emit({
        event: "RESET",
        data: { guest: true, reason: "guest-reset" },
        timestamp: { seconds: 3, microseconds: 0 },
      })
    }, this.resetDelayMs)
  }

  private guest(req: Json): Json {
    const a = (req.arguments ?? {}) as Json
    switch (req.execute) {
      case "guest-ping":
        return { return: {} }
      case "guest-exec":
        return this.exec(a)
      case "guest-exec-status": {
        const ran = this.runs.get(Number(a.pid))
        if (ran?.bootQuery === true && this.holdBootQuery)
          return { return: { exited: false } }
        return {
          return: {
            exited: true,
            exitcode: 0,
            "out-data": Buffer.from(ran?.stdout ?? "").toString("base64"),
          },
        }
      }
      case "guest-get-users":
        return { return: [{ user: "winvm", domain: "PC" }] }
      case "guest-get-time":
        return { return: Math.round((Date.now() + this.offsetMs) * 1e6) }
      case "guest-set-time":
        this.offsetMs = Number(a.time) / 1e6 - Date.now()
        return { return: {} }
      case "guest-shutdown":
        this.shutdownRequests.push(String(a.mode))
        if (a.mode === "reboot") this.reboot()
        return { return: {} }
      default:
        return { return: {} }
    }
  }
}
