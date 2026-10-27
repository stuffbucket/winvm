/**
 * Deciding when a guest is idle enough to save — pure logic, no I/O.
 *
 * The watcher (watch.ts) samples the world every tick and hands the numbers to
 * an IdleMachine, which answers with what to do. Everything that touches a
 * clock, a process or a socket is outside this file, so the decisions can be
 * tested with a fake clock and fake samples.
 *
 * ## What "idle" means
 *
 * ALL of these, continuously, for the configured period:
 *
 *   - guest CPU low: QEMU's own CPU time, as a share of the guest's vCPU
 *     capacity, averaged over the last minute, below `idleCpuPercent`. The
 *     average is what keeps one Defender or indexer burst from restarting the
 *     clock, while anything sustained still does;
 *   - no `winvm exec` (or other guest command) recently — commands touch an
 *     activity file that the watcher reads;
 *   - no VNC client connected. QEMU cannot say whether a connected viewer is
 *     being used, and saving or stowing under someone's live session is the
 *     wrong default, so a connected viewer counts as activity.
 *
 * ## Our own actions are not activity
 *
 * Saving pauses the guest and has QEMU write out its RAM; the guest catches up
 * afterwards. Counted, that CPU would re-arm autosave after every autosave and
 * produce one every `idleMinutes` forever. So samples spanning an action and a
 * short settle window after it are discarded (`actionDone`).
 *
 * ## Host sleep
 *
 * A Mac that sleeps freezes the guest along with everything else, and the guest
 * wakes with its clock behind by however long the lid was shut. The only
 * trustworthy sign is the WALL clock jumping between ticks by much more than
 * the tick interval (timer counts and monotonic clocks differ on whether they
 * advance during sleep). A wake asks for a clock sync and restarts the idle
 * timer: the person who just opened the lid is about to use the guest, so the
 * hours it spent asleep must not count towards stowing it.
 */

/** One observation, taken by the watcher at `wallMs`. */
export interface Sample {
  readonly wallMs: number
  /** Share (0..1) of the guest's vCPU capacity used since the previous sample; null if unknown. */
  readonly cpu: number | null
  /** Last `winvm exec`/command activity (activity file mtime), or null if none recorded. */
  readonly activityAtMs: number | null
  /** Connected VNC clients; null if QMP could not be asked. */
  readonly vncClients: number | null
}

export interface Settings {
  readonly idleCpuPercent: number
  readonly autosave: { readonly enabled: boolean; readonly idleMinutes: number }
  readonly stow: { readonly enabled: boolean; readonly idleMinutes: number }
}

export interface Timing {
  /** The interval the watcher sleeps between ticks. */
  readonly tickMs: number
  /** Wall time between ticks beyond `tickMs` that means the host slept (or the clock jumped). */
  readonly wakeGapMs: number
  /** Window the CPU average is taken over. */
  readonly cpuWindowMs: number
  /** After one of our own actions, ignore CPU for this long. */
  readonly settleMs: number
  /** How often to ask the guest how far its clock has drifted. */
  readonly driftCheckMs: number
}

export const DEFAULT_TIMING: Timing = {
  tickMs: 15_000,
  wakeGapMs: 45_000,
  cpuWindowMs: 60_000,
  settleMs: 60_000,
  driftCheckMs: 30 * 60_000,
}

/** Drift the periodic check tolerates before resyncing the guest clock. */
export const DRIFT_TOLERANCE_MS = 2_000

export type Decision =
  | { readonly kind: "autosave" }
  | { readonly kind: "stow" }
  | { readonly kind: "syncClock"; readonly reason: "wake" | "clock-jump" }
  | { readonly kind: "checkDrift" }

/** Why the last sample did or did not count as idle — for the log. */
export interface Verdict {
  readonly quiet: boolean
  readonly cpuAvg: number | null
  readonly reasons: readonly string[]
  readonly woke: boolean
}

export class IdleMachine {
  /** Start of the current idle stretch. */
  idleSinceMs: number
  /** Whether this idle stretch may still produce an autosave. */
  autosaveArmed = true
  stowing = false
  private prevWallMs: number | null = null
  private ignoreCpuUntilMs: number
  private lastDriftCheckMs: number
  private cpuWindow: { readonly at: number; readonly cpu: number }[] = []
  lastVerdict: Verdict = { quiet: false, cpuAvg: null, reasons: ["starting"], woke: false }

  private readonly timing: Timing

  constructor(nowMs: number, timing: Timing = DEFAULT_TIMING) {
    this.timing = timing
    // Being started is activity: a watcher starts when the guest does.
    this.idleSinceMs = nowMs
    this.ignoreCpuUntilMs = nowMs
    this.lastDriftCheckMs = nowMs
  }

  idleMs(nowMs: number): number {
    return Math.max(0, nowMs - this.idleSinceMs)
  }

  /** Something happened that is activity by definition (e.g. a wake). Does not re-arm autosave. */
  private restartIdle(nowMs: number): void {
    this.idleSinceMs = nowMs
    this.cpuWindow = []
  }

  /** The guest was genuinely used: restart the idle clock AND allow another autosave. */
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
      // The CPU delta across a sleep is meaningless (QEMU was frozen), and the
      // time asleep is not idle time someone chose. Start over from now.
      this.restartIdle(s.wallMs)
      this.ignoreCpuUntilMs = s.wallMs + this.timing.settleMs
      this.lastDriftCheckMs = s.wallMs
      this.lastVerdict = { quiet: false, cpuAvg: null, reasons: ["host woke"], woke }
      return decisions
    }

    // ---- CPU, averaged over a window, ignoring our own actions' wake.
    if (s.cpu !== null && s.wallMs >= this.ignoreCpuUntilMs) {
      this.cpuWindow.push({ at: s.wallMs, cpu: s.cpu })
    }
    this.cpuWindow = this.cpuWindow.filter((c) => s.wallMs - c.at < this.timing.cpuWindowMs)
    const cpuAvg =
      this.cpuWindow.length === 0 ? null : this.cpuWindow.reduce((a, c) => a + c.cpu, 0) / this.cpuWindow.length
    let quiet = true
    if (cpuAvg !== null && cpuAvg * 100 >= cfg.idleCpuPercent) {
      quiet = false
      reasons.push(`cpu ${(cpuAvg * 100).toFixed(1)}%`)
      this.active(s.wallMs)
    }

    // ---- Commands run through winvm.
    if (s.activityAtMs !== null && s.activityAtMs > this.idleSinceMs) {
      quiet = false
      reasons.push("exec")
      this.active(Math.min(s.activityAtMs, s.wallMs))
    }

    // ---- A viewer is attached.
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
      // Stow saves too, so it supersedes an autosave due at the same moment.
      this.stowing = true
      decisions.push({ kind: "stow" })
    } else if (cfg.autosave.enabled && this.autosaveArmed && idle >= cfg.autosave.idleMinutes * 60_000) {
      this.autosaveArmed = false
      decisions.push({ kind: "autosave" })
    }
    return decisions
  }

  /**
   * One of our own actions finished at `nowMs`. Its duration is not a tick gap,
   * and the CPU it cost is not the guest being used.
   */
  actionDone(nowMs: number): void {
    this.prevWallMs = nowMs
    this.ignoreCpuUntilMs = nowMs + this.timing.settleMs
    this.cpuWindow = []
  }

  /**
   * QEMU was replaced under us (a `load`, or a `rewind` from stopped): the guest
   * is in a new state someone chose, which is activity — and worth an autosave
   * once it has been idle again. The restore's CPU is not counted.
   */
  restarted(nowMs: number): void {
    this.idleSinceMs = nowMs
    this.autosaveArmed = true
    this.actionDone(nowMs)
  }

  /** An autosave that could not run this round (another save/load held the instance): try again next tick. */
  autosaveSkipped(): void {
    this.autosaveArmed = true
  }

  /** A stow that failed: go back to watching, and wait a full period before trying again. */
  stowFailed(nowMs: number): void {
    this.stowing = false
    this.restartIdle(nowMs)
  }
}

/** What rotation needs from a save's manifest. */
export interface SaveInfo {
  readonly name: string
  readonly kind: string
  readonly createdAt: string
}

/**
 * The auto saves to delete so that only the newest `keep` remain. Never names a
 * save of any other kind — manual, baseline and stow saves are the user's.
 */
export function savesToRotate(saves: readonly SaveInfo[], keep: number): readonly string[] {
  const autos = saves
    .filter((s) => s.kind === "auto")
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.name.localeCompare(a.name))
  return autos.slice(Math.max(0, keep)).map((s) => s.name)
}

/** `auto-20261021T164300Z` — sortable, filesystem-safe, and unambiguous about the zone. */
export function autosaveName(nowMs: number): string {
  return `auto-${new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`
}
