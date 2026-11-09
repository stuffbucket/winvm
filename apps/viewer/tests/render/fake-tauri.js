/*
 * A stand-in for the app's Tauri side, so the viewer's own pages render in
 * a plain browser (Playwright's WebKit, the engine Tauri uses on macOS) with
 * a running Windows machine and a history of checkpoints. Loaded before the
 * page's scripts by scripts/render-checkpoints.mjs. Nothing here ships.
 *
 * Checkpoint pictures are drawn on the fly: a made-up Windows desktop per
 * checkpoint, so cards differ the way real ones do.
 */
;(() => {
  const DAY = 86_400_000
  const now = new Date()
  const at = (daysAgo, h, m) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, m)
    return d.toISOString()
  }
  const GiB = 1024 ** 3
  const notes = (title, text = "", tags = []) => ({ title, text, tags, updatedAt: now.toISOString() })
  const home = "/fake/saves/canvas-test"
  const pics = (name) => ({ screenshot: `${home}/${name}/screen.png`, thumbnail: `${home}/${name}/thumb.png`, screenSize: { width: 1920, height: 1200 } })
  let saves = [
    { name: "baseline", kind: "baseline", createdAt: at(80, 10, 2), bytes: 4.1 * GiB, compatible: true, format: "zstd", ...pics("baseline"), title: null, notes: null },
    { name: "golden", kind: "golden", createdAt: at(52, 9, 15), bytes: 6.3 * GiB, compatible: true, format: "mapped", ...pics("golden"), title: "Test base", notes: notes("Test base", "Office, VS Code and the test runner.", ["ci"]) },
    { name: "old-display", kind: "manual", createdAt: at(31, 16, 40), bytes: 5.2 * GiB, compatible: false, incompatible: ["display"], format: "zstd", ...pics("old-display"), title: "Before the display change", notes: notes("Before the display change") },
    { name: "2026-09-30_11-03-12", kind: "manual", createdAt: at(28, 11, 3), bytes: 5.5 * GiB, compatible: true, format: "zstd", screenshot: null, thumbnail: null, title: null, notes: null },
    { name: "office-installed", kind: "manual", createdAt: at(12, 14, 21), bytes: 7.9 * GiB, compatible: true, format: "zstd", ...pics("office-installed"), title: "Office installed", notes: notes("Office installed", "Signed in as **test@contoso.com**.\n\n- Excel activated\n- Outlook not set up", ["office"]) },
    { name: "auto-1", kind: "auto", createdAt: at(12, 18, 5), bytes: 7.9 * GiB, compatible: true, format: "zstd", ...pics("auto-1"), title: null, notes: null },
    { name: "before-update", kind: "manual", createdAt: at(4, 9, 30), bytes: 8.2 * GiB, compatible: true, format: "zstd", ...pics("before-update"), title: "Before Windows Update", notes: notes("Before Windows Update", "KB5050094 pending.", ["updates"]) },
    { name: "after-update", kind: "manual", createdAt: at(4, 13, 12), bytes: 8.6 * GiB, compatible: true, format: "zstd", ...pics("after-update"), title: "After Windows Update", notes: null },
    { name: "auto-2", kind: "auto", createdAt: at(1, 17, 44), bytes: 8.7 * GiB, compatible: true, format: "zstd", ...pics("auto-2"), title: null, notes: null },
    { name: "repro-bug-4521", kind: "manual", createdAt: at(1, 19, 2), bytes: 8.8 * GiB, compatible: true, format: "zstd", ...pics("repro-bug-4521"), title: "Repro for bug 4521", notes: notes("Repro for bug 4521", "Open Excel, then paste twice.", ["bug"]) },
    { name: "before-qemu-upgrade", kind: "manual", createdAt: at(1, 12, 5), bytes: 8.7 * GiB, compatible: false, incompatible: ["qemu"], format: "zstd", ...pics("before-qemu-upgrade"), title: "Before the QEMU upgrade", notes: null },
    { name: "vs-code-setup", kind: "manual", createdAt: at(0, 9, 12), bytes: 9.0 * GiB, compatible: true, format: "zstd", ...pics("vs-code-setup"), title: "VS Code set up", notes: null },
    { name: "auto-3", kind: "auto", createdAt: at(0, 11, 40), bytes: 9.1 * GiB, compatible: true, format: "zstd", ...pics("auto-3"), title: null, notes: null },
    { name: "clean-desktop", kind: "manual", createdAt: at(0, 13, 33), bytes: 9.1 * GiB, compatible: true, format: "zstd", ...pics("clean-desktop"), title: "Clean desktop", notes: notes("Clean desktop", "Before trying the new installer.") },
  ].map((s) => ({ incompatible: [], ...s }))
  const extra = Number(new URLSearchParams(location.search).get("many") ?? "0")
  for (let i = 0; i < extra; i += 1) {
    const name = `auto-many-${String(i)}`
    saves.push({ name, kind: "auto", createdAt: new Date(now.getTime() - (i + 2) * DAY * 0.37).toISOString(), bytes: 8 * GiB, compatible: true, format: "zstd", ...pics(name), title: null, notes: null, incompatible: [] })
  }

  // ?state=stowed: a suspended machine (scripts/render-overview.mjs). ?pictures=none: none of its
  // checkpoints has a screenshot. ?note=TEXT: what its note already says.
  const query = new URLSearchParams(location.search)
  const state = query.get("state") ?? "running"
  if (state === "stowed") {
    saves.push({ name: "stow", kind: "stow", createdAt: at(0, 13, 40), bytes: 9.2 * GiB, compatible: true, format: "zstd", ...pics("stow"), title: null, notes: null, incompatible: [] })
  }
  if (query.get("pictures") === "none") saves = saves.map((s) => ({ ...s, screenshot: null, thumbnail: null }))
  let machineNote = query.get("note")

  const status = {
    name: "canvas-test",
    title: "Work PC",
    state,
    vmStatus: state === "stowed" ? "stopped" : "running",
    image: "win11-arm64",
    pid: 4242,
    uptimeSeconds: 5400,
    cpus: 4,
    memoryMiB: 8192,
    screen: "virtio-gpu 1920x1200",
    overlayBytes: query.get("overlay") === "none" ? null : Number(query.get("overlay") ?? "9.1") * GiB,
    guest: { agent: query.get("agent") ?? "ok", agentVersion: "1.0", os: "Windows 11" },
    saves: { count: saves.length, bytes: 80 * GiB },
    notes: [],
  }

  // instance_usage: the app's sample (src-tauri guest.rs), one more per call. ?usage=windows (default):
  // Windows' own CPU, memory and C:, and QEMU's CPU on the Mac above it; ?usage=mac: no agent, QEMU's
  // figures only. ?overlay=GiB (default 9.1; "none") is what the machine's changes take on the Mac.
  // scripts/render-resources.mjs shortens the 2.5 s between reads.
  let reads = 0
  let macSeconds = 0
  const usageMode = query.get("usage") ?? "windows"
  function usage() {
    reads += 1
    const t = reads
    const windowsCpu = Math.min(0.95, Math.max(0, 0.12 + 0.1 * Math.sin(t / 3) + 0.05 * Math.sin(t * 1.7) + (t % 17 === 0 ? 0.3 : 0)))
    const macCpu = Math.min(0.98, windowsCpu * 1.6 + 0.07 + 0.03 * Math.sin(t / 2))
    macSeconds += macCpu * 4 * 2.5 // 4 processors, 2.5 s between reads
    return {
      atMs: t * 2500,
      host: { cpuSeconds: macSeconds, rssBytes: 3 * GiB },
      guest:
        usageMode === "mac"
          ? null
          : { cpu: windowsCpu, memory: { total: 4 * GiB, available: (1.1 + 0.05 * Math.sin(t / 5)) * GiB }, disk: { path: "C:", total: 63 * GiB, free: 51 * GiB } },
      guestError: usageMode === "mac" ? "no agent" : null,
    }
  }
  const settings = {}
  const policy = { "autosave.enabled": true, "autosave.idleMinutes": 10, "autosave.keep": 3, "stow.enabled": true, "stow.idleMinutes": 60, "watch.enabled": true, "power.keepAwake": false }
  const hardware = { cpus: 4, memoryMiB: 8192 }
  const out = (stdout, code = 0) => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const flag = (args, key) => {
    const hit = args.find((a) => a.startsWith(`--${key}=`))
    return hit === undefined ? undefined : hit.slice(key.length + 3)
  }

  async function run(args) {
    const [verb, ...rest] = args
    if (verb === "status") {
      // ?machines=name:state,… : more machines beside this one (scripts/render-machines.mjs).
      const target = rest[rest.indexOf("-i") + 1]
      const more = (query.get("machines") ?? "")
        .split(",")
        .filter(Boolean)
        .map((m) => {
          const [name, st] = m.split(":")
          return { ...status, name, title: null, state: st, vmStatus: st === "stowed" || st === "stopped" ? "stopped" : "running" }
        })
      if (rest.includes("-i")) return out([status, ...more].find((s) => s.name === target) ?? status)
      return out(more.length === 0 ? status : { instances: [status, ...more] })
    }
    if (verb === "info") return out({ name: status.name, running: state === "running", hardware: { running: state === "running" ? { cpus: 4, memoryMiB: 8192 } : null, next: hardware, limits: { cpus: { min: 2, max: 12 }, memoryMiB: { min: 4096, max: 32768, step: 1024 } }, diskBytes: 64 * GiB }, network: { mode: "user", label: "Shared NAT", guest: "10.0.2.15", gateway: "10.0.2.2", dns: "10.0.2.3", windows: null, forwards: [], listeners: [] } })
    if (verb === "config") {
      for (const arg of rest) {
        const [key, value] = arg.split("=")
        if (Object.hasOwn(policy, key)) policy[key] = value === "true" ? true : value === "false" ? false : Number(value)
        if (key === "cpus") hardware.cpus = Number(value)
        if (key === "memory") hardware.memoryMiB = Number(value)
      }
      window.__policyWrites = [...(window.__policyWrites ?? []), rest.filter((v) => v.includes("="))].filter((v) => v.length > 0)
      // `winvm config -i NAME title=…`: ?renamefail=1 refuses, with a reason.
      const set = rest.find((a) => a.startsWith("title="))
      if (query.get("renamefail") === "1") return out("config.json is read-only", 1)
      if (set !== undefined) {
        status.title = set.slice("title=".length) || null
        window.__titleWrites = [...(window.__titleWrites ?? []), set]
      }
      return out(rest.includes("--json") ? policy : "")
    }
    if (verb === "settings" && rest[0] === "--section") {
      const set = rest.find((a) => a.startsWith("--set="))
      if (set !== undefined) settings[rest[1]] = JSON.parse(set.slice("--set=".length))
      return out(settings[rest[1]] ?? null)
    }
    if (verb === "note") {
      const text = flag(rest, "text")
      if (text !== undefined) {
        machineNote = text.trim() === "" ? null : text
        window.__noteWrites = [...(window.__noteWrites ?? []), text]
      }
      return out(machineNote === null ? null : { text: machineNote, updatedAt: new Date().toISOString() })
    }
    if (verb === "doctor") return out({ ready: true, checks: [], timeMachine: "ok" })
    // ?screen=1: a connection to nothing, so the app mounts its Screen (scripts/render-screen-input.mjs paints the desktop).
    if (verb === "open") return query.get("screen") === "1" ? out({ display: 0, vncPort: 5900, websocketPort: 1, password: "x" }) : out("no screen in the fake", 1)
    if (verb === "saves" && rest.includes("note")) {
      const name = rest[rest.indexOf("note") + 1] === "-i" ? rest[rest.indexOf("note") + 3] : rest[rest.indexOf("note") + 1]
      const s = saves.find((x) => x.name === name)
      if (s === undefined) return out("", 1)
      const n = { title: flag(rest, "title") || null, text: flag(rest, "text") ?? "", tags: (flag(rest, "tags") ?? "").split(",").filter(Boolean), updatedAt: new Date().toISOString() }
      s.notes = n
      s.title = n.title
      return out(n)
    }
    if (verb === "saves" && rest.includes("path")) {
      const name = rest[rest.indexOf("path") + 1]
      return saves.some((x) => x.name === name) ? out({ path: `${home}/${name}` }) : out("", 1)
    }
    if (verb === "saves" && rest.includes("rm")) {
      const name = rest[rest.indexOf("rm") + 1]
      saves = saves.filter((x) => x.name !== name)
      return out(`deleted save "${name}"`)
    }
    if (verb === "saves") return out(saves)
    if (verb === "save") {
      await sleep(1200)
      const name = rest.find((a, i) => i > 0 && rest[i - 1] !== "-i" && a !== "-i") ?? "2026-10-28_12-00-00"
      saves = saves.filter((x) => x.name !== name)
      saves.push({ name, kind: "manual", createdAt: new Date().toISOString(), bytes: 9.2 * GiB, compatible: true, format: "zstd", ...pics(name), title: null, notes: null, incompatible: [] })
      return out(`saved "${name}"`)
    }
    if (verb === "load") {
      await sleep(1500)
      return out("loaded")
    }
    return out("", 0)
  }

  // ---- Pictures -------------------------------------------------------------

  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
  // ?real=a.png,b.png: real screenshots (served by the harness) stand in for the drawn ones.
  const real = (new URLSearchParams(location.search).get("real") ?? "").split(",").filter(Boolean)
  async function picture(path) {
    if (real.length > 0) {
      const pick = real[hash(path.split("/").at(-2) ?? "") % real.length]
      return await (await fetch(`/pictures/${pick}`)).arrayBuffer()
    }
    const name = path.split("/").at(-2) ?? "x"
    const full = path.endsWith("screen.png")
    const w = full ? 1920 : 480
    const h = full ? 1200 : 300
    const c = new OffscreenCanvas(w, h)
    const g = c.getContext("2d")
    paintDesktop(g, w, h, name)
    const blob = await c.convertToBlob({ type: "image/png" })
    return await blob.arrayBuffer()
  }

  function paintDesktop(g, w, h, name) {
    const k = w / 1920
    const hue = hash(name) % 360
    const bg = g.createRadialGradient(w * 0.62, h * 0.55, 10 * k, w * 0.5, h * 0.5, w * 0.75)
    bg.addColorStop(0, `hsl(${(hue + 200) % 360} 80% 70%)`)
    bg.addColorStop(0.45, `hsl(${(hue + 215) % 360} 75% 42%)`)
    bg.addColorStop(1, `hsl(${(hue + 230) % 360} 70% 14%)`)
    g.fillStyle = bg
    g.fillRect(0, 0, w, h)
    // a bloom
    g.fillStyle = `hsl(${(hue + 190) % 360} 90% 80% / 0.35)`
    g.beginPath()
    g.ellipse(w * 0.62, h * 0.5, 260 * k, 160 * k, -0.5, 0, Math.PI * 2)
    g.fill()
    // icons
    for (let i = 0; i < 4; i += 1) {
      g.fillStyle = "hsl(0 0% 100% / 0.85)"
      g.fillRect(28 * k, (36 + i * 120) * k, 64 * k, 56 * k)
    }
    // windows
    const n = 1 + (hash(name) % 3)
    for (let i = 0; i < n; i += 1) {
      const x = (300 + i * 210 + (hash(name + i) % 120)) * k
      const y = (140 + i * 90) * k
      const ww = (900 - i * 120) * k
      const wh = (620 - i * 80) * k
      g.fillStyle = "hsl(0 0% 0% / 0.25)"
      g.fillRect(x + 8 * k, y + 12 * k, ww, wh)
      g.fillStyle = "hsl(0 0% 98%)"
      g.fillRect(x, y, ww, wh)
      g.fillStyle = `hsl(${(hue + i * 70) % 360} 45% 92%)`
      g.fillRect(x, y, ww, 44 * k)
      g.fillStyle = "hsl(0 0% 20%)"
      g.font = `${String(Math.round(22 * k))}px -apple-system, Segoe UI, sans-serif`
      g.fillText(i === 0 ? name : ["Excel", "Visual Studio Code", "File Explorer"][i % 3], x + 18 * k, y + 30 * k)
      g.fillStyle = "hsl(0 0% 86%)"
      for (let r = 0; r < 8; r += 1) g.fillRect(x + 24 * k, y + (80 + r * 52) * k, ww * (0.4 + ((hash(name + r) % 50) / 100)), 18 * k)
    }
    // taskbar
    g.fillStyle = "hsl(220 20% 12% / 0.88)"
    g.fillRect(0, h - 64 * k, w, 64 * k)
    for (let i = 0; i < 7; i += 1) {
      g.fillStyle = i === 0 ? "hsl(205 90% 60%)" : "hsl(0 0% 100% / 0.75)"
      g.fillRect(w / 2 + (i - 3.5) * 58 * k, h - 50 * k, 36 * k, 36 * k)
    }
    g.fillStyle = "hsl(0 0% 100% / 0.9)"
    g.font = `${String(Math.round(18 * k))}px -apple-system, Segoe UI, sans-serif`
    g.fillText("13:33", w - 90 * k, h - 26 * k)
  }

  // ---- The Tauri global -------------------------------------------------------

  const listeners = new Map()
  window.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        if (cmd === "winvm") return await run(args.args)
        if (cmd === "checkpoint_image") return await picture(args.path)
        if (cmd === "instance_usage") return usage()
        if (cmd === "agent_fetch") throw new Error("no agent in the fake")
        if (cmd === "trace" || cmd === "set_system_keyboard_capture") return null
        if (cmd === "set_main_menu_state") { window.__menuEnabled = args.enabled; return null }
        if (cmd === "open_folder") return void (window.__opened = [...(window.__opened ?? []), args.path])
        throw new Error(`fake tauri: ${cmd}`)
      },
    },
    window: { getCurrentWindow: () => ({ show: async () => undefined, setTitle: async () => undefined, close: async () => undefined }) },
    menu: { Menu: { new: async () => ({ popup: async () => undefined }) } },
    event: {
      async listen(name, cb) {
        listeners.set(name, cb)
        return () => listeners.delete(name)
      },
      async emit() {},
    },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }) },
  }
  // The harness rings menu items the way the app's menu would.
  window.__fakeMenu = (id) => listeners.get("menu")?.({ payload: id })
  window.__fakeCount = () => saves.length

  // A made-up live screen in the display, for the view to shrink and copy.
  window.__paintDesktop = paintDesktop
  window.__fakeScreen = () => {
    const display = document.querySelector(".display")
    if (display === null) return false
    display.replaceChildren()
    const screen = document.createElement("div")
    screen.className = "screen"
    const target = document.createElement("div")
    target.className = "screen__canvas"
    const canvas = document.createElement("canvas")
    canvas.width = 1920
    canvas.height = 1200
    canvas.style.width = "100%"
    canvas.style.height = "100%"
    paintDesktop(canvas.getContext("2d"), 1920, 1200, "Live — Work PC")
    target.append(canvas)
    screen.append(target)
    display.append(screen)
    display.classList.add("display--on")
    return true
  }
})()
