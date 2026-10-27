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

import type { Args } from "./args"
import { instanceName } from "./args"
import { describeDisplay, parseDisplay, readDisplay, writeDisplay } from "./display"
import * as guestDisplay from "./guestdisplay"
import * as input from "./input"
import * as ocr from "./ocr"
import type { InstanceMeta, Paths } from "./paths"
import { pathsFor, readMeta } from "./paths"
import * as qemu from "./qemu"
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
 * `winvm display [-i name] [WxH | ramfb]` — show or set the screen size.
 *
 * Converges in steps, and says which step is next:
 *
 *   1. QEMU's side: the display device, recorded per instance (display.ts).
 *      Takes effect at the next start.
 *   2. Windows' side: Windows keeps a per-monitor resolution and starts a new
 *      monitor at the driver's default (1024x768 for viogpudo), however large
 *      the virtual screen. It has no command-line way to change that, so this
 *      writes the size into the saved display configuration for the virtio
 *      GPU's monitor (HKLM\...\GraphicsDrivers\Configuration) over the guest
 *      agent, and reboots the guest so Windows applies it.
 *
 * Step 2 needs the guest to have booted on the virtio GPU once, so the monitor's
 * entry exists. Running the same command again after a start does it.
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
  const live = qemu.isRunning(p)
  const configured = readDisplay(p)
  const actual = live ? await guestDisplay.liveSize(p) : null
  const wantRaw = args.positional[0]

  if (wantRaw === undefined) {
    const device = live ? guestDisplay.liveDevice(p) : null
    console.log(`configured: ${describeDisplay(configured)}`)
    if (live) {
      console.log(`running:    ${device ?? "?"}${actual === null ? "" : `, screen ${String(actual.width)}x${String(actual.height)}`}`)
    }
    return 0
  }

  const want = parseDisplay(wantRaw)
  if (want === null) {
    console.error(`::error::"${wantRaw}" is not a size — use WIDTHxHEIGHT (e.g. 1920x1080) or "ramfb"`)
    return 1
  }

  // 1. QEMU's side.
  const deviceChanges = describeDisplay(want) !== describeDisplay(configured)
  if (deviceChanges) {
    writeDisplay(p, want)
    console.log(`display for "${name}": ${describeDisplay(want)} (was ${describeDisplay(configured)})`)
    console.log(
      "  note: snapshots and saves taken with the previous display can't be restored on this one;\n" +
        `  \`winvm display${flag} ${configured.device === "ramfb" ? "ramfb" : `${String(configured.width)}x${String(configured.height)}`}\` switches back.`,
    )
  }
  const runningDevice = live ? guestDisplay.liveDevice(p) : null
  if (!live || runningDevice !== guestDisplay.deviceLabel(want)) {
    console.log(
      live
        ? `next: restart to switch the device (\`winvm stop${flag} && winvm start${flag}\`)` +
            (want.device === "virtio-gpu" ? `, then run \`winvm display${flag} ${wantRaw}\` again to size Windows' screen` : "")
        : `takes effect at the next \`winvm start${flag}\`` +
            (want.device === "virtio-gpu" ? `; after it, run \`winvm display${flag} ${wantRaw}\` again to size Windows' screen` : ""),
    )
    return 0
  }
  if (want.device === "ramfb") {
    console.log("ramfb is already in use; the firmware fixes its size at 800x600")
    return 0
  }
  if (actual !== null && actual.width === want.width && actual.height === want.height) {
    console.log(`screen is ${String(want.width)}x${String(want.height)} — nothing to do`)
    return 0
  }

  // 2. Windows' side.
  let entries: number
  try {
    entries = await guestDisplay.setGuestResolution(p, want.width, want.height)
  } catch (error) {
    console.error(`::error::could not set the guest's resolution: ${errMsg(error)}`)
    return 1
  }
  if (entries === 0) {
    console.error("::error::Windows has no saved configuration for the virtio GPU's monitor yet — is the guest still booting?")
    return 1
  }
  if (args.flags.has("no-reboot")) {
    console.log(`set ${String(want.width)}x${String(want.height)} in the guest; it applies at the guest's next reboot`)
    return 0
  }
  console.log(`set ${String(want.width)}x${String(want.height)} in the guest; rebooting it to apply`)
  const after = await guestDisplay.rebootAndMeasure(p)
  if (after === null) {
    console.error(`::error::the guest did not come back from the reboot — \`winvm status${flag}\``)
    return 1
  }
  const ok = after.width === want.width && after.height === want.height
  console.log(`screen is now ${String(after.width)}x${String(after.height)}${ok ? "" : ` — not the ${wantRaw} asked for`}`)
  return ok ? 0 : 1
}
