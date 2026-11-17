import { spawnSync } from "node:child_process"

import { qmpCommand } from "./monitor"
import type { Paths } from "./paths"
import * as qemu from "./qemu"

export function parseHidIdleSeconds(ioreg: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg)
  return m?.[1] === undefined ? null : Number(m[1]) / 1e9
}

export function hostIdleSeconds(): number | null {
  if (process.platform !== "darwin") return null
  const r = spawnSync("ioreg", ["-c", "IOHIDSystem", "-d", "4"], {
    encoding: "utf8",
    timeout: 3000,
  })
  return r.status === 0 ? parseHidIdleSeconds(r.stdout) : null
}

export const AT_THE_MAC_S = 20

export const SLOW_MONITOR_MS = 1500

export const LATE_TICK_MS = 2500

export interface Timed<T> {
  readonly ms: number | null
  readonly value: T | null
  readonly error?: string
}

export interface MouseInfo {
  readonly name: string
  readonly current: boolean
  readonly absolute: boolean
}

export interface InputProbe {
  readonly pid: number | null
  readonly processState: string | null
  readonly status: Timed<string>
  readonly vncClients: Timed<number>
  readonly mice: Timed<readonly MouseInfo[]>
}

export type Level = "ok" | "problem" | "unknown"

export interface InputFinding {
  readonly level: Level
  readonly title: string
  readonly detail: string
}

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const t0 = performance.now()
  try {
    const value = await fn()
    return { ms: Math.round(performance.now() - t0), value }
  } catch (error) {
    return {
      ms: null,
      value: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function processState(pid: number): string | null {
  const r = spawnSync("ps", ["-o", "state=", "-p", String(pid)], {
    encoding: "utf8",
  })
  const s = r.status === 0 ? r.stdout.trim() : ""
  return s === "" ? null : s
}

export async function probeInput(
  p: Paths,
  timeoutMs = 5000,
): Promise<InputProbe> {
  const pid = qemu.pidOf(p)
  const status = await timed(async () => {
    const r = (await qmpCommand(p.qmp, "query-status", undefined, timeoutMs)) as
      | { status?: unknown }
      | undefined
    return typeof r?.status === "string" ? r.status : "unknown"
  })
  const vncClients = await timed(async () => {
    const r = (await qmpCommand(p.qmp, "query-vnc", undefined, timeoutMs)) as
      | { clients?: unknown[] }
      | undefined
    return Array.isArray(r?.clients) ? r.clients.length : 0
  })
  const mice = await timed(async () => {
    const r = (await qmpCommand(p.qmp, "query-mice", undefined, timeoutMs)) as
      | { name?: unknown; current?: unknown; absolute?: unknown }[]
      | undefined
    return (Array.isArray(r) ? r : []).map((m) => ({
      name: String(m.name),
      current: m.current === true,
      absolute: m.absolute === true,
    }))
  })
  return {
    pid,
    processState: pid === null ? null : processState(pid),
    status,
    vncClients,
    mice,
  }
}

export function judgeInput(probe: InputProbe): readonly InputFinding[] {
  const out: InputFinding[] = []
  if (probe.pid === null) {
    return [
      {
        level: "problem",
        title: "QEMU is not running",
        detail: "No process for this machine: `winvm start` runs it.",
      },
    ]
  }
  if (probe.processState?.startsWith("T")) {
    out.push({
      level: "problem",
      title: "QEMU is stopped by a signal",
      detail: `ps shows state ${probe.processState} for pid ${String(probe.pid)}: something sent SIGSTOP (Ctrl-Z in a terminal that started it?). \`kill -CONT ${String(probe.pid)}\` resumes it.`,
    })
  } else if (probe.processState !== null && /^[UZ]/.test(probe.processState)) {
    out.push({
      level: "problem",
      title: `QEMU is in an uninterruptible state (${probe.processState})`,
      detail:
        "Stuck in the kernel, usually waiting on disk. Capture `sample " +
        String(probe.pid) +
        " 3` now.",
    })
  }

  const s = probe.status
  if (s.ms === null) {
    out.push({
      level: "problem",
      title: "QEMU's monitor did not answer",
      detail: `${s.error ?? "no answer"}. The monitor is served by QEMU's main loop, the same one that reads VNC input: a stalled loop (or another client holding the monitor) looks like a frozen mouse and keyboard. Capture \`sample ${String(probe.pid)} 3 -file /tmp/qemu-sample.txt\`.`,
    })
  } else {
    if (s.ms >= SLOW_MONITOR_MS) {
      out.push({
        level: "problem",
        title: `QEMU's main loop answered slowly (${String(s.ms)} ms)`,
        detail:
          "Input is read on that loop. Busy with a save or screen dump, or the host is paging QEMU in. Check `vm_stat`, `sysctl vm.swapusage`, and `sample` the process.",
      })
    }
    if (s.value !== "running") {
      out.push({
        level: "problem",
        title: `the machine is ${String(s.value)}, not running`,
        detail:
          "Paused or asleep: the guest executes nothing, and input is dropped (the app) or waits in QEMU (the CLI). Resume it first.",
      })
    }
  }

  const v = probe.vncClients
  if (v.ms !== null && v.value === 0) {
    out.push({
      level: "problem",
      title: "no viewer is connected to the VNC server",
      detail:
        "The window's connection is down (it shows 'connection lost' and retries every 2 s), or the window is not showing this machine's screen.",
    })
  }

  const m = probe.mice
  if (m.ms !== null && m.value !== null) {
    const current = m.value.find((x) => x.current)
    if (m.value.length === 0 || current === undefined) {
      out.push({
        level: "problem",
        title: "QEMU has no pointer device taking input",
        detail: `query-mice: ${JSON.stringify(m.value)}`,
      })
    } else if (!current.absolute) {
      out.push({
        level: "problem",
        title: `the pointer in use ("${current.name}") is not absolute`,
        detail:
          "The guest should use the USB tablet; with a relative mouse the pointer drifts from the viewer's.",
      })
    }
  }

  if (out.length === 0) {
    out.push({
      level: "ok",
      title:
        "QEMU is running, its monitor answers quickly, a viewer is connected, a tablet is the pointer",
      detail:
        `monitor ${String(s.ms)} ms; ${String(v.value)} viewer(s). If input still does nothing the cause is in the guest (a key or button held down, ` +
        "Windows busy or at a prompt) or in the window (keyboard focus not on the screen, view-only while the app thinks the machine is held).",
    })
  }
  return out
}

export function formatInput(
  name: string,
  findings: readonly InputFinding[],
): string {
  const icon: Record<Level, string> = {
    ok: "ok  ",
    problem: "WARN",
    unknown: "?   ",
  }
  return [
    `input path for "${name}":`,
    ...findings.map((f) => `${icon[f.level]}  ${f.title}\n      ${f.detail}`),
  ].join("\n")
}

export interface Liveness {
  readonly at: number
  readonly monitorMs: number | null
  readonly clients: number | null
  readonly processState?: string | null
}

export class LivenessLog {
  private clients: number | null = null
  private slowSince: number | null = null
  private lastAt: number | null = null

  private readonly tickMs: number

  constructor(tickMs = 15_000) {
    this.tickMs = tickMs
  }

  rebase(at: number): void {
    this.lastAt = at
  }

  observe(o: Liveness): string[] {
    const lines: string[] = []
    if (this.lastAt !== null) {
      const late = o.at - this.lastAt - this.tickMs
      if (late >= LATE_TICK_MS) {
        lines.push(
          `host: this tick came ${(late / 1000).toFixed(1)} s late — the Mac slept briefly or could not run processes; QEMU and the guest stood still that long (see \`pmset -g log\`)`,
        )
      }
    }
    this.lastAt = o.at
    if (o.clients !== null) {
      if (this.clients !== null && o.clients !== this.clients) {
        lines.push(
          `viewer: ${String(this.clients)} -> ${String(o.clients)} VNC client(s)${o.clients === 0 ? " (the window's connection dropped, or it closed the screen)" : ""}`,
        )
      }
      this.clients = o.clients
    }
    const slow = o.monitorMs === null || o.monitorMs >= SLOW_MONITOR_MS
    if (slow && this.slowSince === null) {
      this.slowSince = o.at
      const state =
        o.processState === undefined || o.processState === null
          ? ""
          : `, process state ${o.processState}`
      lines.push(
        o.monitorMs === null
          ? `monitor: QEMU did not answer query-status in time${state}; its main loop (VNC input included) may be stalled. Capture: sample <pid> 3 -file /tmp/qemu-sample.txt`
          : `monitor: query-status took ${String(o.monitorMs)} ms${state}; QEMU's main loop (VNC input included) is slow. Capture: sample <pid> 3 -file /tmp/qemu-sample.txt`,
      )
    } else if (!slow && this.slowSince !== null) {
      lines.push(
        `monitor: answering normally again after ${String(Math.round((o.at - this.slowSince) / 1000))} s (${String(o.monitorMs)} ms)`,
      )
      this.slowSince = null
    }
    return lines
  }
}
