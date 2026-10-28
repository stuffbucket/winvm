/**
 * The guest's drives in Finder (finder.ts, smbstate.ts): smb.json, the mount
 * table and the "is it really our mount" check, and the lifecycle hooks —
 * against a fake Mac (Sys) and a state directory laid out by hand. No VM, no
 * mounts, nothing run.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { AgentClient, AgentError } from "../src/agent"
import { forwardedPorts, hostfwdRule } from "../src/agentfwd"
import type { Sys } from "../src/finder"
import { EAUTH, afterUp, beforeDown, cleanStale, mountShares, staleMounts, status, unmountShare, unmountShares } from "../src/finder"
import { SMB_SHARES, smbSetupError, smbSetupScript, startAgent } from "../src/guestagent"
import { pathsFor } from "../src/paths"
import type { MountEntry, SmbState } from "../src/smbstate"
import {
  SHARES,
  ensureSmb,
  findOurMount,
  isOurMount,
  mountDir,
  newPassword,
  parseMountTable,
  parseSmb,
  readSmb,
  shareFor,
  smbPath,
  withMounted,
  writeSmb,
} from "../src/smbstate"

let state: string
let mounts: string
const saved = { home: process.env["WINVM_HOME"], mounts: process.env["WINVM_MOUNTS"] }

beforeEach(() => {
  state = mkdtempSync(resolve(tmpdir(), "winvm-finder-"))
  mounts = resolve(state, "mnt")
  process.env["WINVM_HOME"] = state
  process.env["WINVM_MOUNTS"] = mounts
  mkdirSync(pathsFor("vm").dir, { recursive: true })
})
afterEach(() => {
  rmSync(state, { recursive: true, force: true })
  for (const [k, v] of [["WINVM_HOME", saved.home], ["WINVM_MOUNTS", saved.mounts]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const PORT = 61308
const smbLine = (share: string, dir: string, port = PORT): string =>
  `//winvm-share@127.0.0.1:${String(port)}/${share} on ${dir} (smbfs, nodev, nosuid, nobrowse, mounted by me)`

const TABLE = [
  "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
  "devfs on /dev (devfs, local, nobrowse)",
  "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)",
  "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
  smbLine("C", "/Users/me/winvm/vm/C"),
  smbLine("Home", "/Users/me/My Stuff/winvm/vm/Home"),
].join("\n")

describe("smb.json", () => {
  it("is made once, mode 0600, with a long password, and read back the same", () => {
    const p = pathsFor("vm")
    const first = ensureSmb(p)
    expect(first.created).toBe(true)
    expect(first.state.user).toBe("winvm-share")
    expect(first.state.password.length).toBeGreaterThanOrEqual(20)
    expect(first.state.hostPort).toBeNull()
    expect(first.state.mounted).toEqual([])
    expect(statSync(smbPath(p)).mode & 0o777).toBe(0o600)
    const again = ensureSmb(p)
    expect(again.created).toBe(false)
    expect(again.state).toEqual(first.state)
  })

  it("passwords are 20+ bytes of randomness in characters the guest's script can quote", () => {
    const a = newPassword()
    expect(a).not.toBe(newPassword())
    expect(a).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(smbSetupError({ user: "winvm-share", password: a })).toBeNull()
  })

  it("rejects what is not a usable state, and keeps only known shares", () => {
    expect(parseSmb("not json")).toBeNull()
    expect(parseSmb(JSON.stringify({ user: "u", password: "short" }))).toBeNull()
    const s = parseSmb(JSON.stringify({ user: "u", password: "x".repeat(24), hostPort: 99999, mounted: ["c", "d", "home", "c", 3] }))
    expect(s).toEqual({ user: "u", password: "x".repeat(24), hostPort: null, mounted: ["c", "home"] })
  })

  it("remembers and forgets mounted shares", () => {
    const s: SmbState = { user: "u", password: "x".repeat(24), hostPort: PORT, mounted: [] }
    const on = withMounted(withMounted(s, "home", true), "home", true)
    expect(on.mounted).toEqual(["home"])
    expect(withMounted(on, "home", false).mounted).toEqual([])
    writeSmb(pathsFor("vm"), on)
    expect(readSmb(pathsFor("vm"))).toEqual(on)
  })
})

describe("the mount table", () => {
  it("parses mount's output, paths with spaces included", () => {
    const t = parseMountTable(TABLE)
    expect(t).toHaveLength(6)
    expect(t[2]).toEqual({ source: "/dev/disk3s5", dir: "/System/Volumes/Data", type: "apfs" })
    expect(t[4]).toEqual({ source: "//winvm-share@127.0.0.1:61308/C", dir: "/Users/me/winvm/vm/C", type: "smbfs" })
    expect(t[5]?.dir).toBe("/Users/me/My Stuff/winvm/vm/Home")
  })

  it("knows our mount: smbfs, exactly that folder, 127.0.0.1 on our port, that share", () => {
    const t = parseMountTable(TABLE)
    const want = { dir: "/Users/me/winvm/vm/C", port: PORT, share: "C" }
    expect(findOurMount(t, want)?.source).toBe("//winvm-share@127.0.0.1:61308/C")
    expect(findOurMount(t, { ...want, share: "c" })).not.toBeNull()
    expect(findOurMount(t, { ...want, port: PORT + 1 })).toBeNull()
    expect(findOurMount(t, { ...want, share: "Home" })).toBeNull()
    const e: MountEntry = { source: "//winvm-share@10.0.0.9:61308/C", dir: want.dir, type: "smbfs" }
    expect(isOurMount(e, want)).toBe(false)
    expect(isOurMount({ ...e, source: "//winvm-share@127.0.0.1:61308/C", type: "nfs" }, want)).toBe(false)
  })

  it("refuses a folder that is not a mount point, even inside one", () => {
    const t = parseMountTable(TABLE)
    // Inside the Data volume, and inside our own mount: neither is a mount point itself.
    expect(findOurMount(t, { dir: "/Users/me/winvm/vm", port: PORT, share: "C" })).toBeNull()
    expect(findOurMount(t, { dir: "/Users/me/winvm/vm/C/Windows", port: PORT, share: "C" })).toBeNull()
    expect(findOurMount(t, { dir: "/System/Volumes/Data", port: PORT, share: "C" })).toBeNull()
  })
})

describe("guest paths to shares", () => {
  it("maps the profile to Home and the rest of C:\\ to C", () => {
    expect(shareFor("C:\\Users\\Administrator\\Desktop\\a b")).toEqual({ key: "home", rel: ["Desktop", "a b"] })
    expect(shareFor("c:/users/administrator")).toEqual({ key: "home", rel: [] })
    expect(shareFor("C:\\Users\\Public")).toEqual({ key: "c", rel: ["Users", "Public"] })
    expect(shareFor("C:\\")).toEqual({ key: "c", rel: [] })
    expect(shareFor("D:\\x")).toBeNull()
    expect(shareFor("C:\\Windows\\..\\Users")).toBeNull()
    expect(shareFor("relative\\path")).toBeNull()
  })
})

describe("the guest's setup", () => {
  it("holds the body to plain characters", () => {
    expect(smbSetupError({ user: "winvm-share", password: "x".repeat(19) })).not.toBeNull()
    expect(smbSetupError({ user: "winvm-share", password: `${"x".repeat(24)}'; rm` })).not.toBeNull()
    expect(smbSetupError({ user: "a b", password: "x".repeat(24) })).not.toBeNull()
    expect(smbSetupError({ password: "x".repeat(24) })).not.toBeNull()
  })

  it("limits logons before enabling the account, shares C and Home, and lets in 10.0.2.2 alone", () => {
    const pw = newPassword()
    const s = smbSetupScript({ user: "winvm-share", password: pw })
    expect(s.split(pw)).toHaveLength(2)
    for (const right of ["SeDenyInteractiveLogonRight", "SeDenyRemoteInteractiveLogonRight", "SeDenyBatchLogonRight", "SeDenyServiceLogonRight"]) {
      expect(s).toContain(right)
    }
    expect(s).not.toContain("SeDenyNetworkLogonRight")
    expect(s.indexOf("New-LocalUser")).toBeLessThan(s.indexOf("secedit /configure"))
    expect(s).toContain("New-LocalUser -Name $user -Password $secret -Disabled")
    expect(s.indexOf("secedit /configure")).toBeLessThan(s.indexOf("Enable-LocalUser"))
    expect(s).toContain("SpecialAccounts\\UserList")
    expect(s).toContain("-RemoteAddress 10.0.2.2")
    expect(s).toContain("-CachingMode None")
    expect(s).toContain(`'Home' = '${SMB_SHARES["Home"] ?? ""}'`)
    expect(s).not.toMatch(/EncryptData|RequireSecuritySignature/)
  })
  it("is a route that takes the password in the body, checks it, and runs only in Windows", async () => {
    const tokenFile = resolve(state, "token")
    writeFileSync(tokenFile, "tok\n")
    const server = startAgent({ port: 0, hostname: "127.0.0.1", tokenFile, allowFrom: ["127.0.0.1", "::1"] })
    try {
      const c = new AgentClient(`http://127.0.0.1:${String(server.port)}`, "tok")
      const bad = await c.smbSetup({ user: "winvm-share", password: "short" }).catch((e: unknown) => e)
      expect(bad).toBeInstanceOf(AgentError)
      expect((bad as AgentError).status).toBe(400)
      const elsewhere = await c.smbSetup({ user: "winvm-share", password: newPassword() }).catch((e: unknown) => e)
      expect((elsewhere as AgentError).status).toBe(process.platform === "win32" ? 200 : 501)
    } finally {
      server.stop()
    }
  })
})

describe("the forward to 445", () => {
  it("is told apart from the agent's", () => {
    const out = [
      "  Protocol[State]    FD  Source Address  Port   Dest. Address  Port RecvQ SendQ",
      "  TCP[HOST_FORWARD]  12       127.0.0.1 47123       10.0.2.15  7801     0     0",
      "  TCP[HOST_FORWARD]  13       127.0.0.1 61308       10.0.2.15   445     0     0",
    ].join("\n")
    expect(forwardedPorts(out)).toEqual([47123])
    expect(forwardedPorts(out, 445)).toEqual([61308])
    expect(hostfwdRule(61308, 445)).toBe("tcp:127.0.0.1:61308-:445")
  })
})

// --- the fake Mac --------------------------------------------------------------

interface Fake extends Sys {
  table: MountEntry[]
  ran: string[]
  mounts: string[]
  setups: number
  /** What the next mounts answer, in turn; then 0. */
  answers: number[]
  isRunning: boolean
  umountWorks: boolean
}

function fakeSys(): Fake {
  const f: Fake = {
    table: parseMountTable(TABLE).filter((e) => e.type !== "smbfs"),
    ran: [],
    mounts: [],
    setups: 0,
    answers: [],
    isRunning: true,
    umountWorks: true,
    mountTable: () => [...f.table],
    run: (cmd, args) => {
      f.ran.push([cmd, ...args].join(" "))
      const dir = args.at(-1)
      if (cmd.endsWith("diskutil") || f.umountWorks) f.table = f.table.filter((e) => e.dir !== dir)
      return { code: 0, out: "" }
    },
    mount: async (req) => {
      f.mounts.push(req.url)
      const code = f.answers.shift() ?? 0
      if (code === 0) {
        const m = /^smb:\/\/127\.0\.0\.1:(\d+)\/(\w+)$/.exec(req.url)
        f.table.push({ source: `//${req.user}@127.0.0.1:${m?.[1] ?? ""}/${m?.[2] ?? ""}`, dir: req.dir, type: "smbfs" })
      }
      return await Promise.resolve(code)
    },
    setup: async () => {
      f.setups += 1
      await Promise.resolve()
    },
    forward: async () => await Promise.resolve(PORT),
    running: () => f.isRunning,
    sleep: async () => await Promise.resolve(),
    log: () => undefined,
  }
  return f
}

const mountedAt = (f: Fake, key: "c" | "home"): boolean =>
  findOurMount(f.table, { dir: mountDir("vm", key), port: PORT, share: SHARES[key].share }) !== null

describe("unmounting", () => {
  it("does nothing at all to a folder that is not our mount point", () => {
    const f = fakeSys()
    // The Data volume is in the table; the folder is merely inside it.
    expect(unmountShare({ dir: mountDir("vm", "c"), port: PORT, share: "C" }, f)).toBe("not-mounted")
    expect(unmountShare({ dir: "/System/Volumes/Data", port: PORT, share: "C" }, f)).toBe("not-mounted")
    expect(f.ran).toEqual([])
  })

  it("leaves another server's share on our folder alone", () => {
    const f = fakeSys()
    f.table.push({ source: "//someone@127.0.0.1:445/C", dir: mountDir("vm", "c"), type: "smbfs" })
    expect(unmountShare({ dir: mountDir("vm", "c"), port: PORT, share: "C" }, f)).toBe("not-mounted")
    expect(f.ran).toEqual([])
  })

  it("umounts, and forces only a mount point that is still ours", () => {
    const f = fakeSys()
    const dir = mountDir("vm", "c")
    f.table.push({ source: `//winvm-share@127.0.0.1:${String(PORT)}/C`, dir, type: "smbfs" })
    expect(unmountShare({ dir, port: PORT, share: "C" }, f)).toBe("unmounted")
    expect(f.ran).toEqual([`/sbin/umount ${dir}`])

    const g = fakeSys()
    g.umountWorks = false
    g.table.push({ source: `//winvm-share@127.0.0.1:${String(PORT)}/C`, dir, type: "smbfs" })
    expect(unmountShare({ dir, port: PORT, share: "C" }, g)).toBe("unmounted")
    expect(g.ran).toEqual([`/sbin/umount ${dir}`, `/usr/sbin/diskutil unmount force ${dir}`])
  })
})

describe("mounting", () => {
  it("sets the guest up the first time, mounts, and remembers", async () => {
    const f = fakeSys()
    const dirs = await mountShares("vm", ["home", "c"], { sys: f })
    expect(dirs).toEqual([mountDir("vm", "home"), mountDir("vm", "c")])
    expect(f.setups).toBe(1)
    expect(f.mounts).toEqual([`smb://127.0.0.1:${String(PORT)}/Home`, `smb://127.0.0.1:${String(PORT)}/C`])
    expect(readSmb(pathsFor("vm"))?.mounted).toEqual(["home", "c"])
    expect(readSmb(pathsFor("vm"))?.hostPort).toBe(PORT)
    expect(existsSync(mountDir("vm", "c"))).toBe(true)
    // Again: already mounted, nothing to do.
    await mountShares("vm", ["c"], { sys: f })
    expect(f.mounts).toHaveLength(2)
  })

  it("runs the setup again when the guest refuses the password", async () => {
    const f = fakeSys()
    writeSmb(pathsFor("vm"), { user: "winvm-share", password: newPassword(), hostPort: PORT, mounted: [] })
    f.answers = [EAUTH]
    await mountShares("vm", ["c"], { sys: f })
    expect(f.setups).toBe(1)
    expect(f.mounts).toHaveLength(2)
    expect(mountedAt(f, "c")).toBe(true)
  })

  it("waits for a file server that is still starting, then gives up and says so", async () => {
    const f = fakeSys()
    writeSmb(pathsFor("vm"), { user: "winvm-share", password: newPassword(), hostPort: PORT, mounted: [] })
    f.answers = [61, 61, 61]
    await mountShares("vm", ["c"], { sys: f, waitMs: 60_000 })
    expect(f.setups).toBe(0)
    expect(f.mounts).toHaveLength(4)

    const g = fakeSys()
    g.isRunning = false
    await expect(mountShares("vm", ["c"], { sys: g })).rejects.toThrow(/not running/)
  })

  it("refuses to mount over something else mounted there", async () => {
    const f = fakeSys()
    f.table.push({ source: "//other@10.0.0.2/share", dir: mountDir("vm", "c"), type: "smbfs" })
    await expect(mountShares("vm", ["c"], { sys: f })).rejects.toThrow(/already has/)
    expect(f.mounts).toEqual([])
  })

  it("fails with what the guest said, after one setup", async () => {
    const f = fakeSys()
    writeSmb(pathsFor("vm"), { user: "winvm-share", password: newPassword(), hostPort: PORT, mounted: [] })
    f.answers = [EAUTH, EAUTH]
    await expect(mountShares("vm", ["home"], { sys: f })).rejects.toThrow(/refused the sign-in/)
    expect(f.setups).toBe(1)
  })
})

describe("the lifecycle hooks", () => {
  const twoMounted = async (): Promise<Fake> => {
    const f = fakeSys()
    await mountShares("vm", ["home", "c"], { sys: f })
    f.ran = []
    f.mounts = []
    f.setups = 0
    return f
  }

  it("beforeDown unmounts everything and keeps what to mount again", async () => {
    const f = await twoMounted()
    beforeDown("vm", f)
    expect(mountedAt(f, "home") || mountedAt(f, "c")).toBe(false)
    expect(f.ran).toEqual([`/sbin/umount ${mountDir("vm", "home")}`, `/sbin/umount ${mountDir("vm", "c")}`])
    expect(readSmb(pathsFor("vm"))?.mounted).toEqual(["home", "c"])
    // The empty mount folders go.
    expect(existsSync(mountDir("vm", "c"))).toBe(false)
  })

  it("afterUp mounts again what was mounted, without setting up again", async () => {
    const f = await twoMounted()
    beforeDown("vm", f)
    await afterUp("vm", f)
    expect(mountedAt(f, "home") && mountedAt(f, "c")).toBe(true)
    expect(f.setups).toBe(0)
  })

  it("afterUp sets the guest up again when it holds another machine's password", async () => {
    const f = await twoMounted()
    beforeDown("vm", f)
    f.answers = [EAUTH]
    await afterUp("vm", f)
    expect(f.setups).toBe(1)
    expect(mountedAt(f, "home") && mountedAt(f, "c")).toBe(true)
  })

  it("afterUp does nothing for an instance that never shared, or a stopped one, and never throws", async () => {
    const f = fakeSys()
    await afterUp("vm", f)
    expect(f.mounts).toEqual([])
    const g = await twoMounted()
    beforeDown("vm", g)
    g.isRunning = false
    await afterUp("vm", g)
    expect(g.mounts).toEqual([])
    g.isRunning = true
    g.answers = [EAUTH, EAUTH]
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      await afterUp("vm", g)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("cleanStale leaves a running guest's mounts, and unmounts a dead one's", async () => {
    const f = await twoMounted()
    expect(staleMounts("vm", f)).toEqual([])
    expect(cleanStale("vm", f)).toEqual([])
    expect(f.ran).toEqual([])
    f.isRunning = false
    expect(staleMounts("vm", f)).toEqual([mountDir("vm", "home"), mountDir("vm", "c")])
    const said = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect(cleanStale("vm", f)).toEqual([mountDir("vm", "home"), mountDir("vm", "c")])
    } finally {
      said.mockRestore()
    }
    expect(staleMounts("vm", f)).toEqual([])
    expect(readSmb(pathsFor("vm"))?.mounted).toEqual(["home", "c"])
  })

  it("an instance that never shared costs no mount table at all", () => {
    const f = fakeSys()
    let reads = 0
    f.mountTable = () => {
      reads += 1
      return []
    }
    beforeDown("vm", f)
    expect(cleanStale("vm", { ...f, running: () => false })).toEqual([])
    expect(reads).toBe(0)
  })

  it("unmount forgets the share; status tells mounted from remembered", async () => {
    const f = await twoMounted()
    unmountShares("vm", ["c"], f)
    expect(readSmb(pathsFor("vm"))?.mounted).toEqual(["home"])
    const st = status("vm", f)
    expect(st.shares.map((s) => [s.key, s.mounted, s.remembered])).toEqual([
      ["home", true, true],
      ["c", false, false],
    ])
    expect(JSON.stringify(st)).not.toContain(readSmb(pathsFor("vm"))?.password ?? "?")
    expect(readFileSync(smbPath(pathsFor("vm")), "utf8")).toContain('"mounted"')
  })

  it("unmounting by hand keeps a share that would not unmount", async () => {
    const f = await twoMounted()
    f.run = (cmd, args) => {
      f.ran.push([cmd, ...args].join(" "))
      return { code: 1, out: "busy" }
    }
    const r = unmountShares("vm", ["c"], f)
    expect(r.failed).toEqual([mountDir("vm", "c")])
    expect(readSmb(pathsFor("vm"))?.mounted).toEqual(["home", "c"])
  })
})
