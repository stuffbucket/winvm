/**
 * The shared folder and clipboard: the QEMU arguments and what they do to the
 * save hash (sharing or not, the same), the share settings, virtiofsd's
 * lifecycle (with a fake daemon), `share status`'s logic, the change notices,
 * the guest agent's /fs/touch, and reading files out of an ISO by ranges.
 * No VM needed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseArgs } from "../src/args"
import { RAMFB, VIRTIO_GPU, writeDisplay } from "../src/display"
import { touchPaths } from "../src/guestagent"
import { pathsFor, type InstanceMeta, type Paths } from "../src/paths"
import { qemuArgs } from "../src/qemu"
import { hardwareArgs, hardwareBeforeDevices, takenBeforeDevices } from "../src/saves"
import { noticeTarget } from "../src/service"
import * as share from "../src/share"
import { parseGuestProbe, setArgs, shareStatus } from "../src/sharecmds"
import { parseDirectory, readIsoFiles } from "../src/sharemedia"
import { ChangeNotices } from "../src/sharewatch"

const sha = (a: readonly string[]): string => JSON.stringify(hardwareArgs(a))
const META: InstanceMeta = { image: "win11-arm64", vnc: 9, created: "" }
const LAUNCH = { installMedia: false, ephemeral: false, virtioBoot: true } as const

let home = ""
const saved: Record<string, string | undefined> = {}
let prevProbe: share.Probe

beforeAll(() => {
  for (const k of ["WINVM_HOME", "WINVM_RUNTIME"]) saved[k] = process.env[k]
  home = mkdtempSync(resolve(tmpdir(), "winvm-share-"))
  process.env["WINVM_HOME"] = home
  // A runtime directory to find; what it supports is the probe's answer.
  process.env["WINVM_RUNTIME"] = resolve(home, "runtime")
  mkdirSync(resolve(home, "runtime", "bin"), { recursive: true })
  prevProbe = share.setProbe(() => ({ ok: true, reason: null }))
})

afterAll(() => {
  share.setProbe(prevProbe)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
})

const instance = (name: string, display = VIRTIO_GPU): Paths => {
  const p = pathsFor(name)
  mkdirSync(p.dir, { recursive: true })
  writeDisplay(p, display)
  return p
}

describe("the QEMU command line", () => {
  it("gives a virtio-gpu instance the shared memory, virtio-fs and the clipboard port", () => {
    const p = instance("gpu")
    const a = qemuArgs("gpu", p, META, LAUNCH)
    expect(a[a.indexOf("-machine") + 1]).toBe("virt,accel=hvf,memory-backend=mem")
    expect(a).toContain(`memory-backend-shm,id=mem,size=${String(share.GUEST_MEM_MIB)}M,share=on`)
    expect(a).toContain(`socket,id=vfs0,path=${share.virtiofsdSocket(p)}`)
    expect(a).toContain("vhost-user-fs-pci,chardev=vfs0,tag=winvm,queue-size=1024,addr=0x10")
    expect(a).toContain("qemu-vdagent,id=vdagent,clipboard=on,mouse=off")
    expect(a).toContain("virtserialport,chardev=vdagent,name=com.redhat.spice.0")
    expect(a[a.indexOf("-m") + 1]).toBe(String(share.GUEST_MEM_MIB))
  })

  it("leaves a ramfb instance exactly as it was", () => {
    const p = instance("fb", RAMFB)
    const a = qemuArgs("fb", p, META, LAUNCH)
    expect(a).toEqual(qemuArgs("fb", p, META, { ...LAUNCH, shareDevices: "none" }))
    expect(a[a.indexOf("-machine") + 1]).toBe("virt,accel=hvf")
    expect(a.join(" ")).not.toContain("vhost-user-fs")
  })

  it("gives a build the virtio-fs device only, so provisioning can bind viofs on ramfb", () => {
    const p = instance("build-x")
    const a = qemuArgs("build-x", p, META, { ...LAUNCH, installMedia: true }).join(" ")
    expect(a).toContain("vhost-user-fs-pci")
    expect(a).toContain("-device ramfb")
    expect(a).not.toContain("qemu-vdagent")
  })

  it("adds nothing on a runtime without the pieces", () => {
    const prev = share.setProbe(() => ({ ok: false, reason: "no virtiofsd" }))
    try {
      const p = instance("old")
      expect(qemuArgs("old", p, META, LAUNCH).join(" ")).not.toContain("vhost-user-fs")
      expect(share.unavailableReason(VIRTIO_GPU)).toBe("no virtiofsd")
    } finally {
      share.setProbe(prev)
    }
  })

  it("puts virtio-fs in a fixed PCI slot whatever the display", () => {
    const p = instance("slot")
    for (const set of ["fs", "all"] as const) expect(share.deviceArgs(p, set).join(" ")).toContain(",addr=0x10")
    expect(share.deviceArgs(p, "none")).toEqual([])
  })
})

describe("the save hash", () => {
  it("is the same shared or not, whatever the folder, letter or read-only", () => {
    const p = instance("h1")
    const none = sha(qemuArgs("h1", p, META, LAUNCH))
    mkdirSync(resolve(home, "folder"), { recursive: true })
    share.writeShare(p, { path: resolve(home, "folder"), letter: "Y", readonly: true })
    expect(sha(qemuArgs("h1", p, META, LAUNCH))).toBe(none)
    share.writeShare(p, null)
    expect(sha(qemuArgs("h1", p, META, LAUNCH))).toBe(none)
  })

  it("is the same for two instances (their sockets are per-instance paths)", () => {
    const a = instance("h2")
    const b = instance("h3")
    expect(sha(qemuArgs("h2", a, META, LAUNCH))).toBe(sha(qemuArgs("h3", b, META, LAUNCH)))
  })

  it("changed once, from the hardware before the devices, which names the stranded saves", () => {
    const p = instance("h4")
    const before = hardwareBeforeDevices("h4", META)
    expect(before).not.toBeNull()
    const legacy = sha(qemuArgs("h4", p, META, { ...LAUNCH, shareDevices: "none" }))
    expect(sha(qemuArgs("h4", p, META, LAUNCH))).not.toBe(legacy)
    expect(takenBeforeDevices({ compatParts: { base: "", hardware: before ?? "", firmware: "", qemu: "" } }, before)).toBe(true)
    expect(takenBeforeDevices({ compatParts: { base: "", hardware: "other", firmware: "", qemu: "" } }, before)).toBe(false)
    expect(takenBeforeDevices({}, before)).toBe(false)
  })

  it("strands nothing on a ramfb instance", () => {
    instance("h5", RAMFB)
    expect(hardwareBeforeDevices("h5", META)).toBeNull()
  })
})

describe("share settings", () => {
  it("parses drive letters D to Z", () => {
    expect(share.parseLetter("z")).toBe("Z")
    expect(share.parseLetter("Y:")).toBe("Y")
    expect(share.parseLetter("C")).toBeNull()
    expect(share.parseLetter("ZZ")).toBeNull()
    expect(share.parseLetter("")).toBeNull()
  })

  it("expands ~ and relative paths", () => {
    expect(share.expandPath("~/x").endsWith("/x")).toBe(true)
    expect(share.expandPath("a/b", "/base")).toBe("/base/a/b")
  })

  it("round-trips, and reads a damaged file as no share", () => {
    const p = instance("cfg")
    expect(share.readShare(p)).toBeNull()
    share.writeShare(p, { path: "/Users/x/Projects", letter: "Y", readonly: true })
    expect(share.readShare(p)).toEqual({ path: "/Users/x/Projects", letter: "Y", readonly: true })
    writeFileSync(share.shareConfigPath(p), '{"path":"relative","letter":"Y"}')
    expect(share.readShare(p)).toBeNull()
    writeFileSync(share.shareConfigPath(p), '{"path":"/a","letter":"C"}')
    expect(share.readShare(p)).toEqual({ path: "/a", letter: "Z", readonly: false })
    writeFileSync(share.shareConfigPath(p), "not json")
    expect(share.readShare(p)).toBeNull()
  })

  it("serves the folder, or the empty read-only directory when there is none or it is gone", () => {
    const p = instance("srv")
    expect(share.servedFor(p, null)).toEqual({ dir: share.emptyShareDir(p), readonly: true, folder: null })
    const gone = resolve(home, "gone")
    expect(share.servedFor(p, { path: gone, letter: "Z", readonly: false })).toEqual({ dir: share.emptyShareDir(p), readonly: true, folder: null, missing: gone })
    const here = resolve(home, "here")
    mkdirSync(here, { recursive: true })
    expect(share.servedFor(p, { path: here, letter: "Z", readonly: true })).toEqual({ dir: here, readonly: true, folder: here })
  })

  it("passes read-only to virtiofsd", () => {
    const p = instance("ro")
    const a = share.daemonArgs(p, { dir: "/x", readonly: true, folder: "/x" })
    expect(a).toContain("--readonly")
    expect(a.slice(0, 2)).toEqual(["--shared-dir", "/x"])
    expect(a).toContain("guest-error")
    expect(share.daemonArgs(p, { dir: "/x", readonly: false, folder: "/x" })).not.toContain("--readonly")
  })

  it("reads `--readonly PATH` as a path, since the parser takes it as the flag's value", () => {
    expect(setArgs(parseArgs(["set", "--readonly", "/p"]))).toEqual({ path: "/p", readonly: true, letter: null })
    expect(setArgs(parseArgs(["set", "/p", "--readonly"]))).toEqual({ path: "/p", readonly: true, letter: null })
    expect(setArgs(parseArgs(["set", "/p", "--letter", "Y"]))).toEqual({ path: "/p", readonly: false, letter: "Y" })
  })
})

describe("the runtime's support", () => {
  it("needs vhost-user-fs-pci, qemu-vdagent and memory-backend-shm", () => {
    const devices = 'name "vhost-user-fs-pci", bus PCI\nname "virtio-net-pci"'
    expect(share.parseSupport(devices, "Available chardev backend types: \n  qemu-vdagent\n  socket\n", "  memory-backend-shm\n")).toEqual({ ok: true, reason: null })
    const s = share.parseSupport('name "virtio-net-pci"', "  socket\n", "  memory-backend-ram\n")
    expect(s.ok).toBe(false)
    expect(s.reason).toContain("vhost-user-fs-pci, qemu-vdagent, memory-backend-shm")
  })
})

describe("virtiofsd's lifecycle", () => {
  let p: Paths
  let fake = ""
  beforeEach(() => {
    p = instance("life")
    // A stand-in that binds nothing but makes the socket path appear, as virtiofsd does, then waits.
    fake = resolve(home, "fakebin", "virtiofsd")
    mkdirSync(resolve(home, "fakebin"), { recursive: true })
    writeFileSync(
      fake,
      '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --socket-path ] && sock=$2; shift; done\n[ -n "$FAKE_FAIL" ] && { echo "cannot serve"; exit 1; }\n: > "$sock"\nwhile :; do sleep 1; done\n',
    )
    chmodSync(fake, 0o755)
  })
  afterEach(() => {
    share.stopVirtiofsd(p)
    delete process.env["FAKE_FAIL"]
  })

  it("starts one, waits for its socket, records what it serves, and finds it by its socket", async () => {
    const served = await share.startVirtiofsd(p, { bin: fake })
    expect(served.dir).toBe(share.emptyShareDir(p))
    expect(existsSync(share.virtiofsdSocket(p))).toBe(true)
    expect(share.readServing(p)).toEqual({ dir: share.emptyShareDir(p), readonly: true, folder: null })
    expect(share.virtiofsdPids(p).length).toBe(1)
    expect(readFileSync(share.virtiofsdLog(p), "utf8")).toContain("serving")
  })

  it("replaces one left from an earlier QEMU, and never another instance's", async () => {
    const other = instance("life-2")
    await share.startVirtiofsd(other, { bin: fake })
    await share.startVirtiofsd(p, { bin: fake })
    const first = share.virtiofsdPids(p)
    await share.startVirtiofsd(p, { bin: fake })
    expect(share.virtiofsdPids(p)).not.toEqual(first)
    expect(share.virtiofsdPids(p).length).toBe(1)
    expect(share.virtiofsdPids(other).length).toBe(1)
    share.stopVirtiofsd(other)
    expect(share.virtiofsdPids(other).length).toBe(0)
  })

  it("stops it, with its socket and record", async () => {
    await share.startVirtiofsd(p, { bin: fake })
    share.stopVirtiofsd(p)
    expect(share.virtiofsdPids(p).length).toBe(0)
    expect(existsSync(share.virtiofsdSocket(p))).toBe(false)
    expect(share.readServing(p)).toBeNull()
  })

  it("says why when the daemon does not start", async () => {
    process.env["FAKE_FAIL"] = "1"
    expect(share.startVirtiofsd(p, { bin: fake, timeoutMs: 3000 })).rejects.toThrow(/cannot serve/)
    await Bun.sleep(200)
    expect(share.readServing(p)).toBeNull()
  })

  it("serves the folder chosen", async () => {
    const dir = resolve(home, "chosen")
    mkdirSync(dir, { recursive: true })
    share.writeShare(p, { path: dir, letter: "Z", readonly: false })
    await share.startVirtiofsd(p, { bin: fake })
    const ps = spawnSync("ps", ["-o", "command=", "-p", String(share.virtiofsdPids(p)[0])], { encoding: "utf8" }).stdout
    expect(ps).toContain(`--shared-dir ${dir}`)
    expect(ps).not.toContain("--readonly")
    share.writeShare(p, null)
  })
})

describe("share status", () => {
  const wanted = (dir: string, readonly = false): share.Served => ({ dir, readonly, folder: dir })
  const guest = { installed: true, mounted: true }
  it("is pending when the running daemon serves something else", () => {
    const s = shareStatus({ cfg: { path: "/b", letter: "Z", readonly: false }, unavailable: null, running: true, serving: wanted("/a"), wanted: wanted("/b"), guest })
    expect(s.pending).toBe(true)
    expect(s.serving).toBe("/a")
    expect(s.folder).toBe("/b")
  })
  it("is not pending when it serves the folder, or when stopped", () => {
    expect(shareStatus({ cfg: { path: "/a", letter: "Z", readonly: false }, unavailable: null, running: true, serving: wanted("/a"), wanted: wanted("/a"), guest }).pending).toBe(false)
    const stopped = shareStatus({ cfg: { path: "/a", letter: "Y", readonly: true }, unavailable: null, running: false, serving: null, wanted: wanted("/a", true), guest: { installed: null, mounted: null } })
    expect(stopped).toMatchObject({ pending: false, serving: null, letter: "Y", readonly: true, available: true })
  })
  it("counts a read-only change as a change", () => {
    expect(shareStatus({ cfg: { path: "/a", letter: "Z", readonly: true }, unavailable: null, running: true, serving: wanted("/a"), wanted: wanted("/a", true), guest }).pending).toBe(true)
  })
  it("says why it is unavailable", () => {
    const s = shareStatus({ cfg: null, unavailable: "ramfb", running: true, serving: null, wanted: { dir: "/e", readonly: true, folder: null }, guest })
    expect(s).toMatchObject({ available: false, reason: "ramfb", folder: null, letter: "Z", pending: false })
  })
  it("reads the guest's probe", () => {
    expect(parseGuestProbe("True|OK|True")).toEqual({ installed: true, mounted: true })
    expect(parseGuestProbe("True|Error|False")).toEqual({ installed: false, mounted: false })
    expect(parseGuestProbe("False|absent|False")).toEqual({ installed: false, mounted: false })
    expect(parseGuestProbe("garbage")).toEqual({ installed: null, mounted: null })
  })
  it("watches only a writable folder the running daemon serves", () => {
    const p = instance("nt")
    expect(noticeTarget(p, true)).toBeNull()
    writeFileSync(share.virtiofsdState(p), JSON.stringify({ dir: "/f", readonly: false, folder: "/f" }))
    expect(noticeTarget(p, false)).toBeNull()
    expect(noticeTarget(p, true)).toEqual({ root: "/f", letter: "Z" })
    writeFileSync(share.virtiofsdState(p), JSON.stringify({ dir: "/f", readonly: true, folder: "/f" }))
    expect(noticeTarget(p, true)).toBeNull()
    writeFileSync(share.virtiofsdState(p), JSON.stringify({ dir: share.emptyShareDir(p), readonly: true, folder: null }))
    expect(noticeTarget(p, true)).toBeNull()
  })
})

describe("change notices", () => {
  const make = (state: Map<string, string>, sent: string[][], o: { maxPaths?: number; fail?: boolean } = {}): ChangeNotices =>
    new ChangeNotices({
      root: "/r",
      debounceMs: 10,
      ...(o.maxPaths === undefined ? {} : { maxPaths: o.maxPaths }),
      watch: () => ({ close: () => undefined }),
      state: (abs) => state.get(abs) ?? "gone",
      send: async (paths) => {
        if (o.fail === true) throw new Error("agent busy")
        sent.push([...paths])
        await Promise.resolve()
      },
    })

  it("batches what changed within the quiet time", async () => {
    const state = new Map([["/r/a.txt", "1:1"], ["/r/sub/b.txt", "2:2"]])
    const sent: string[][] = []
    const n = make(state, sent)
    n.changed("a.txt")
    n.changed("sub/b.txt")
    n.changed("a.txt")
    await Bun.sleep(40)
    await n.stop()
    expect(sent).toEqual([["a.txt", "sub/b.txt"]])
  })

  it("does not echo its own touch: a path is sent again only when its state changed", async () => {
    const state = new Map([["/r/a.txt", "1:1"]])
    const sent: string[][] = []
    const n = make(state, sent)
    n.changed("a.txt")
    await Bun.sleep(40)
    n.changed("a.txt") // the guest's touch, reported back by FSEvents
    await Bun.sleep(40)
    state.set("/r/a.txt", "5:9") // a real change on the Mac
    n.changed("a.txt")
    await Bun.sleep(40)
    state.delete("/r/a.txt") // deleted
    n.changed("a.txt")
    await Bun.sleep(40)
    await n.stop()
    expect(sent).toEqual([["a.txt"], ["a.txt"], ["a.txt"]])
  })

  it("touches the whole drive for a change too big for one request", async () => {
    const state = new Map<string, string>()
    const sent: string[][] = []
    const n = make(state, sent, { maxPaths: 2 })
    for (const f of ["a", "b", "c"]) {
      state.set(`/r/${f}`, "1:1")
      n.changed(f)
    }
    await Bun.sleep(40)
    await n.stop()
    expect(sent).toEqual([["."]])
  })

  it("ignores paths outside the folder and survives a guest that does not answer", async () => {
    const sent: string[][] = []
    const n = make(new Map([["/r/x", "1:1"]]), sent, { fail: true })
    n.changed("../escape")
    n.changed("")
    n.changed("x")
    await Bun.sleep(40)
    await n.stop()
    expect(sent).toEqual([])
  })
})

describe("the agent's /fs/touch", () => {
  let root = ""
  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), "winvm-touch-"))
    mkdirSync(resolve(root, "sub"))
    writeFileSync(resolve(root, "sub", "a.txt"), "a")
    utimesSync(resolve(root, "sub", "a.txt"), 1_700_000_000, 1_700_000_000.25)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("leaves a file with the times it had", async () => {
    expect(await touchPaths(root, ["sub/a.txt"])).toEqual({ touched: 1, failed: 0 })
    expect(Math.round(statSync(resolve(root, "sub", "a.txt")).mtimeMs)).toBe(1_700_000_000_250)
  })

  it("touches the nearest folder of a path that is gone, once", async () => {
    expect(await touchPaths(root, ["sub/gone.txt", "sub/also-gone.txt", "sub\\a.txt"])).toEqual({ touched: 2, failed: 0 })
  })

  it("refuses paths that climb out, and bad requests", async () => {
    expect(await touchPaths(root, ["../outside"])).toEqual({ touched: 0, failed: 1 })
    expect(touchPaths(root, "x")).rejects.toThrow(/array/)
    expect(touchPaths("", [])).rejects.toThrow(/root/)
    expect(touchPaths(root, Array.from({ length: 2001 }, () => "a"))).rejects.toThrow(/at most/)
  })
})

describe("reading an ISO by ranges", () => {
  let dir = ""
  let iso = ""
  beforeAll(() => {
    dir = mkdtempSync(resolve(tmpdir(), "winvm-iso-"))
    const src = resolve(dir, "src")
    mkdirSync(resolve(src, "viofs", "w11", "ARM64"), { recursive: true })
    mkdirSync(resolve(src, "viofs", "w11", "amd64"), { recursive: true })
    writeFileSync(resolve(src, "viofs", "w11", "ARM64", "viofs.inf"), "arm64 inf")
    writeFileSync(resolve(src, "viofs", "w11", "ARM64", "virtiofs.exe"), Buffer.alloc(5000, 7))
    writeFileSync(resolve(src, "viofs", "w11", "amd64", "viofs.inf"), "amd64 inf")
    iso = resolve(dir, "t.iso")
    spawnSync("hdiutil", ["makehybrid", "-iso", "-joliet", "-o", iso, src], { stdio: "ignore" })
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const fileRanges = (path: string) => async (offset: number, length: number): Promise<Uint8Array> => {
    const fd = openSync(path, "r")
    try {
      const b = Buffer.alloc(length)
      readSync(fd, b, 0, length, offset)
      return b
    } finally {
      closeSync(fd)
    }
  }

  it("walks the directories, case-insensitively, and reads the files", async () => {
    const files = await readIsoFiles(fileRanges(iso), ["VIOFS", "w11", "arm64"], ["viofs.inf", "virtiofs.exe"])
    expect(Buffer.from(files.get("viofs.inf") ?? []).toString()).toBe("arm64 inf")
    expect(files.get("virtiofs.exe")?.length).toBe(5000)
  })

  it("names what is missing", async () => {
    expect(readIsoFiles(fileRanges(iso), ["viofs", "w10"], ["viofs.inf"])).rejects.toThrow(/viofs\/w10/)
    expect(readIsoFiles(fileRanges(iso), ["viofs", "w11", "ARM64"], ["viofs.sys"])).rejects.toThrow(/viofs.sys/)
    expect(readIsoFiles(async (_o, n) => new Uint8Array(n), ["viofs"], [])).rejects.toThrow(/ISO 9660/)
  })

  it("skips the . and .. records and sector padding", () => {
    const sector = new Uint8Array(4096)
    const rec = (at: number, name: string, dirFlag: boolean): number => {
      const len = 33 + name.length + (name.length % 2 === 0 ? 1 : 0)
      sector[at] = len
      new DataView(sector.buffer).setUint32(at + 2, 42, true)
      new DataView(sector.buffer).setUint32(at + 10, 7, true)
      sector[at + 25] = dirFlag ? 2 : 0
      sector[at + 32] = name.length
      sector.set(Buffer.from(name, "latin1"), at + 33)
      return at + len
    }
    let at = rec(0, "\0", true)
    at = rec(at, "\x01", true)
    rec(at, "A.TXT;1", false)
    rec(2048, "DIR", true)
    expect(parseDirectory(sector)).toEqual([
      { name: "A.TXT", lba: 42, size: 7, dir: false },
      { name: "DIR", lba: 42, size: 7, dir: true },
    ])
  })
})
