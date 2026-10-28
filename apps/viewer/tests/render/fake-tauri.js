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
    { name: "vs-code-setup", kind: "manual", createdAt: at(0, 9, 12), bytes: 9.0 * GiB, compatible: true, format: "zstd", ...pics("vs-code-setup"), title: "VS Code set up", notes: null },
    { name: "auto-3", kind: "auto", createdAt: at(0, 11, 40), bytes: 9.1 * GiB, compatible: true, format: "zstd", ...pics("auto-3"), title: null, notes: null },
    { name: "clean-desktop", kind: "manual", createdAt: at(0, 13, 33), bytes: 9.1 * GiB, compatible: true, format: "zstd", ...pics("clean-desktop"), title: "Clean desktop", notes: notes("Clean desktop", "Before trying the new installer.") },
  ].map((s) => ({ incompatible: [], ...s }))
  const extra = Number(new URLSearchParams(location.search).get("many") ?? "0")
  for (let i = 0; i < extra; i += 1) {
    const name = `auto-many-${String(i)}`
    saves.push({ name, kind: "auto", createdAt: new Date(now.getTime() - (i + 2) * DAY * 0.37).toISOString(), bytes: 8 * GiB, compatible: true, format: "zstd", ...pics(name), title: null, notes: null, incompatible: [] })
  }

  const status = {
    name: "canvas-test",
    title: "Work PC",
    state: "running",
    vmStatus: "running",
    image: "win11-arm64",
    pid: 4242,
    uptimeSeconds: 5400,
    cpus: 4,
    memoryMiB: 8192,
    screen: "virtio-gpu 1920x1200",
    overlayBytes: 9.1 * GiB,
    guest: { agent: "ok", agentVersion: "1.0", os: "Windows 11" },
    saves: { count: saves.length, bytes: 80 * GiB },
    notes: [],
  }
  const settings = {}
  const out = (stdout, code = 0) => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const flag = (args, key) => {
    const hit = args.find((a) => a.startsWith(`--${key}=`))
    return hit === undefined ? undefined : hit.slice(key.length + 3)
  }

  async function run(args) {
    const [verb, ...rest] = args
    if (verb === "status") return out(status)
    if (verb === "doctor") return out({ ready: true, checks: [], timeMachine: "ok" })
    if (verb === "open") return out("no screen in the fake", 1)
    if (verb === "saves" && rest.includes("note")) {
      const name = rest[rest.indexOf("note") + 1] === "-i" ? rest[rest.indexOf("note") + 3] : rest[rest.indexOf("note") + 1]
      const s = saves.find((x) => x.name === name)
      if (s === undefined) return out("", 1)
      const n = { title: flag(rest, "title") || null, text: flag(rest, "text") ?? "", tags: (flag(rest, "tags") ?? "").split(",").filter(Boolean), updatedAt: new Date().toISOString() }
      s.notes = n
      s.title = n.title
      return out(n)
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
        if (cmd === "settings_read") return settings[args.section] ?? null
        if (cmd === "settings_write") {
          settings[args.section] = args.value
          return null
        }
        if (cmd === "instance_usage") return { cpuSeconds: 1, rssKiB: 1, windows: null }
        if (cmd === "agent_fetch") throw new Error("no agent in the fake")
        if (cmd === "trace") return null
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

  // A made-up live screen in the display, for the view to shrink and copy.
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
