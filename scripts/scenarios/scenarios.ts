/**
 * The scenarios: each drives the CLI and the agent the way the app does, with
 * the app's polling running throughout (lib.ts AppPoller), and asserts what
 * must stay true over time, not only at the end.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import {
  AppPoller,
  Scenario,
  type Status,
  heldThroughout,
  json,
  must,
  path,
  pngSize,
  sleep,
  smbMounts,
  virtiofsds,
  vncKeys,
  waitFor,
  winvm,
} from "./lib"
import { GuestKeyboardRouter, type RoutedKeyEvent } from "../../apps/viewer/ui/src/features/screen/keyboard"

export interface Context {
  readonly name: string
  /** How long a hold lasts (pause, sleep), in seconds. */
  readonly holdS: number
  readonly out: string
}

const status = async (name: string): Promise<Status> => json<Status>(await must(["status", "--json", "-i", name], { timeoutMs: 30_000 }))

const settle = async (name: string, want: string, timeoutMs: number): Promise<{ ok: boolean; value: Status; ms: number }> =>
  await waitFor(() => status(name), (s) => s.state === want, timeoutMs)

/** Whether Windows shows its lock screen: LogonUI.exe in the user's session. */
async function lockScreenUp(name: string): Promise<boolean> {
  const r = await winvm(["exec", "-i", name, "--", "tasklist", "/FI", "IMAGENAME eq LogonUI.exe"], { timeoutMs: 60_000 })
  return r.code === 0 && /LogonUI\.exe/i.test(r.stdout)
}

/** Signs back in from the lock screen: Enter lifts the curtain, Enter again signs in (blank password). */
async function unlock(name: string): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    if (!(await lockScreenUp(name))) return true
    await must(["key", "-i", name, "enter"])
    await sleep(4000)
  }
  return !(await lockScreenUp(name))
}

/** The guest's screen: saved to the evidence folder, and its text (macOS Vision on the image, not the Mac's screen). */
async function screenText(name: string, file: string): Promise<string> {
  await must(["screenshot", "-i", name, file])
  const r = await must(["ocr", "-i", name, "--image", file])
  return r.stdout
}

const LOCK_SCREEN = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/

/** Running, signed in, agent answering: where every scenario starts. */
export async function ready(name: string): Promise<void> {
  const s = await status(name)
  if (s.state === "paused") await must(["resume", "-i", name])
  if (s.state === "asleep") await must(["wake", "-i", name])
  if (s.state === "stopped" || s.state === "stowed") await must(["start", "-i", name])
  if (s.state === "missing") throw new Error(`no instance "${name}": create it first (winvm create -i ${name})`)
  await must(["agent", "-i", name, "connect", "--json"], { timeoutMs: 300_000 })
  if (!(await unlock(name))) throw new Error(`could not sign "${name}" back in`)
}

/** Runs `body` with the app's polling on, and keeps the poller's trace as evidence. */
async function polled(sc: Scenario, name: string, body: (poller: AppPoller) => Promise<void>): Promise<void> {
  const poller = new AppPoller(name)
  const from = Date.now()
  poller.start()
  try {
    // A few reads first, so the app has a state and the agent an address, as an open window would.
    await waitFor(async () => poller.state, (s) => s !== null, 30_000, 250)
    await sleep(6000)
    await body(poller)
  } catch (error) {
    sc.check("ran to the end", false, String(error instanceof Error ? error.message : error))
  } finally {
    await poller.stop()
    const resizes = poller.calls.filter((c) => c.what === "resize")
    if (resizes.length > 0) sc.check("every live resize the app sent was answered", resizes.every((c) => c.ok), resizes.map((c) => `${c.detail}${c.ok ? "" : " FAILED"}`).join("; "))
    sc.note(`poller trace: ${sc.saveTrace(poller, from, Date.now(), "trace.txt")}`)
    sc.note(`states: ${path(poller.samples, from, Date.now())}`)
  }
}

/** Every hold: the frozen state seen on every read for `holdS`, the agent refused at once, nothing resumed. */
async function hold(sc: Scenario, ctx: Context, poller: AppPoller, state: "paused" | "asleep"): Promise<void> {
  const from = Date.now()
  const until = from + ctx.holdS * 1000
  const connects: { code: number; ms: number }[] = []
  const files: { code: number; ms: number }[] = []
  let held = 0
  while (Date.now() < until) {
    // What the app does while a machine is held, beyond its polling: the Files window or a
    // resize asks for the agent; the window is resized.
    const c = await winvm(["agent", "-i", ctx.name, "connect", "--json"], { timeoutMs: 60_000 })
    connects.push({ code: c.code, ms: c.ms })
    const d = await winvm(["dir", "-i", ctx.name, "--json"], { timeoutMs: 60_000 })
    files.push({ code: d.code, ms: d.ms })
    if ((await poller.offerSize({ width: 1280 + held * 16, height: 800 })) === "held") held++
    await sleep(Math.min(10_000, Math.max(0, until - Date.now())))
  }
  const to = Date.now()
  const h = heldThroughout(poller.samples, from, to, [state], { vm: ["paused"], minSamples: Math.floor(ctx.holdS / 5) })
  sc.check(
    `stays ${state} for ${String(ctx.holdS)} s under the app's polling`,
    h.ok,
    `${String(h.count)} status reads, all ${state} (vm paused)${h.bad.length > 0 ? `; NOT: ${h.bad.map((b) => `${b.state ?? "error"}/${b.vmStatus ?? "-"}`).join(", ")}` : ""}`,
  )
  sc.check(
    "agent connect refuses at once (exit 3), never waits or reinstalls",
    connects.every((c) => c.code === 3 && c.ms < 5000),
    connects.map((c) => `exit ${String(c.code)} in ${String(c.ms)} ms`).join("; "),
  )
  sc.check(
    "the Files path (winvm dir) refuses instead of hanging",
    files.every((f) => f.code !== 0 && f.ms < 10_000),
    files.map((f) => `exit ${String(f.code)} in ${String(f.ms)} ms`).join("; "),
  )
  const sent = poller.between(from, to).calls.filter((c) => c.what === "resize")
  sc.check("window resizes are held, none sent to the guest", sent.length === 0 && held > 0, `${String(held)} held, ${String(sent.length)} sent`)
  const stats = poller.between(from, to).calls.filter((c) => c.what === "stats")
  sc.check("no GET /stats while held (the meters wait)", stats.length === 0, `${String(stats.length)} calls`)
}

/** After a resume or wake: running, and staying so. */
async function runsAgain(sc: Scenario, ctx: Context, poller: AppPoller, label: string): Promise<void> {
  const s = await settle(ctx.name, "running", 30_000)
  sc.check(`${label}: running`, s.ok && s.value.vmStatus === "running", `${s.value.state}/${s.value.vmStatus ?? "-"} after ${String(s.ms)} ms`)
  const from = Date.now()
  await sleep(10_000)
  const h = heldThroughout(poller.samples, from, Date.now(), ["running"], { vm: ["running"], minSamples: 2 })
  sc.check(`${label}: stays running`, h.ok, `${String(h.count)} reads, all running`)
}

// ---- 1. Pause ---------------------------------------------------------------------------------

export async function pause(ctx: Context): Promise<Scenario> {
  const sc = new Scenario("1. Pause", resolve(ctx.out, "1-pause"))
  await polled(sc, ctx.name, async (poller) => {
    const mountedBefore = await smbMounts(ctx.name)
    const r = await poller.act("pause")
    sc.check("winvm pause", r.code === 0, r.stdout.trim())
    sc.check("the app shows paused at once", poller.state === "paused", `shown: ${poller.state ?? "-"}`)
    if (mountedBefore.length > 0) sc.check("Finder's drives taken out while paused", (await smbMounts(ctx.name)).length === 0, `before: ${mountedBefore.join(", ")}; now: ${(await smbMounts(ctx.name)).join(", ") || "none"}`)
    const pausedAt = Date.now()
    await hold(sc, ctx, poller, "paused")
    const watchLog = resolve(process.env["WINVM_HOME"] ?? "", "instances", ctx.name, "watch.log")
    if (existsSync(watchLog)) {
      // What the watcher did while it was paused: its lines from the hold, the
      // actions only (its start-up line names autosave and stow as settings).
      const during = readFileSync(watchLog, "utf8")
        .split("\n")
        .filter((l) => {
          const at = Date.parse(l.slice(0, 24))
          return Number.isFinite(at) && at >= pausedAt && at <= Date.now()
        })
      const acted = during.filter((l) => /\] (autosave|stow|resum|cont|clock)\b/i.test(l))
      const ticks = during.filter((l) => /tick: .*active: paused/.test(l)).length
      sc.check(
        "the watcher did not resume, save or stow it, and counted it as paused",
        acted.length === 0 && ticks > 0,
        acted.length === 0 ? `${String(during.length)} watch.log lines in the hold, none an action; ${String(ticks)} ticks "active: paused"` : acted.join(" | "),
      )
    }
    const r2 = await poller.act("resume")
    sc.check("winvm resume", r2.code === 0, r2.stdout.trim().split("\n").slice(-1).join(""))
    await runsAgain(sc, ctx, poller, "after resume")
    if (mountedBefore.length > 0) {
      const back = await waitFor(() => smbMounts(ctx.name), (m) => m.length === mountedBefore.length, 60_000)
      sc.check("Finder's drives back after resume", back.ok, back.value.join(", ") || "none")
    }
  })
  return sc
}

// ---- 2. Sleep, wake, lock -----------------------------------------------------------------------

export async function sleepWake(ctx: Context): Promise<Scenario> {
  const sc = new Scenario("2. Sleep, wake and lock", resolve(ctx.out, "2-sleep"))
  await polled(sc, ctx.name, async (poller) => {
    // Only the sizes the hold offers: Windows refuses a mode change mid sign-in
    // (ChangeDisplaySettingsEx fails while the lock screen gives way), which is
    // not what this scenario is about.
    poller.autoResize = false
    const r = await poller.act("sleep")
    sc.check("winvm sleep", r.code === 0, r.stdout.trim().split("\n").slice(-1).join(""))
    sc.check("the app shows asleep at once", poller.state === "asleep", `shown: ${poller.state ?? "-"}`)
    await hold(sc, ctx, poller, "asleep")
    // The app wakes on a key press in its screen by running `winvm wake` (held.ts keyVerdict "wake").
    const w = await poller.act("wake")
    sc.check("winvm wake (the app's key-press path)", w.code === 0, w.stdout.trim().split("\n").slice(-1).join(""))
    await runsAgain(sc, ctx, poller, "after wake")
    const woke = await screenText(ctx.name, resolve(sc.out, "after-wake.png"))
    sc.check("woken at the lock screen", LOCK_SCREEN.test(woke) && (await lockScreenUp(ctx.name)), `OCR: ${woke.split("\n").map((l) => l.replace(/^\S+\s+\S+\s+\S+\s+/, "")).join(" | ").slice(0, 160)}; LogonUI running`)
    // The size the window wanted while asleep reached Windows at its lock screen: set at sign-in.
    const kept = poller.calls.filter((c) => c.what === "resize-held").at(-1)?.detail ?? null
    const sentAtWake = poller.calls.filter((c) => c.what === "resize").at(-1)
    sc.check("the size kept while asleep is sent on wake", kept !== null && sentAtWake?.detail.startsWith(kept) === true && sentAtWake.ok, `${kept ?? "none kept"} -> ${sentAtWake?.detail ?? "nothing sent"}`)
    sc.check("signs back in with Enter", await unlock(ctx.name), "LogonUI gone")
    if (kept !== null) {
      const [w, h] = kept.split("x").map(Number)
      const shown = await waitFor(
        async () => ((await poller.agent("POST", "/display", { op: "get" }, 20_000))?.body ?? {}) as { width?: number; height?: number },
        (d) => d.width === w && d.height === h,
        20_000,
      )
      sc.check("and Windows has it once signed in", shown.ok, JSON.stringify(shown.value))
    }
    const l = await poller.act("lock")
    sc.check("winvm lock", l.code === 0, l.stdout.trim().split("\n").slice(-1).join(""))
    const locked = await screenText(ctx.name, resolve(sc.out, "after-lock.png"))
    sc.check("lock shows the lock screen", LOCK_SCREEN.test(locked) && (await lockScreenUp(ctx.name)), `OCR: ${locked.split("\n").map((l2) => l2.replace(/^\S+\s+\S+\s+\S+\s+/, "")).join(" | ").slice(0, 160)}`)
    const st = await status(ctx.name)
    sc.check("locked is still running (not paused)", st.state === "running" && st.vmStatus === "running", `${st.state}/${st.vmStatus ?? "-"}`)
    sc.check("signs back in after lock", await unlock(ctx.name), "LogonUI gone")
    await screenText(ctx.name, resolve(sc.out, "signed-in.png"))
  })
  return sc
}

// ---- 3. Stop/start, stow/recall -----------------------------------------------------------------

const ALLOWED_DOWN = new Set(["running", "stopped", "stowed"])

export async function stopStart(ctx: Context): Promise<Scenario> {
  const sc = new Scenario("3. Stop/start and stow/recall", resolve(ctx.out, "3-stop-start"))
  const share = json<{ available: boolean; reason?: string }>(await must(["share", "-i", ctx.name, "status", "--json"]))
  sc.note(share.available ? "the runtime has virtiofsd: it must come and go with QEMU" : `no virtiofsd in this runtime (${share.reason ?? "?"}): none may run`)
  await polled(sc, ctx.name, async (poller) => {
    const mounted = await smbMounts(ctx.name)
    sc.check("Finder's drives mounted to start with", mounted.length > 0, mounted.join(", ") || "none")
    const vfs0 = await virtiofsds(ctx.name)
    sc.check("virtiofsd with QEMU", share.available ? vfs0.length === 1 : vfs0.length === 0, vfs0.join(" | ") || "none running")

    for (const way of ["stop", "stow"] as const) {
      const from = Date.now()
      // The stow as if from the app: under way, so the app leaves the agent alone meanwhile.
      if (way === "stow") poller.busy = true
      const r = way === "stop" ? await poller.act("stop") : await winvm(["stow", "-i", ctx.name])
      if (way === "stow") {
        poller.settled()
        poller.busy = false
      }
      sc.check(`winvm ${way}`, r.code === 0, r.stdout.trim().split("\n").slice(-1).join(""))
      const want = way === "stop" ? "stopped" : "stowed"
      const down = await settle(ctx.name, want, 30_000)
      sc.check(`${want} after ${way}`, down.ok && down.value.pid === null, `${down.value.state}, pid ${String(down.value.pid)}`)
      sc.check(`Finder's drives unmounted by ${way}`, (await smbMounts(ctx.name)).length === 0, (await smbMounts(ctx.name)).join(", ") || "none mounted")
      sc.check(`virtiofsd gone with QEMU (${way})`, (await virtiofsds(ctx.name)).length === 0, (await virtiofsds(ctx.name)).join(" | ") || "none running")
      const quiet = Date.now()
      await sleep(10_000)
      const h = heldThroughout(poller.samples, quiet, Date.now(), [want], { minSamples: 2 })
      sc.check(`stays ${want} under polling`, h.ok, `${String(h.count)} reads`)
      const r2 = await poller.act("start")
      sc.check(`winvm start (${way === "stow" ? "recall" : "boot"})`, r2.code === 0 && (way === "stop" || /recall/i.test(r2.stdout + r2.stderr)), r2.stdout.trim().split("\n").filter((x) => /recall|up|boot/i.test(x)).slice(0, 2).join(" / "))
      const up = await settle(ctx.name, "running", 120_000)
      sc.check(`running after start`, up.ok && up.value.vmStatus === "running", `${up.value.state}/${up.value.vmStatus ?? "-"}`)
      const back = await waitFor(() => smbMounts(ctx.name), (m) => m.length === mounted.length, 90_000)
      sc.check(`Finder's drives mounted again after start`, back.ok, `${back.value.join(", ") || "none"} after ${String(back.ms)} ms`)
      const vfs = await virtiofsds(ctx.name)
      sc.check(`virtiofsd back with QEMU`, share.available ? vfs.length === 1 : vfs.length === 0, vfs.join(" | ") || "none running")
      const seen = path(poller.samples, from, Date.now())
      const odd = poller.between(from, Date.now()).samples.filter((s) => s.state === null || !ALLOWED_DOWN.has(s.state))
      sc.check(`status correct throughout the ${way}`, odd.length === 0, `${seen}${odd.length > 0 ? `; unexpected: ${odd.map((s) => `${s.state ?? s.error ?? "?"}/${s.vmStatus ?? "-"}`).join(", ")}` : ""}`)
      await ready(ctx.name)
    }
  })
  return sc
}

// ---- 4. Save and load ------------------------------------------------------------------------

interface SaveEntry {
  readonly name: string
  readonly screenshot: string | null
  readonly thumbnail: string | null
  readonly screenSize?: { width: number; height: number }
  readonly title: string | null
  readonly notes: { title: string | null; text: string; tags: string[] } | null
}

export async function saveLoad(ctx: Context): Promise<Scenario> {
  const sc = new Scenario("4. Save and load", resolve(ctx.out, "4-save-load"))
  const tag = `scen-${String(Date.now() % 100000)}`
  const live = `${tag}-live`
  const paused = `${tag}-paused`
  await polled(sc, ctx.name, async (poller) => {
    // A checkpoint while running, as New Checkpoint takes one.
    let from = Date.now()
    const r = await poller.act("save", live)
    sc.check("winvm save (running)", r.code === 0, r.stdout.trim().split("\n").slice(-1).join(""))
    await runsAgain(sc, ctx, poller, "after the save")
    sc.check("no postmigrate shown as running, during or after", !poller.between(from, Date.now()).samples.some((s) => s.state === "running" && s.vmStatus === "postmigrate"), path(poller.samples, from, Date.now()))
    const during = heldThroughout(poller.samples, from, Date.now(), ["running"])
    sc.check("a save of a running machine never shows it paused (no Resume, no overlay mid-save)", during.ok, path(poller.samples, from, Date.now()))

    const entry = (list: SaveEntry[], n: string): SaveEntry | undefined => list.find((e) => e.name === n)
    const saves = async (): Promise<SaveEntry[]> => json<SaveEntry[]>(await must(["saves", "-i", ctx.name, "--json"]))
    const e = entry(await saves(), live)
    const shot = e?.screenshot === null || e?.screenshot === undefined ? null : pngSize(e.screenshot)
    const thumb = e?.thumbnail === null || e?.thumbnail === undefined ? null : pngSize(e.thumbnail)
    sc.check("the checkpoint has its screenshot", shot !== null && shot.width > 0, `${e?.screenshot ?? "none"} ${shot === null ? "" : `${String(shot.width)}x${String(shot.height)}`}`)
    sc.check("and its thumbnail", thumb !== null && thumb.width > 0 && shot !== null && thumb.width < shot.width, `${e?.thumbnail ?? "none"} ${thumb === null ? "" : `${String(thumb.width)}x${String(thumb.height)}`}`)

    // A note, as the Checkpoints view writes and reads it.
    const text = "- first line\nsecond line with “quotes”"
    const w = await must(["saves", "note", "-i", ctx.name, live, "--title=Before the scenario", `--text=${text}`, "--tags=scenario,a b", "--json"])
    const back = json<{ title: string; text: string; tags: string[] } | null>(await must(["saves", "note", "-i", ctx.name, live, "--json"]))
    sc.check(
      "a note round-trips",
      back !== null && back.title === "Before the scenario" && back.text === text && back.tags.join("|") === "scenario|a b" && JSON.stringify(json(w)) === JSON.stringify(back),
      JSON.stringify(back),
    )
    sc.check("winvm saves --json carries the note's title", entry(await saves(), live)?.title === "Before the scenario", String(entry(await saves(), live)?.title))

    // A checkpoint of a paused machine: it must stay paused, shown paused (postmigrate is frozen).
    const p = await poller.act("pause")
    sc.check("pause before the second save", p.code === 0, p.stdout.trim())
    from = Date.now()
    const r2 = await poller.act("save", paused)
    sc.check("winvm save (paused)", r2.code === 0, r2.stdout.trim().split("\n").slice(-1).join(""))
    await sleep(15_000)
    const h = heldThroughout(poller.samples, from, Date.now(), ["paused"], { minSamples: 3 })
    const vms = [...new Set(poller.between(from, Date.now()).samples.map((s) => s.vmStatus))].join(",")
    sc.check("a save of a paused machine leaves it paused, never shown running", h.ok, `${String(h.count)} reads paused; QEMU said ${vms}`)
    sc.check("its checkpoint has a screenshot too", pngSize(entry(await saves(), paused)?.screenshot ?? "/none") !== null, entry(await saves(), paused)?.screenshot ?? "none")
    const r3 = await poller.act("resume")
    sc.check("resume after a paused save", r3.code === 0, r3.stdout.trim().split("\n").slice(-1).join(""))
    await runsAgain(sc, ctx, poller, "after resume")

    // Go Back.
    from = Date.now()
    const mounted = await smbMounts(ctx.name)
    const l = await poller.act("load", live)
    sc.check("winvm load", l.code === 0, l.stdout.trim().split("\n").filter((x) => /loaded|restored/i.test(x)).slice(-1).join(""))
    await runsAgain(sc, ctx, poller, "after load")
    const seen = poller.between(from, Date.now()).samples
    sc.check("status correct through the load", seen.every((s) => s.state === "running"), path(poller.samples, from, Date.now()))
    if (mounted.length > 0) {
      const m = await waitFor(() => smbMounts(ctx.name), (x) => x.length === mounted.length, 60_000)
      sc.check("Finder's drives back after load", m.ok, m.value.join(", ") || "none")
    }
    await ready(ctx.name)

    // Delete: the note goes with the save.
    const notesDir = resolve(process.env["XDG_DATA_HOME"] ?? resolve(process.env["HOME"] ?? "", ".local", "share"), "winvm", "notes", ctx.name)
    const noteFile = resolve(notesDir, `${live}.json`)
    const had = existsSync(noteFile)
    const rm = await must(["saves", "-i", ctx.name, "rm", live])
    sc.check("deleting the save deletes its note", had && !existsSync(noteFile) && /and its note/.test(rm.stdout), `${rm.stdout.trim()}; ${noteFile} ${existsSync(noteFile) ? "still there" : "gone"}`)
    const gone = await winvm(["saves", "note", "-i", ctx.name, live, "--json"])
    sc.check("and the note can't be read for it any more", gone.code !== 0, (gone.stderr || gone.stdout).trim())
    await must(["saves", "-i", ctx.name, "rm", paused])
  })
  return sc
}

// ---- 5. Resize while paused --------------------------------------------------------------------

export async function resizeHeld(ctx: Context): Promise<Scenario> {
  const sc = new Scenario("5. A resize during pause is held, then applied", resolve(ctx.out, "5-resize"))
  await polled(sc, ctx.name, async (poller) => {
    // This scenario is the one resizing the window.
    poller.autoResize = false
    const get = async (): Promise<{ width?: number; height?: number }> => {
      const r = await poller.agent("POST", "/display", { op: "get" }, 20_000)
      return (r?.body ?? {}) as { width?: number; height?: number }
    }
    const before = await get()
    sc.note(`display before: ${JSON.stringify(before)}`)
    const want = before.width === 1366 ? { width: 1280, height: 800 } : { width: 1366, height: 768 }
    const p = await poller.act("pause")
    sc.check("winvm pause", p.code === 0, p.stdout.trim())
    const from = Date.now()
    const a = await poller.offerSize({ width: 1600, height: 900 })
    await sleep(3000)
    const b = await poller.offerSize(want)
    sc.check("two window sizes while paused, both held", a === "held" && b === "held", `${a}, ${b}`)
    await sleep(20_000)
    const sent = poller.between(from, Date.now()).calls.filter((c) => c.what === "resize")
    sc.check("nothing sent to the guest while paused", sent.length === 0, `${String(sent.length)} sent`)
    const h = heldThroughout(poller.samples, from, Date.now(), ["paused"], { vm: ["paused"], minSamples: 3 })
    sc.check("still paused", h.ok, `${String(h.count)} reads`)
    const resumedAt = Date.now()
    const r = await poller.act("resume")
    sc.check("winvm resume", r.code === 0, r.stdout.trim().split("\n").slice(-1).join(""))
    const applied = await waitFor(
      async () => poller.between(resumedAt, Date.now()).calls.filter((c) => c.what === "resize"),
      (c) => c.length > 0,
      30_000,
      500,
    )
    const label = `${String(want.width)}x${String(want.height)}`
    sc.check("the last size asked for is sent once it runs", applied.ok && applied.value.length === 1 && applied.value[0]?.detail.startsWith(label) === true && applied.value[0].ok, applied.value.map((c) => `${c.detail} (${c.ok ? "ok" : "failed"})`).join("; ") || "nothing sent")
    const now = await waitFor(get, (d) => d.width === want.width && d.height === want.height, 20_000)
    sc.check("and the guest's screen has it", now.ok, JSON.stringify(now.value))
  })
  return sc
}

// ---- 6. Terminal, files, stats ------------------------------------------------------------------

export async function terminalFiles(ctx: Context): Promise<Scenario> {
  const sc = new Scenario("6. Terminal, files and /stats", resolve(ctx.out, "6-terminal-files"))
  await polled(sc, ctx.name, async (poller) => {
    const shells = json<Record<string, boolean>>(await must(["terminal", "-i", ctx.name, "--shells", "--json"]))
    sc.check("terminal --shells", shells["powershell"] === true && shells["cmd"] === true, JSON.stringify(shells))
    const shell = shells["pwsh"] === true ? "pwsh" : "powershell"
    const ep = json<{ url: string; protocols: string[] }>(await must(["terminal", "-i", ctx.name, "--shell", shell, "--connect", "--json"]))
    const marker = `scen${String(Date.now() % 1e6)}`
    const term = await new Promise<{ ok: boolean; detail: string }>((done) => {
      const u = new URL(ep.url)
      u.searchParams.set("cols", "120")
      u.searchParams.set("rows", "30")
      const ws = new WebSocket(u.toString(), ep.protocols)
      ws.binaryType = "arraybuffer"
      let seen = ""
      let exit: string | null = null
      const timer = setTimeout(() => {
        ws.close()
        done({ ok: false, detail: `timed out; saw ${JSON.stringify(seen.slice(-200))}` })
      }, 60_000)
      ws.onopen = () => ws.send(new TextEncoder().encode(`echo ${marker}-$((6*7))\r`))
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          const m = JSON.parse(ev.data) as { type: string; code?: number }
          if (m.type === "exit") {
            exit = String(m.code)
            clearTimeout(timer)
            done({ ok: seen.includes(`${marker}-42`), detail: `printed ${marker}-42, exited ${exit}` })
          }
          return
        }
        seen += new TextDecoder().decode(ev.data as ArrayBuffer)
        if (seen.includes(`${marker}-42`) && !seen.includes("__sent_exit__")) {
          seen += "__sent_exit__"
          ws.send(new TextEncoder().encode("exit\r"))
        }
      }
      ws.onerror = () => {
        clearTimeout(timer)
        done({ ok: false, detail: "websocket error" })
      }
    })
    sc.check(`a ${shell} session over the terminal socket runs a command and exits`, term.ok, term.detail)

    const base = `C:\\Users\\Administrator\\Desktop\\${marker}`
    const mk = await winvm(["mkdir", "-i", ctx.name, base, "--json"])
    sc.check("mkdir through the agent", mk.code === 0, mk.stdout.trim())
    const put = mkdtempSync(resolve(tmpdir(), "scen-put-"))
    writeFileSync(resolve(put, "hello.txt"), "hello from the Mac\n")
    const pu = await winvm(["put", "-i", ctx.name, resolve(put, "hello.txt"), `${base}\\hello.txt`])
    sc.check("put a file", pu.code === 0, (pu.stdout || pu.stderr).trim().split("\n").slice(-1).join(""))
    const mv = await winvm(["mv", "-i", ctx.name, `${base}\\hello.txt`, `${base}\\renamed.txt`, "--json"])
    sc.check("mv through the agent", mv.code === 0, mv.stdout.trim())
    const ls = json<{ entries?: { name: string }[] }>(await must(["dir", "-i", ctx.name, base, "--json"]))
    sc.check("dir sees the rename", (ls.entries ?? []).map((x) => x.name).join(",") === "renamed.txt", JSON.stringify((ls.entries ?? []).map((x) => x.name)))
    const rm = await winvm(["rm", "-i", ctx.name, base, "--permanently", "--json"])
    sc.check("rm through the agent", rm.code === 0, rm.stdout.trim())
    const after = await winvm(["dir", "-i", ctx.name, base, "--json"])
    sc.check("and it is gone", after.code !== 0, (after.stderr || after.stdout).trim().slice(0, 160))
    rmSync(put, { recursive: true, force: true })

    const stats = await poller.agent("GET", "/stats", undefined, 5000)
    const body = (stats?.body ?? {}) as { memory?: { total?: number; used?: number }; disk?: { total?: number; free?: number } }
    sc.check("GET /stats", stats?.status === 200 && (body.memory?.total ?? 0) > 0 && (body.disk?.total ?? 0) > 0, JSON.stringify(body).slice(0, 200))
    const polledStats = poller.calls.filter((c) => c.what === "stats")
    sc.check("the meters' polling answered throughout", polledStats.length > 0 && polledStats.every((c) => c.ok), `${String(polledStats.filter((c) => c.ok).length)}/${String(polledStats.length)} ok`)
  })
  return sc
}

// ---- 7. Shared folder ---------------------------------------------------------------------------

export async function sharedFolder(ctx: Context): Promise<Scenario> {
  const sc = new Scenario("7. Shared folder", resolve(ctx.out, "7-share"))
  const st = json<{ available: boolean; reason?: string; guest?: { installed: boolean | null } }>(await must(["share", "-i", ctx.name, "status", "--json"]))
  if (!st.available) {
    sc.check("share says why it is unavailable", typeof st.reason === "string" && st.reason.length > 0, st.reason ?? "no reason")
    sc.check("and no virtiofsd runs", (await virtiofsds(ctx.name)).length === 0, "none running")
    sc.skip(`the runtime has no shared folder: ${st.reason ?? "?"}`)
    return sc
  }
  await polled(sc, ctx.name, async (poller) => {
    const dir = mkdtempSync(resolve(tmpdir(), "scen-share-"))
    writeFileSync(resolve(dir, "from-mac.txt"), "one\n")
    if (st.guest?.installed !== true) {
      const i = await winvm(["share", "-i", ctx.name, "install", "--restart"], { timeoutMs: 1_200_000 })
      sc.check("share install --restart", i.code === 0, (i.stdout + i.stderr).trim().split("\n").slice(-1).join(""))
    }
    const set = await winvm(["share", "-i", ctx.name, "set", dir, "--letter", "Z"])
    sc.check("share set", set.code === 0, set.stdout.trim().split("\n").slice(-1).join(""))
    // A different folder takes effect at the next start: stow and recall keep the session.
    await must(["stow", "-i", ctx.name])
    poller.settled()
    await poller.act("start")
    await ready(ctx.name)
    const z = await waitFor(async () => await winvm(["dir", "-i", ctx.name, "Z:\\", "--json"]), (r) => r.code === 0 && r.stdout.includes("from-mac.txt"), 60_000, 2000)
    sc.check("Windows sees the folder as Z:", z.ok, z.value.stdout.slice(0, 200))
    // The watcher: a FileSystemWatcher in Windows sees a change made on the Mac.
    const watching = winvm(
      ["exec", "-i", ctx.name, "--", "powershell", "-NoProfile", "-Command", "$w=New-Object IO.FileSystemWatcher 'Z:\\'; $w.IncludeSubdirectories=$true; $r=$w.WaitForChanged('All', 40000); if ($r.TimedOut) {'TIMEOUT'} else {'EVENT ' + $r.ChangeType + ' ' + $r.Name}"],
      { timeoutMs: 90_000 },
    )
    await sleep(6000)
    writeFileSync(resolve(dir, "later.txt"), "two\n")
    const ev = await watching
    sc.check("a Mac change fires Windows' watcher", /EVENT/.test(ev.stdout), ev.stdout.trim())
    const later = await waitFor(async () => await winvm(["dir", "-i", ctx.name, "Z:\\", "--json"]), (r) => r.stdout.includes("later.txt"), 30_000, 2000)
    sc.check("and the new file is in Z:", later.ok, "later.txt listed")
    await must(["share", "-i", ctx.name, "clear"])
    rmSync(dir, { recursive: true, force: true })
  })
  return sc
}

// ---- 8. The Windows key and the Start menu ------------------------------------------------------

/** The keysyms noVNC gives these keys. */
const KEYSYM: Record<string, number> = { MetaLeft: 0xffeb, MetaRight: 0xffec, ControlLeft: 0xffe3, AltLeft: 0xffe9, KeyR: 0x72, Tab: 0xff09 }

const START_OPEN = /Search for apps|\bPinned\b|\bRecommended\b/
const RUN_OPEN = /Type the name of a program|\bOpen:/

export async function startMenu(ctx: Context): Promise<Scenario> {
  const sc = new Scenario("8. The Windows key: a Cmd-Tab leaves Start closed", resolve(ctx.out, "8-start-menu"))
  let shot = 0
  const look = async (label: string): Promise<string> => await screenText(ctx.name, resolve(sc.out, `${String(++shot).padStart(2, "0")}-${label}.png`))
  const closeStart = async (): Promise<boolean> => {
    for (let i = 0; i < 3; i++) {
      if (!START_OPEN.test(await look("before"))) return true
      await must(["key", "-i", ctx.name, "escape"])
      await sleep(1000)
    }
    return !START_OPEN.test(await look("before"))
  }
  await polled(sc, ctx.name, async (poller) => {
    poller.autoResize = false
    const keys = await vncKeys(ctx.name)
    try {
      // The app's keyboard path: GuestKeyboardRouter first (capture phase), and
      // whatever it lets through goes to noVNC, which holds it until a key-up or
      // its blur cleanup.
      const novnc = new Map<string, number>()
      let captured = false
      const router = new GuestKeyboardRouter({
        send: (keysym, code, down) => keys.send(keysym, code, down),
        translate: (e) => ({ keysym: KEYSYM[e.code] ?? 0, code: e.code }),
        releaseNoVnc: () => {
          for (const [code, keysym] of novnc) keys.send(keysym, code, false)
          novnc.clear()
        },
        onCaptured: (c) => {
          captured = c
        },
      })
      const key = (code: string, down: boolean, mods: { meta?: boolean } = {}): void => {
        let stopped = false
        const ev: RoutedKeyEvent = {
          code,
          ctrlKey: false,
          altKey: false,
          metaKey: mods.meta === true,
          repeat: false,
          preventDefault: () => undefined,
          stopImmediatePropagation: () => {
            stopped = true
          },
        }
        if (down) router.keyDown(ev)
        else router.keyUp(ev)
        if (stopped) return
        const keysym = KEYSYM[code] ?? 0
        keys.send(keysym, code, down)
        if (down) novnc.set(code, keysym)
        else novnc.delete(code)
      }
      const sentSince = (n: number): string => keys.sent.slice(n).join(", ") || "nothing"

      sc.check("Start closed to begin with", await closeStart(), "OCR: no Start menu")

      // The control: what noVNC alone did before the router — Win down, the Tab taken by
      // macOS, Win up from its blur cleanup. Windows opens Start: the check can see it.
      keys.send(0xffeb, "MetaLeft", true)
      await sleep(300)
      keys.send(0xffeb, "MetaLeft", false)
      await sleep(1500)
      const before = await look("control-lone-win")
      sc.check("control: a lone Windows press (noVNC alone, before the fix) opens Start", START_OPEN.test(before), "OCR found the Start menu")
      sc.check("Start closed again", await closeStart(), "Escape")

      // Not captured: Cmd down, the Tab goes to macOS, the window loses focus.
      let n = keys.sent.length
      key("MetaLeft", true, { meta: true })
      await sleep(300)
      router.lostFocus()
      await sleep(1500)
      const a = await look("cmd-tab-uncaptured")
      sc.check("Cmd-Tab away and back, not captured: nothing reaches Windows", keys.sent.length === n, sentSince(n))
      sc.check("and Start stays closed", !START_OPEN.test(a), "OCR: no Start menu")
      key("MetaLeft", false, { meta: false })

      // Captured: Cmd is Windows; the window loses focus with it down.
      router.setCaptured(true)
      n = keys.sent.length
      key("MetaLeft", true, { meta: true })
      await sleep(300)
      router.lostFocus()
      await sleep(1500)
      const b = await look("cmd-tab-captured")
      sc.check("captured, focus lost with Windows held: released as a chord (Ctrl in between)", sentSince(n) === "MetaLeft down, ControlLeft down, ControlLeft up, MetaLeft up", sentSince(n))
      sc.check("and Start stays closed", !START_OPEN.test(b), "OCR: no Start menu")
      sc.check("focus loss releases capture", !captured && !router.isCaptured(), `captured: ${String(router.isCaptured())}`)
      sc.check("Start closed before Right-Cmd+R", await closeStart(), "OCR: no Start menu")

      // Right Command is the Windows key on purpose: Right-Cmd+R opens Run.
      n = keys.sent.length
      key("MetaRight", true, { meta: true })
      key("KeyR", true, { meta: true })
      key("KeyR", false, { meta: true })
      key("MetaRight", false)
      await sleep(2000)
      const r = await look("right-cmd-r")
      sc.check("Right-Cmd+R sends Windows+R and opens Run", RUN_OPEN.test(r) && !START_OPEN.test(r), `${sentSince(n)}; OCR ${RUN_OPEN.test(r) ? "found Run" : "no Run dialog"}`)
      await must(["key", "-i", ctx.name, "escape"])
      await sleep(800)
      await closeStart()
    } finally {
      keys.close()
    }
  })
  return sc
}

export const ALL = {
  pause,
  sleep: sleepWake,
  "stop-start": stopStart,
  "save-load": saveLoad,
  resize: resizeHeld,
  "terminal-files": terminalFiles,
  share: sharedFolder,
  "start-menu": startMenu,
} as const
