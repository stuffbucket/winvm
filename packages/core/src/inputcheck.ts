/**
 * Is input reaching the guest? Read-only questions to QEMU and the OS, for when
 * the mouse or keyboard "stops working" in a running machine.
 *
 * WHY THIS EXISTS. From the window, every cause looks the same: the picture
 * stops answering. They are different things to fix:
 *
 *   - QEMU's main loop is stalled. It runs the VNC server, the monitor, the USB
 *     devices and the display, so while it is busy (a save, a screen dump, the
 *     host paging it in) no input is read and the picture does not change. A
 *     monitor command that takes seconds to answer is how it shows.
 *   - The machine is paused or asleep: nothing runs, and input waits in QEMU.
 *   - No viewer is connected (the connection dropped and has not come back), so
 *     the window shows a picture nobody is updating.
 *   - QEMU has no absolute pointer, or the process is stopped by a signal.
 *   - Everything above is fine: then the guest itself ignores a working device
 *     (a held key or button, the lock screen, a hung shell) or the viewer does
 *     not send (focus, view-only), which no host-side check can see.
 *
 * `probeInput` asks, `judgeInput` reads the answers (pure, so it is tested), and
 * `LivenessLog` is what the watcher keeps running quietly, one line only when
 * something changes, so the NEXT occurrence has a timeline. None of it sends
 * input or changes anything.
 */
import { spawnSync } from "node:child_process"

import { qmpCommand } from "./monitor"
import type { Paths } from "./paths"
import * as qemu from "./qemu"

/** A monitor command answering slower than this means QEMU's main loop is busy. */
export const SLOW_MONITOR_MS = 1500

export interface Timed<T> {
  /** How long the monitor took to answer; null when it did not answer or errored. */
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
  /** `ps` state letters of QEMU (R, S, U, T = stopped by a signal, Z). */
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
    return { ms: null, value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** QEMU's state letters from `ps`, e.g. "S", "R", "T"; null if unknown. */
export function processState(pid: number): string | null {
  const r = spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" })
  const s = r.status === 0 ? r.stdout.trim() : ""
  return s === "" ? null : s
}

export async function probeInput(p: Paths, timeoutMs = 5000): Promise<InputProbe> {
  const pid = qemu.pidOf(p)
  const status = await timed(async () => {
    const r = (await qmpCommand(p.qmp, "query-status", undefined, timeoutMs)) as { status?: unknown } | undefined
    return typeof r?.status === "string" ? r.status : "unknown"
  })
  const vncClients = await timed(async () => {
    const r = (await qmpCommand(p.qmp, "query-vnc", undefined, timeoutMs)) as { clients?: unknown[] } | undefined
    return Array.isArray(r?.clients) ? r.clients.length : 0
  })
  const mice = await timed(async () => {
    const r = (await qmpCommand(p.qmp, "query-mice", undefined, timeoutMs)) as
      | { name?: unknown; current?: unknown; absolute?: unknown }[]
      | undefined
    return (Array.isArray(r) ? r : []).map((m) => ({ name: String(m.name), current: m.current === true, absolute: m.absolute === true }))
  })
  return { pid, processState: pid === null ? null : processState(pid), status, vncClients, mice }
}

/** What the answers say about input, most important first. */
export function judgeInput(probe: InputProbe): readonly InputFinding[] {
  const out: InputFinding[] = []
  if (probe.pid === null) {
    return [{ level: "problem", title: "QEMU is not running", detail: "No process for this machine: `winvm start` runs it." }]
  }
  if (probe.processState !== null && probe.processState.startsWith("T")) {
    out.push({
      level: "problem",
      title: "QEMU is stopped by a signal",
      detail: `ps shows state ${probe.processState} for pid ${String(probe.pid)}: something sent SIGSTOP (Ctrl-Z in a terminal that started it?). \`kill -CONT ${String(probe.pid)}\` resumes it.`,
    })
  } else if (probe.processState !== null && /^[UZ]/.test(probe.processState)) {
    out.push({
      level: "problem",
      title: `QEMU is in an uninterruptible state (${probe.processState})`,
      detail: "Stuck in the kernel, usually waiting on disk. Capture `sample " + String(probe.pid) + " 3` now.",
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
        detail: "Input is read on that loop. Busy with a save or screen dump, or the host is paging QEMU in. Check `vm_stat`, `sysctl vm.swapusage`, and `sample` the process.",
      })
    }
    if (s.value !== "running") {
      out.push({
        level: "problem",
        title: `the machine is ${String(s.value)}, not running`,
        detail: "Paused or asleep: the guest executes nothing, and input is dropped (the app) or waits in QEMU (the CLI). Resume it first.",
      })
    }
  }

  const v = probe.vncClients
  if (v.ms !== null && v.value === 0) {
    out.push({
      level: "problem",
      title: "no viewer is connected to the VNC server",
      detail: "The window's connection is down (it shows 'connection lost' and retries every 2 s), or the window is not showing this machine's screen.",
    })
  }

  const m = probe.mice
  if (m.ms !== null && m.value !== null) {
    const current = m.value.find((x) => x.current)
    if (m.value.length === 0 || current === undefined) {
      out.push({ level: "problem", title: "QEMU has no pointer device taking input", detail: `query-mice: ${JSON.stringify(m.value)}` })
    } else if (!current.absolute) {
      out.push({
        level: "problem",
        title: `the pointer in use ("${current.name}") is not absolute`,
        detail: "The guest should use the USB tablet; with a relative mouse the pointer drifts from the viewer's.",
      })
    }
  }

  if (out.length === 0) {
    out.push({
      level: "ok",
      title: "QEMU is running, its monitor answers quickly, a viewer is connected, a tablet is the pointer",
      detail:
        `monitor ${String(s.ms)} ms; ${String(v.value)} viewer(s). If input still does nothing the cause is in the guest (a key or button held down, ` +
        "Windows busy or at a prompt) or in the window (keyboard focus not on the screen, view-only while the app thinks the machine is held).",
    })
  }
  return out
}

export function formatInput(name: string, findings: readonly InputFinding[]): string {
  const icon: Record<Level, string> = { ok: "ok  ", problem: "WARN", unknown: "?   " }
  return [
    `input path for "${name}":`,
    ...findings.map((f) => `${icon[f.level]}  ${f.title}\n      ${f.detail}`),
  ].join("\n")
}

/** One observation the watcher makes each tick, from calls it already makes. */
export interface Liveness {
  readonly at: number
  /** query-status's answer time; null = no answer. */
  readonly monitorMs: number | null
  /** Connected VNC clients; null = unknown. */
  readonly clients: number | null
  /** `ps` state of QEMU, for the line about a slow monitor. */
  readonly processState?: string | null
}

/**
 * Turns the watcher's ticks into the few lines worth keeping: a viewer
 * connecting or dropping, and QEMU's monitor going slow or silent, and coming
 * back. Silent while nothing changes.
 */
export class LivenessLog {
  private clients: number | null = null
  private slowSince: number | null = null

  observe(o: Liveness): string[] {
    const lines: string[] = []
    if (o.clients !== null) {
      if (this.clients !== null && o.clients !== this.clients) {
        lines.push(`viewer: ${String(this.clients)} -> ${String(o.clients)} VNC client(s)${o.clients === 0 ? " (the window's connection dropped, or it closed the screen)" : ""}`)
      }
      this.clients = o.clients
    }
    const slow = o.monitorMs === null || o.monitorMs >= SLOW_MONITOR_MS
    if (slow && this.slowSince === null) {
      this.slowSince = o.at
      const state = o.processState === undefined || o.processState === null ? "" : `, process state ${o.processState}`
      lines.push(
        o.monitorMs === null
          ? `monitor: QEMU did not answer query-status in time${state}; its main loop (VNC input included) may be stalled. Capture: sample <pid> 3 -file /tmp/qemu-sample.txt`
          : `monitor: query-status took ${String(o.monitorMs)} ms${state}; QEMU's main loop (VNC input included) is slow. Capture: sample <pid> 3 -file /tmp/qemu-sample.txt`,
      )
    } else if (!slow && this.slowSince !== null) {
      lines.push(`monitor: answering normally again after ${String(Math.round((o.at - this.slowSince) / 1000))} s (${String(o.monitorMs)} ms)`)
      this.slowSince = null
    }
    return lines
  }
}
