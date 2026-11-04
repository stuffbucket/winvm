/*
 * What the help pictures show: a Windows machine called "Work PC", running,
 * with a history of checkpoints that reads well at a glance, a folder of
 * files, two Claude apps, and a terminal that has run a command or two.
 * Loaded after tests/render/fake-tauri.js by scripts/render-help.mjs, which
 * it wraps: whatever it doesn't answer, the base fake does (the drawn
 * desktops that stand in for checkpoint pictures and the live screen).
 * Nothing here ships.
 *
 * The harness fixes the page's clock, so "Today" and "Yesterday" and the
 * weekdays on the checkpoints are the same on every run.
 */
;(() => {
  const base = window.__TAURI__.core
  const query = new URLSearchParams(location.search)
  const GiB = 1024 ** 3
  const now = new Date()
  const at = (daysAgo, h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, m).toISOString()
  const notes = (title, text = "", tags = []) => ({ title, text, tags, updatedAt: now.toISOString() })
  const pics = (name) => ({ screenshot: `/fake/saves/help/${name}/screen.png`, thumbnail: `/fake/saves/help/${name}/thumb.png`, screenSize: { width: 1920, height: 1200 } })
  const save = (name, kind, createdAt, gib, title = null, note = null) => ({
    name,
    kind,
    createdAt,
    bytes: gib * GiB,
    compatible: true,
    incompatible: [],
    format: "zstd",
    ...pics(name),
    title,
    notes: note,
  })

  // Oldest first in the list; the view lays them out by time.
  const saves = [
    save("baseline", "baseline", at(14, 10, 2), 4.1),
    save("vs-installed", "manual", at(9, 16, 20), 6.2, "Visual Studio installed", notes("Visual Studio installed")),
    save("auto-vs", "auto", at(9, 17, 48), 6.2),
    save("before-update", "manual", at(6, 9, 30), 7.4, "Before Windows Update", notes("Before Windows Update", "KB5050094 is pending.", ["updates"])),
    save("after-update", "manual", at(6, 13, 12), 7.6, "After Windows Update"),
    save("auto-sat", "auto", at(3, 11, 12), 7.8),
    save("repro-4521", "manual", at(3, 19, 2), 7.9, "Repro for bug 4521", notes("Repro for bug 4521", "Open Excel, then paste twice.", ["bug"])),
    save("office-installed", "manual", at(1, 14, 21), 8.4, "Office installed", notes("Office installed", "Signed in. Excel is activated.", ["office"])),
    save("auto-yesterday", "auto", at(1, 18, 5), 8.4),
    save("clean-desktop", "manual", at(0, 9, 12), 8.5, "Clean desktop"),
    save("auto-today", "auto", at(0, 11, 40), 8.6),
    save("before-installer", "manual", at(0, 13, 33), 8.6, "Before the new installer"),
  ]

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
    overlayBytes: 8.6 * GiB,
    guest: { agent: "ok", agentVersion: "1.0", os: "Windows 11" },
    saves: { count: saves.length, bytes: 80 * GiB },
    notes: [],
  }
  const out = (stdout, code = 0) => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" })
  const flag = (args, key) => args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3)

  const claude = {
    instance: "canvas-test",
    server: "winvm-canvas-test",
    clients: [
      { id: "claude-code", name: "Claude Code", available: true, added: false, current: false, config: "~/.claude.json" },
      { id: "claude-desktop", name: "Claude Desktop", available: true, added: false, current: false, config: "~/Library/Application Support/Claude/claude_desktop_config.json" },
    ],
  }

  // A Windows folder, as the in-guest agent lists it. Modified times are in ms.
  const min = 60_000
  const file = (name, size, ago) => ({ name, dir: false, size, modified: now.getTime() - ago, hidden: false })
  const folder = (name, ago) => ({ name, dir: true, size: null, modified: now.getTime() - ago, hidden: false })
  const home = "C:\\Users\\Administrator"
  const listing = {
    path: `${home}\\Desktop`,
    parent: home,
    total: 8,
    entries: [
      folder("Build logs", 26 * 60 * min),
      folder("Invoices 2026", 3 * 24 * 60 * min),
      folder("Test data", 9 * 24 * 60 * min),
      file("budget.xlsx", 48_200, 40 * min),
      file("install.log", 312_000, 95 * min),
      file("meeting-notes.docx", 31_500, 5 * 60 * min),
      file("setup.exe", 84_300_000, 2 * 24 * 60 * min),
      file("screenshot.png", 912_000, 4 * 24 * 60 * min),
    ],
    places: [
      { kind: "desktop", name: "Desktop", path: `${home}\\Desktop` },
      { kind: "documents", name: "Documents", path: `${home}\\Documents` },
      { kind: "downloads", name: "Downloads", path: `${home}\\Downloads` },
      { kind: "home", name: "Administrator", path: home },
      { kind: "work", name: "work", path: "C:\\work" },
      { kind: "drive", name: "C:", path: "C:\\" },
    ],
  }

  async function run(args) {
    const [verb, ...rest] = args
    if (verb === "status") return out(query.get("state") === "stopped" ? { ...status, state: "stopped", vmStatus: "stopped", pid: null, guest: null } : status)
    if (verb === "saves" && !rest.includes("note") && !rest.includes("rm")) return out(saves)
    if (verb === "mcp" && rest[0] === "status") return out(claude)
    if (verb === "terminal" && rest.includes("--shells")) return out({ pwsh: true, powershell: true, cmd: true })
    if (verb === "terminal" && rest.includes("--connect")) return out(JSON.parse(query.get("term") ?? "null") ?? "", query.has("term") ? 0 : 1)
    return null
  }

  window.__TAURI__.core = {
    ...base,
    async invoke(cmd, args = {}) {
      if (cmd === "winvm") {
        const got = await run(args.args)
        if (got !== null) return got
      }
      if (cmd === "agent_fetch") {
        if (args.path.startsWith("/fs/list")) return { status: 200, body: listing }
        return { status: 404, body: { error: "not in the fake", code: null } }
      }
      if (cmd === "terminal_take") {
        // Once: the Terminal window asks again whenever it is rung.
        if (window.__terminalTaken === true) return []
        window.__terminalTaken = true
        return [{ instance: "canvas-test", shell: "pwsh", cwd: null, installed: ["pwsh", "powershell", "cmd"], title: "Work PC" }]
      }
      if (cmd === "home_dir") return "/Users/you"
      return await base.invoke(cmd, args)
    },
  }
})()
