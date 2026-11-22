export interface Sample {
  readonly wallMs: number
  readonly cpu: number | null
  readonly activityAtMs: number | null
  readonly vncClients: number | null
  readonly frozen?: boolean
}

export interface Settings {
  readonly idleCpuPercent: number
  readonly autosave: { readonly enabled: boolean; readonly idleMinutes: number }
  readonly stow: { readonly enabled: boolean; readonly idleMinutes: number }
}

export interface Timing {
  readonly tickMs: number
  readonly wakeGapMs: number
  readonly cpuWindowMs: number
  readonly settleMs: number
  readonly driftCheckMs: number
}

export const DEFAULT_TIMING: Timing = {
  tickMs: 15_000,
  wakeGapMs: 45_000,
  cpuWindowMs: 60_000,
  settleMs: 60_000,
  driftCheckMs: 30 * 60_000,
}

export const WATCH_TIMING_ENV = "WINVM_WATCH_TIMING"

export function timingFrom(raw: string | undefined): Partial<Timing> {
  let parsed: unknown = null
  try {
    parsed = raw === undefined ? null : JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {}
  const given = parsed as Readonly<Record<string, unknown>>
  return Object.fromEntries(
    Object.keys(DEFAULT_TIMING).flatMap((k) => {
      const v = given[k]
      return typeof v === "number" && Number.isFinite(v) && v > 0
        ? [[k, v]]
        : []
    }),
  )
}

export const DRIFT_TOLERANCE_MS = 2_000

export type Decision =
  | { readonly kind: "autosave" }
  | { readonly kind: "stow" }
  | { readonly kind: "syncClock"; readonly reason: "wake" | "clock-jump" }
  | { readonly kind: "checkDrift" }

export interface Verdict {
  readonly quiet: boolean
  readonly cpuAvg: number | null
  readonly reasons: readonly string[]
  readonly woke: boolean
}

export class IdleMachine {
  idleSinceMs: number
  autosaveArmed = true
  stowing = false
  private prevWallMs: number | null = null
  private ignoreCpuUntilMs: number
  private lastDriftCheckMs: number
  private cpuWindow: { readonly at: number; readonly cpu: number }[] = []
  lastVerdict: Verdict = {
    quiet: false,
    cpuAvg: null,
    reasons: ["starting"],
    woke: false,
  }

  private readonly timing: Timing

  constructor(nowMs: number, timing: Timing = DEFAULT_TIMING) {
    this.timing = timing
    this.idleSinceMs = nowMs
    this.ignoreCpuUntilMs = nowMs
    this.lastDriftCheckMs = nowMs
  }

  idleMs(nowMs: number): number {
    return Math.max(0, nowMs - this.idleSinceMs)
  }

  private restartIdle(nowMs: number): void {
    this.idleSinceMs = nowMs
    this.cpuWindow = []
  }

  private active(atMs: number): void {
    this.idleSinceMs = Math.max(this.idleSinceMs, atMs)
    this.autosaveArmed = true
  }

  tick(s: Sample, cfg: Settings): Decision[] {
    const decisions: Decision[] = []
    const reasons: string[] = []
    let woke = false

    if (this.prevWallMs !== null) {
      const delta = s.wallMs - this.prevWallMs
      if (delta < 0) {
        woke = true
        decisions.push({ kind: "syncClock", reason: "clock-jump" })
      } else if (delta > this.timing.tickMs + this.timing.wakeGapMs) {
        woke = true
        decisions.push({ kind: "syncClock", reason: "wake" })
      }
    }
    this.prevWallMs = s.wallMs

    if (woke) {
      this.restartIdle(s.wallMs)
      this.ignoreCpuUntilMs = s.wallMs + this.timing.settleMs
      this.lastDriftCheckMs = s.wallMs
      this.lastVerdict = {
        quiet: false,
        cpuAvg: null,
        reasons: ["host woke"],
        woke,
      }
      return decisions
    }

    if (s.frozen === true) {
      this.restartIdle(s.wallMs)
      this.lastDriftCheckMs = s.wallMs
      this.lastVerdict = {
        quiet: false,
        cpuAvg: null,
        reasons: ["paused"],
        woke,
      }
      return decisions
    }

    if (s.cpu !== null && s.wallMs >= this.ignoreCpuUntilMs) {
      this.cpuWindow.push({ at: s.wallMs, cpu: s.cpu })
    }
    this.cpuWindow = this.cpuWindow.filter(
      (c) => s.wallMs - c.at < this.timing.cpuWindowMs,
    )
    const cpuAvg =
      this.cpuWindow.length === 0
        ? null
        : this.cpuWindow.reduce((a, c) => a + c.cpu, 0) / this.cpuWindow.length
    let quiet = true
    if (cpuAvg !== null && cpuAvg * 100 >= cfg.idleCpuPercent) {
      quiet = false
      reasons.push(`cpu ${(cpuAvg * 100).toFixed(1)}%`)
      this.active(s.wallMs)
    }

    if (s.activityAtMs !== null && s.activityAtMs > this.idleSinceMs) {
      quiet = false
      reasons.push("exec")
      this.active(Math.min(s.activityAtMs, s.wallMs))
    }

    if (s.vncClients !== null && s.vncClients > 0) {
      quiet = false
      reasons.push(`vnc x${String(s.vncClients)}`)
      this.active(s.wallMs)
    }

    this.lastVerdict = { quiet, cpuAvg, reasons, woke }

    if (s.wallMs - this.lastDriftCheckMs >= this.timing.driftCheckMs) {
      this.lastDriftCheckMs = s.wallMs
      decisions.push({ kind: "checkDrift" })
    }

    if (this.stowing) return decisions
    const idle = this.idleMs(s.wallMs)
    if (cfg.stow.enabled && idle >= cfg.stow.idleMinutes * 60_000) {
      this.stowing = true
      decisions.push({ kind: "stow" })
    } else if (
      cfg.autosave.enabled &&
      this.autosaveArmed &&
      idle >= cfg.autosave.idleMinutes * 60_000
    ) {
      this.autosaveArmed = false
      decisions.push({ kind: "autosave" })
    }
    return decisions
  }

  actionDone(nowMs: number): void {
    this.prevWallMs = nowMs
    this.ignoreCpuUntilMs = nowMs + this.timing.settleMs
    this.cpuWindow = []
  }

  restarted(nowMs: number): void {
    this.idleSinceMs = nowMs
    this.autosaveArmed = true
    this.actionDone(nowMs)
  }

  autosaveSkipped(): void {
    this.autosaveArmed = true
  }

  stowFailed(nowMs: number): void {
    this.stowing = false
    this.restartIdle(nowMs)
  }
}

export interface SaveInfo {
  readonly name: string
  readonly kind: string
  readonly createdAt: string
  readonly protected?: boolean
}

export function savesToRotate(
  saves: readonly SaveInfo[],
  keep: number,
): readonly string[] {
  const autos = saves
    .filter((s) => s.kind === "auto" && s.protected !== true)
    .toSorted(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        b.name.localeCompare(a.name),
    )
  return autos.slice(Math.max(0, keep)).map((s) => s.name)
}

export function autosaveName(nowMs: number): string {
  return `auto-${new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}`
}
