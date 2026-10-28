/**
 * The screen verbs: `open`, `screenshot`, `type`, `key`, `click`, `move`,
 * `scroll`, `display`.
 *
 * `open` is for a person (Screen Sharing or the browser). The rest need no
 * window at all and are for scripts and agents: take a screenshot, read it,
 * click a pixel in it, type, take another. See input.ts.
 */
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

import * as agent from "./agent"
import type { Args } from "./args"
import { instanceName } from "./args"
import type { DisplayConfig } from "./display"
import { describeDisplay, parseDevice, readDisplay, sameDevice, writeDisplay } from "./display"
import { SCALES, clampSize, parseSize, sameSize } from "./displayfit"
import * as guestDisplay from "./guestdisplay"
import * as input from "./input"
import * as ocr from "./ocr"
import type { InstanceMeta, Paths } from "./paths"
import { pathsFor, readMeta } from "./paths"
import * as qemu from "./qemu"
import * as saves from "./saves"
import { applyPassword, connection, passwordFor, screenSharingUrl, vncPort } from "./vnc"
import * as web from "./web"

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The instance, running — or a message saying why not and what to do. */
function running(args: Args): { name: string; p: Paths; meta: InstanceMeta } | null {
  const name = instanceName(args)
  const meta = readMeta(name)
  const flag = name === "default" ? "" : ` -i ${name}`
  if (meta === null) {
    console.error(`::error::no instance "${name}" — \`winvm start${flag}\` creates it`)
    return null
  }
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) {
    console.error(`::error::instance "${name}" is not running — \`winvm start${flag}\``)
    return null
  }
  return { name, p, meta }
}

/** Hand a URL to macOS, unless the caller asked for the URL only. */
function launch(url: string, printOnly: boolean): number {
  if (printOnly) return 0
  const r = spawnSync("open", [url], { stdio: "inherit" })
  return r.status ?? 1
}

export async function open(args: Args): Promise<number> {
  const printOnly = args.flags.has("print")

  // The browser view opens for a stopped instance too — its Start button is
  // one way to start it — but says so first.
  if (args.flags.has("web")) {
    const name = instanceName(args)
    const flag = name === "default" ? "" : ` -i ${name}`
    if (readMeta(name) === null) {
      console.error(`::error::no instance "${name}" — \`winvm start${flag}\` creates it`)
      return 1
    }
    if (!qemu.isRunning(pathsFor(name))) {
      console.warn(`note: "${name}" is not running — \`winvm start${flag}\`, or press Start on the page`)
    }
    let server: web.ServerInfo
    try {
      server = await web.ensureServer()
    } catch (error) {
      console.error(`::error::could not start the web view: ${errMsg(error)}`)
      return 1
    }
    const url = web.pageUrl(server.port, name, server.token)
    // The URL carries the access token, so print it only when asked to.
    console.log(printOnly ? url : `opening the browser view of "${name}" (server on 127.0.0.1:${String(server.port)})`)
    return launch(url, printOnly)
  }

  const r = running(args)
  if (r === null) return 1

  // Set the password again before connecting: cheap, and it covers a guest that
  // an older copy of this tool started without one.
  let password: string | null
  try {
    password = await applyPassword(r.p)
  } catch (error) {
    // The monitor is busy (a save in progress?). launch() set the password
    // already, so the stored one is the best guess.
    console.warn(`warning: could not confirm the VNC password (${errMsg(error)}); using the stored one`)
    password = passwordFor(r.p)
  }
  if (args.flags.has("json")) {
    console.log(JSON.stringify(connection(r.meta.vnc, password), null, 2))
    return 0
  }
  if (password === null) {
    console.warn(
      `warning: "${r.name}" was started before VNC passwords, and Screen Sharing asks for a password on a\n` +
        `  server without one (and then fails). Restart it to fix that: winvm stop${r.name === "default" ? "" : ` -i ${r.name}`} && winvm start${r.name === "default" ? "" : ` -i ${r.name}`}`,
    )
  }
  const url = screenSharingUrl(r.meta.vnc, password)
  console.log(
    printOnly ? url : `opening Screen Sharing on 127.0.0.1:${String(vncPort(r.meta.vnc))} (VNC :${String(r.meta.vnc)})`,
  )
  return launch(url, printOnly)
}

/** `winvm screenshot [file.png]` — defaults to the instance's screenshots/ folder. */
export async function screenshot(args: Args): Promise<number> {
  const r = running(args)
  if (r === null) return 1
  const stamp = new Date().toISOString().replace(/[:]/g, "").replace(/\..*$/, "").replace("T", "-")
  const file = resolve(args.positional[0] ?? resolve(r.p.dir, "screenshots", `${stamp}.png`))
  try {
    const size = await input.screenshot(r.p, file)
    console.log(`${file} (${String(size.width)}x${String(size.height)})`)
    return 0
  } catch (error) {
    console.error(`::error::screenshot failed: ${errMsg(error)}`)
    return 1
  }
}

export async function type(args: Args): Promise<number> {
  const text = (args.rest.length > 0 ? args.rest : args.positional).join(" ")
  if (text === "") {
    console.error('::error::usage: winvm type [-i name] "text"   (a newline in the text presses Enter)')
    return 1
  }
  const { strokes, bad } = input.textToStrokes(text)
  if (bad.length > 0) {
    console.error(`::error::can't type ${bad.map((c) => JSON.stringify(c)).join(", ")} on a US keyboard layout`)
    return 1
  }
  const r = running(args)
  if (r === null) return 1
  try {
    await input.typeText(r.p, strokes)
    return 0
  } catch (error) {
    console.error(`::error::typing failed: ${errMsg(error)}`)
    return 1
  }
}

export async function key(args: Args): Promise<number> {
  const combos = args.positional
  if (combos.length === 0) {
    console.error("::error::usage: winvm key [-i name] <combo>...   e.g. ctrl-alt-delete, win-r, enter, f5")
    return 1
  }
  const parsed = combos.map((c) => ({ combo: c, ...input.parseCombo(c) }))
  const unknown = parsed.find((c) => c.unknown !== null)
  if (unknown !== undefined) {
    console.error(`::error::unknown key "${String(unknown.unknown)}" in "${unknown.combo}"`)
    return 1
  }
  const r = running(args)
  if (r === null) return 1
  try {
    for (const c of parsed) await input.pressCombo(r.p, c.qcodes)
    return 0
  } catch (error) {
    console.error(`::error::key failed: ${errMsg(error)}`)
    return 1
  }
}

function coords(args: Args, usage: string): { x: number; y: number } | null {
  // The parser reads `--right 10` as --right=10, so a boolean flag written
  // before the coordinates has eaten one. Take it back.
  const eaten = ["right", "middle", "double"].map((f) => args.flags.get(f)).filter((v) => v !== undefined && v !== "true")
  const [xs, ys] = [...eaten, ...args.positional]
  const x = Number(xs)
  const y = Number(ys)
  if (xs === undefined || ys === undefined || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    console.error(`::error::usage: ${usage}   (screenshot pixels; 0,0 is top left)`)
    return null
  }
  return { x, y }
}

export async function click(args: Args): Promise<number> {
  const text = args.flags.get("text")
  if (text !== undefined && text !== "true") return await ocr.clickText(args, text)
  const at = coords(args, "winvm click [-i name] <x> <y> | --text TEXT [--wait S]  [--right | --middle] [--double]")
  if (at === null) return 1
  const r = running(args)
  if (r === null) return 1
  const button: input.Button = args.flags.has("right") ? "right" : args.flags.has("middle") ? "middle" : "left"
  try {
    const size = await input.pointer(r.p, at.x, at.y, button, args.flags.has("double") ? 2 : 1)
    if (at.x >= size.width || at.y >= size.height) {
      console.warn(`warning: (${String(at.x)}, ${String(at.y)}) is off the ${String(size.width)}x${String(size.height)} screen; clicked the nearest edge`)
    }
    return 0
  } catch (error) {
    console.error(`::error::click failed: ${errMsg(error)}`)
    return 1
  }
}

export async function move(args: Args): Promise<number> {
  const at = coords(args, "winvm move [-i name] <x> <y>")
  if (at === null) return 1
  const r = running(args)
  if (r === null) return 1
  try {
    await input.pointer(r.p, at.x, at.y, null)
    return 0
  } catch (error) {
    console.error(`::error::move failed: ${errMsg(error)}`)
    return 1
  }
}

export async function scroll(args: Args): Promise<number> {
  // "-3" would be read as a flag by the parser, so `scroll -- -3` and `scroll up 3` both work.
  const raw = [...args.positional, ...args.rest]
  let n = Number(raw[0])
  if (raw[0] === "up" || raw[0] === "down") n = Number(raw[1] ?? 1) * (raw[0] === "up" ? -1 : 1)
  if (!Number.isInteger(n) || n === 0) {
    console.error("::error::usage: winvm scroll [-i name] <notches>   positive scrolls down; or: scroll up|down [n]")
    return 1
  }
  const r = running(args)
  if (r === null) return 1
  try {
    await input.scroll(r.p, n)
    return 0
  } catch (error) {
    console.error(`::error::scroll failed: ${errMsg(error)}`)
    return 1
  }
}

/**
 * `winvm display [-i name] [WxH | virtio-gpu | ramfb] [--scale PCT] [--json]`
 *
 *   (nothing)        the device, and the screen's size and scale now
 *   WxH              resize a running virtio-gpu guest live: a VNC
 *                    SetDesktopSize request, then the guest agent sets the
 *                    mode (guestdisplay.ts). Clamped to what the driver and
 *                    VNC can show (displayfit.ts). `--no-request` skips the
 *                    VNC step, for a viewer that already sent it (the app).
 *   --scale PCT      Windows' display scale (100, 125, 150, 200, …), live
 *   virtio-gpu|ramfb switch the display device of a STOPPED instance; saves
 *                    taken on the other device stop loading (display.ts)
 */
export async function display(args: Args): Promise<number> {
  const name = instanceName(args)
  const meta = readMeta(name)
  if (meta === null) {
    console.error(`::error::no instance "${name}"`)
    return 1
  }
  const p = pathsFor(name)
  const flag = name === "default" ? "" : ` -i ${name}`
  const asJson = args.flags.has("json")
  const live = qemu.isRunning(p)
  const configured = readDisplay(p)
  const wantRaw = args.positional[0]
  const scaleRaw = args.flags.get("scale")
  const scale = scaleRaw === undefined ? undefined : Number(scaleRaw.replace(/%$/, ""))
  if (scale !== undefined && !(SCALES as readonly number[]).includes(scale)) {
    console.error(`::error::--scale takes one of ${SCALES.join(", ")} (percent)`)
    return 1
  }

  if (wantRaw === undefined && scale === undefined) {
    const device = live ? guestDisplay.liveDevice(p) : null
    const size = live ? await guestDisplay.liveSize(p) : null
    let guest: guestDisplay.GuestDisplay | null = null
    if (live && device === "virtio-gpu" && (await agent.connect(name, { timeoutMs: 1500 })) !== null) {
      guest = await guestDisplay.guestState(name).catch(() => null)
    }
    if (asJson) {
      console.log(JSON.stringify({ configured: configured.device, running: device, size, scale: guest?.scale ?? null, dpi: guest?.dpi ?? null }))
      return 0
    }
    console.log(`configured: ${describeDisplay(configured)}`)
    if (live) {
      const at = size === null ? "" : `, screen ${String(size.width)}x${String(size.height)}`
      console.log(`running:    ${device ?? "?"}${at}${guest === null ? "" : `, scale ${String(guest.scale)}%`}`)
    }
    return 0
  }

  // Switching the device.
  const device = wantRaw === undefined ? null : parseDevice(wantRaw)
  if (device !== null) return switchDevice(name, meta, p, configured, device, live, flag)

  // Resizing (and/or scaling) the running guest.
  const asked = wantRaw === undefined ? null : parseSize(wantRaw)
  if (wantRaw !== undefined && asked === null) {
    console.error(`::error::"${wantRaw}" is not a size or a device — use WIDTHxHEIGHT (e.g. 2560x1600), virtio-gpu or ramfb`)
    return 1
  }
  if (!live) {
    console.error(`::error::"${name}" is not running; the screen is resized live — \`winvm start${flag}\` first`)
    return 1
  }
  if (guestDisplay.liveDevice(p) !== "virtio-gpu") {
    console.error(
      `::error::"${name}" runs on ramfb, which is fixed at 800x600. Switch to the resizable virtio-gpu while stopped: ` +
        `\`winvm stop${flag} && winvm display${flag} virtio-gpu && winvm start${flag}\``,
    )
    return 1
  }
  try {
    let result: guestDisplay.GuestDisplay
    if (asked === null) {
      result = await guestDisplay.setGuestScale(name, scale ?? 100)
    } else {
      const size = clampSize(asked)
      if (!sameSize(size, asked) && !asJson) console.log(`${wantRaw} is outside what the guest can show; using ${String(size.width)}x${String(size.height)}`)
      if (!args.flags.has("no-request")) await guestDisplay.requestSize(p, meta, size)
      result = await guestDisplay.setGuestSize(name, size, scale === undefined ? {} : { scale })
    }
    if (asJson) console.log(JSON.stringify(result))
    else console.log(`screen is ${String(result.width)}x${String(result.height)} at ${String(result.scale)}%${result.ms === undefined ? "" : ` (${String(result.ms)} ms in the guest)`}`)
    return 0
  } catch (error) {
    console.error(`::error::could not resize the guest's screen: ${errMsg(error)}`)
    return 1
  }
}

/** `winvm display virtio-gpu|ramfb`: only while stopped, and says which saves stop (or start) loading. */
function switchDevice(name: string, meta: InstanceMeta, p: Paths, from: DisplayConfig, to: DisplayConfig, live: boolean, flag: string): number {
  if (sameDevice(from, to)) {
    console.log(`"${name}" already uses ${describeDisplay(to)}`)
    return 0
  }
  if (live) {
    console.error(`::error::"${name}" is running; the display device changes only while it is stopped — \`winvm stop${flag}\` first`)
    return 1
  }
  // A stowed guest's disk is mid-session; on another device it could only boot cold from it, like pulling the plug.
  if (saves.hasSave(name, saves.STOW)) {
    console.error(
      `::error::"${name}" is stowed (saved mid-session). Start it and shut it down cleanly first: ` +
        `\`winvm start${flag} && winvm stop${flag}\`, then switch.`,
    )
    return 1
  }
  const before = saves.currentCompat(name, meta).hash
  writeDisplay(p, to)
  const after = saves.currentCompat(name, meta).hash
  console.log(`display for "${name}": ${describeDisplay(to)} (was ${describeDisplay(from)}); takes effect at the next \`winvm start${flag}\``)
  const listed = saves.listSaves(name).filter((s) => s.manifest !== null)
  const stranded = listed.filter((s) => s.manifest?.compat === before).map((s) => s.name)
  const regained = listed.filter((s) => s.manifest?.compat === after).map((s) => s.name)
  if (stranded.length > 0) {
    console.log(
      `${String(stranded.length)} save${stranded.length === 1 ? "" : "s"} of "${name}" (${stranded.join(", ")}) ` +
        `${stranded.length === 1 ? "was" : "were"} taken on ${from.device} and will not load on ${to.device}. ` +
        `They are kept; \`winvm display${flag} ${from.device}\` makes them loadable again.`,
    )
  }
  if (regained.length > 0) console.log(`${String(regained.length)} save(s) taken on ${to.device} load again: ${regained.join(", ")}`)
  if (from.device === "ramfb" && regained.length === 0) {
    console.log("On its first start on virtio-gpu, Windows comes up at 1024x768; the app then sizes it to its window (or `winvm display WxH`).")
  }
  return 0
}
