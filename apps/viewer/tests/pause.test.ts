/**
 * Pause, Sleep and Lock: the pure rules under them. Which status answers may
 * land (and what shows meanwhile), what a key does in a held screen, sizes
 * kept while held, the Pause button's menu and the overlay setting.
 */
import { describe, expect, it } from "bun:test"

import type { Output } from "../ui/src/backend"
import { controls, isFrozen, isLivePhase, type Phase, terminalBlocked } from "../ui/src/model"
import { HeldSizes, keyVerdict } from "../ui/src/features/screen/held"
import { DEFAULT_SETTINGS, loadSettings, parseSettings, pauseOverlayArgs, savePauseOverlay } from "../ui/src/features/settings/settings"
import { pauseMenu } from "../ui/src/features/winvm/pauseMenu"
import { phaseAfter, shownPhase, StatusGuard } from "../ui/src/features/winvm/statusGuard"

describe("running, paused and asleep", () => {
  it("are all live, and only paused and asleep are held", () => {
    expect((["running", "starting", "paused", "asleep"] as const).every(isLivePhase)).toBe(true)
    expect((["stopped", "stowed", "missing"] as const).some(isLivePhase)).toBe(false)
    expect([isFrozen("paused"), isFrozen("asleep"), isFrozen("running"), isFrozen("starting")]).toEqual([true, true, false, false])
  })

  it("offer Pause, Sleep and Lock only while running", () => {
    const c = controls("running", false)
    expect([c.pause, c.sleep, c.lock, c.resume]).toEqual([true, true, true, false])
    const s = controls("starting", false)
    // Starting can be paused, but Sleep and Lock need Windows' agent answering.
    expect([s.pause, s.sleep, s.lock]).toEqual([true, false, false])
  })

  it("offer Resume (Wake) and Shut down while paused or asleep, and nothing that needs Windows", () => {
    for (const p of ["paused", "asleep"] as const) {
      const c = controls(p, false)
      expect({ pause: c.pause, resume: c.resume, sleep: c.sleep, lock: c.lock, restart: c.restart, shutDown: c.shutDown, screen: c.screen, terminal: c.terminal }).toEqual({
        pause: false,
        resume: true,
        sleep: false,
        lock: false,
        restart: false,
        shutDown: true,
        screen: true,
        terminal: false,
      })
    }
  })

  it("offer nothing while a command runs", () => {
    for (const p of ["running", "paused", "asleep"] as const) {
      const c = controls(p, true)
      expect([c.pause, c.resume, c.sleep, c.lock]).toEqual([false, false, false, false])
    }
  })

  it("say why a terminal can't open", () => {
    expect(terminalBlocked("paused", false)).toBe("terminal.why.paused")
    expect(terminalBlocked("asleep", false)).toBe("terminal.why.asleep")
  })
})

describe("the status guard", () => {
  it("never lets an older answer replace a newer one", () => {
    const g = new StatusGuard()
    const older = g.begin()
    const newer = g.begin()
    expect(g.land(newer)).toBe(true)
    expect(g.land(older)).toBe(false)
  })

  it("lets answers land in the order they were asked when they come back in order", () => {
    const g = new StatusGuard()
    const a = g.begin()
    const b = g.begin()
    expect(g.land(a)).toBe(true)
    expect(g.land(b)).toBe(true)
  })

  it("drops a read started before Pause ended, and shows paused until a read started after it lands", () => {
    const g = new StatusGuard()
    // The poll is out when Pause is clicked; QEMU still says running to it.
    const pollDuringPause = g.begin()
    g.settle(phaseAfter("pause"))
    expect(g.held).toBe("paused")
    expect(g.land(pollDuringPause)).toBe(false)
    expect(g.held).toBe("paused")
    // The verb's own read, started after it returned.
    const after = g.begin()
    expect(g.land(after)).toBe(true)
    expect(g.held).toBeNull()
  })

  it("holds nothing after a verb that failed, or one whose result only status can tell", () => {
    const g = new StatusGuard()
    const out = g.begin()
    g.settle(null)
    expect(g.held).toBeNull()
    expect(g.land(out)).toBe(false)
    for (const v of ["start", "stop", "reboot", "kill", "save", "load", "lock", "setup"] as const) expect(phaseAfter(v)).toBeNull()
  })

  it("knows what pause, sleep, resume and wake leave", () => {
    expect([phaseAfter("pause"), phaseAfter("sleep"), phaseAfter("resume"), phaseAfter("wake")]).toEqual(["paused", "asleep", "running", "running"])
  })

  it("shows the held phase over what status last said", () => {
    const status = { state: "running" } as Parameters<typeof shownPhase>[1]
    const of = (): Phase => "running"
    expect(shownPhase("paused", status, of)).toBe("paused")
    expect(shownPhase(null, status, of)).toBe("running")
    expect(shownPhase(null, null, of)).toBeNull()
  })
})

describe("keys in a held screen", () => {
  const key = { metaKey: false }

  it("wake an asleep machine with the first key, and drop that key and those after it until it is awake", () => {
    expect(keyVerdict({ asleep: true, frozen: true, waking: false }, key)).toBe("wake")
    expect(keyVerdict({ asleep: true, frozen: true, waking: true }, key)).toBe("drop")
  })

  it("never resume a paused machine: only Resume does", () => {
    expect(keyVerdict({ asleep: false, frozen: true, waking: false }, key)).toBe("pass")
  })

  it("go to Windows as usual while it runs", () => {
    expect(keyVerdict({ asleep: false, frozen: false, waking: false }, key)).toBe("pass")
  })

  it("leave the app's own ⌘ shortcuts alone, even asleep", () => {
    expect(keyVerdict({ asleep: true, frozen: true, waking: false }, { metaKey: true })).toBe("pass")
  })
})

describe("sizes while held", () => {
  const a = { width: 1280, height: 800 }
  const b = { width: 1600, height: 1000 }

  it("go to the guest at once while it runs", () => {
    const h = new HeldSizes(false)
    expect(h.offer(a)).toBe(true)
    expect(h.setFrozen(false)).toBeNull()
  })

  it("wait while it is held, the latest winning, and go once it runs again", () => {
    const h = new HeldSizes(false)
    expect(h.setFrozen(true)).toBeNull()
    expect(h.offer(a)).toBe(false)
    expect(h.offer(b)).toBe(false)
    expect(h.setFrozen(true)).toBeNull()
    expect(h.setFrozen(false)).toEqual(b)
    // Asked for once only.
    expect(h.setFrozen(false)).toBeNull()
    expect(h.offer(a)).toBe(true)
  })

  it("ask for nothing on running again when nothing was asked meanwhile", () => {
    const h = new HeldSizes(true)
    expect(h.setFrozen(false)).toBeNull()
  })})

/** Timers that fire only when the test says so. */
class Timers {
  private next = 1
  readonly due = new Map<number, { ms: number; fn: () => void }>()
  set(fn: () => void, ms: number): unknown {
    const id = this.next++
    this.due.set(id, { ms, fn })
    return id
  }
  clear(t: unknown): void {
    this.due.delete(t as number)
  }
  /** The waits armed now, in ms. */
  get waits(): number[] {
    return [...this.due.values()].map((d) => d.ms)
  }
  /** Fire every timer armed now. */
  fire(): void {
    const now = [...this.due.entries()]
    this.due.clear()
    for (const [, d] of now) d.fn()
  }
}

describe("sizes Windows is not ready for, or misses", () => {
  const a = { width: 1280, height: 800 }
  const b = { width: 1600, height: 1000 }
  const setup = (frozen: boolean, tries?: number) => {
    const timers = new Timers()
    const retried: { width: number; height: number }[] = []
    const h = new HeldSizes(frozen, { timers, retryMs: 2000, ...(tries === undefined ? {} : { tries }), onRetry: (s) => retried.push(s) })
    return { h, timers, retried }
  }

  it("wait while Windows starts, and go once it is ready (not ready holds like paused)", () => {
    const { h, timers } = setup(true)
    expect(h.offer(a)).toBe(false)
    expect(h.pending).toEqual(a)
    expect(h.setFrozen(false)).toEqual(a)
    expect(h.pending).toBeNull()
    expect(timers.due.size).toBe(0)
  })

  it("a size the guest missed while running is asked for again on a timer, backing off", () => {
    const { h, timers, retried } = setup(false)
    expect(h.offer(a)).toBe(true)
    h.missed(a)
    expect(h.pending).toEqual(a)
    expect(timers.waits).toEqual([2000])
    timers.fire()
    expect(retried).toEqual([a])
    expect(h.pending).toBeNull()
    // Asked again (offer) and missed again: the next wait doubles.
    expect(h.offer(a)).toBe(true)
    h.missed(a)
    expect(timers.waits).toEqual([4000])
    // Taken at last: the waits start over.
    timers.fire()
    expect(h.offer(a)).toBe(true)
    h.took()
    h.missed(b)
    expect(timers.waits).toEqual([2000])
  })

  it("a miss never drops the size: past the tries it waits for the guest to be ready again", () => {
    const { h, timers, retried } = setup(false, 2)
    for (let i = 0; i < 2; i++) {
      expect(h.offer(a)).toBe(true)
      h.missed(a)
      timers.fire()
    }
    expect(retried).toEqual([a, a])
    expect(h.offer(a)).toBe(true)
    h.missed(a)
    expect(timers.due.size).toBe(0)
    expect(h.pending).toEqual(a)
    // Windows restarts (not ready), then is ready: the size is asked for.
    expect(h.setFrozen(true)).toBeNull()
    expect(h.setFrozen(false)).toEqual(a)
  })

  it("a miss while not ready waits for ready, with no timer", () => {
    const { h, timers } = setup(false)
    expect(h.offer(a)).toBe(true)
    // The restart began while the size was out.
    expect(h.setFrozen(true)).toBeNull()
    h.missed(a)
    expect(timers.due.size).toBe(0)
    expect(h.setFrozen(false)).toEqual(a)
  })

  it("going not ready stops a retry; the size goes once ready", () => {
    const { h, timers, retried } = setup(false)
    expect(h.offer(a)).toBe(true)
    h.missed(a)
    expect(h.setFrozen(true)).toBeNull()
    expect(timers.due.size).toBe(0)
    timers.fire()
    expect(retried).toEqual([])
    expect(h.setFrozen(false)).toEqual(a)
  })

  it("a newer size wins over one missed", () => {
    const { h, timers, retried } = setup(true)
    expect(h.offer(b)).toBe(false)
    h.missed(a)
    expect(h.pending).toEqual(b)
    expect(h.setFrozen(false)).toEqual(b)
    // A size asked for now replaces a missed one waiting, and its retry.
    h.missed(a)
    expect(h.offer(b)).toBe(true)
    expect(h.pending).toBeNull()
    expect(timers.due.size).toBe(0)
    expect(retried).toEqual([])
  })
})

describe("the Pause button's menu", () => {
  const rows = (o: { overlay: boolean; sleep: boolean; lock: boolean }) => {
    const did: string[] = []
    const menu = pauseMenu({
      t: (k) => k,
      overlay: o.overlay,
      controls: { sleep: o.sleep, lock: o.lock },
      setOverlay: (on) => did.push(`overlay=${String(on)}`),
      sleep: () => did.push("sleep"),
      lock: () => did.push("lock"),
    })
    return { menu, did }
  }

  it("has Show Pause Overlay, checked as set, then Sleep and Lock", () => {
    const { menu } = rows({ overlay: true, sleep: true, lock: true })
    expect(menu.map((r) => (r.kind === "separator" ? "-" : `${r.label}${r.checked === true ? " ✓" : ""}`))).toEqual([
      "menu.pauseOverlay ✓",
      "-",
      "action.sleep",
      "action.lock",
    ])
  })

  it("toggles the overlay, and runs Sleep and Lock", () => {
    const { menu, did } = rows({ overlay: true, sleep: true, lock: true })
    for (const r of menu) if (r.kind === "action") r.run()
    expect(did).toEqual(["overlay=false", "sleep", "lock"])
    const off = rows({ overlay: false, sleep: true, lock: true })
    const first = off.menu[0]
    if (first?.kind === "action") {
      expect(first.checked).toBe(false)
      first.run()
    }
    expect(off.did).toEqual(["overlay=true"])
  })

  it("disables Sleep and Lock when the machine can't do them", () => {
    const { menu } = rows({ overlay: true, sleep: false, lock: false })
    expect(menu.flatMap((r) => (r.kind === "action" ? [r.enabled ?? true] : []))).toEqual([true, false, false])
  })
})

describe("the overlay setting", () => {
  const ok = (stdout: string): Output => ({ code: 0, stdout, stderr: "" })

  it("reads winvm settings, defaulting to on", () => {
    expect(parseSettings('{"viewer.pauseOverlay":false}')).toEqual({ pauseOverlay: false })
    expect(parseSettings('{"viewer.pauseOverlay":true,"other":1}')).toEqual({ pauseOverlay: true })
    expect(parseSettings("{}")).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings("not json")).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('{"viewer.pauseOverlay":"no"}')).toEqual(DEFAULT_SETTINGS)
  })

  it("is loaded with winvm settings --json, and survives winvm failing", async () => {
    const asked: string[][] = []
    const run = async (...a: string[]): Promise<Output> => {
      asked.push(a)
      return ok('{"viewer.pauseOverlay":false}')
    }
    expect(await loadSettings(run)).toEqual({ pauseOverlay: false })
    expect(asked).toEqual([["settings", "--json"]])
    expect(await loadSettings(async () => ({ code: 1, stdout: "", stderr: "no" }))).toEqual(DEFAULT_SETTINGS)
    expect(
      await loadSettings(async () => {
        throw new Error("not in the app")
      }),
    ).toEqual(DEFAULT_SETTINGS)
  })

  it("is stored with winvm settings viewer.pauseOverlay=…, and says why it wasn't", async () => {
    // A store that persists, as winvm's settings.json does: what is saved is what loads next time.
    let stored = "{}"
    const run = async (...a: string[]): Promise<Output> => {
      if (a[1] === "--json") return ok(stored)
      const [k, v] = (a[1] ?? "").split("=")
      stored = JSON.stringify({ ...(JSON.parse(stored) as object), [k ?? ""]: v === "true" })
      return ok("")
    }
    expect(pauseOverlayArgs(false)).toEqual(["settings", "viewer.pauseOverlay=false"])
    expect(await savePauseOverlay(run, false)).toBeNull()
    expect(await loadSettings(run)).toEqual({ pauseOverlay: false })
    expect(await savePauseOverlay(run, true)).toBeNull()
    expect(await loadSettings(run)).toEqual({ pauseOverlay: true })
    expect(await savePauseOverlay(async () => ({ code: 2, stdout: "", stderr: "read-only\n" }), true)).toBe("read-only")
  })
})
