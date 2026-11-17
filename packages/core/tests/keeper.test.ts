import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseEntry } from "../src/eventlog"
import { keeperCheck } from "../src/host"
import {
  collectKeepers,
  ensureKeeper,
  findKeeper,
  installKeeper,
  type JobInfo,
  KEEPER_PREFIX,
  keeperJob,
  keeperLabel,
  keeperPin,
  type Launchd,
  parseJobPrint,
  plistXml,
  startKeeper,
} from "../src/keeper"

let tmp = ""

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), "winvm-keeper-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex")

function binary(path: string, text = "#!/bin/sh\necho keeper\n"): string {
  mkdirSync(resolve(path, ".."), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
  return path
}

describe("the keeper's label", () => {
  it("names the instance under a hash of the winvm home", () => {
    const label = keeperLabel("/Users/a/.local/state/winvm", "default")
    expect(label).toMatch(
      /^co\.stuffbucket\.winvm\.keeper\.[0-9a-f]{8}\.default$/,
    )
    expect(label.startsWith(KEEPER_PREFIX)).toBe(true)
  })

  it("is the same for the same home and differs between homes", () => {
    expect(keeperLabel("/h/one", "default")).toBe(
      keeperLabel("/h/one/", "default"),
    )
    expect(keeperLabel("/h/one", "default")).not.toBe(
      keeperLabel("/h/two", "default"),
    )
  })
})

describe("the keeper's launchd job", () => {
  const job = keeperJob({
    label: "co.stuffbucket.winvm.keeper.abcd1234.default",
    program: "/k/0123456789ab/winvm-keeper",
    dir: "/i/default/keeper",
  })

  it("runs the keeper for one instance directory with the default exit timeout", () => {
    expect(job.Label).toBe("co.stuffbucket.winvm.keeper.abcd1234.default")
    expect(job.ProgramArguments).toEqual([
      "/k/0123456789ab/winvm-keeper",
      "run",
      "--dir",
      "/i/default/keeper",
      "--exit-timeout",
      "60",
    ])
    expect(job.ExitTimeOut).toBe(60)
    expect(job.WorkingDirectory).toBe("/i/default/keeper")
    expect(job.StandardOutPath).toBe("/i/default/keeper/keeper.log")
    expect(job.StandardErrorPath).toBe("/i/default/keeper/keeper.log")
  })

  it("lives in the Background session, unthrottled, restarted only after a crash", () => {
    expect(job.LimitLoadToSessionType).toBe("Background")
    expect(job.ProcessType).toBe("Interactive")
    expect(job.RunAtLoad).toBe(true)
    expect(job.KeepAlive).toEqual({ SuccessfulExit: false })
    expect(job.ThrottleInterval).toBe(2)
    expect(job.AbandonProcessGroup).toBe(true)
    expect(job.AssociatedBundleIdentifiers).toEqual(["co.stuffbucket.winvm"])
    expect(job.Umask).toBe(63)
  })

  it("passes a different exit timeout to launchd and to the keeper alike", () => {
    const short = keeperJob({
      label: "l",
      program: "/k",
      dir: "/d",
      exitTimeout: 20,
    })
    expect(short.ExitTimeOut).toBe(20)
    expect(short.ProgramArguments.at(-1)).toBe("20")
  })
})

describe("plistXml", () => {
  it("writes strings, integers, booleans, arrays and dictionaries, escaped", () => {
    const xml = plistXml({
      Label: "a<b>&c",
      N: 63,
      Yes: true,
      No: false,
      List: ["x", "y"],
      Dict: { SuccessfulExit: false },
    })
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>\n')
    expect(xml).toContain(
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    )
    expect(xml).toContain(
      "<key>Label</key>\n\t<string>a&lt;b&gt;&amp;c</string>",
    )
    expect(xml).toContain("<key>N</key>\n\t<integer>63</integer>")
    expect(xml).toContain("<key>Yes</key>\n\t<true/>")
    expect(xml).toContain("<key>No</key>\n\t<false/>")
    expect(xml).toContain(
      "<key>List</key>\n\t<array>\n\t\t<string>x</string>\n\t\t<string>y</string>\n\t</array>",
    )
    expect(xml).toContain(
      "<key>Dict</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>",
    )
    expect(xml).toEndWith("</dict>\n</plist>\n")
  })

  it("is a property list plutil accepts, with the same values", () => {
    if (process.platform !== "darwin") return
    const job = keeperJob({ label: "l", program: "/k", dir: "/d" })
    const file = resolve(tmp, "job.plist")
    writeFileSync(file, plistXml(job))
    const json = spawnSync("plutil", ["-convert", "json", "-o", "-", file], {
      encoding: "utf8",
    })
    expect(json.status).toBe(0)
    expect(JSON.parse(json.stdout)).toEqual(job)
  })
})

describe("finding the keeper", () => {
  const pin = { version: "v0.2.0", url: "unused", sha256: "unused" }

  it("takes WINVM_KEEPER first, then the app's, then the pinned cache", () => {
    const app = resolve(tmp, "winvm.app")
    const execPath = resolve(app, "Contents", "MacOS", "winvm")
    const bundled = binary(resolve(app, "Contents", "MacOS", "winvm-keeper"))
    const cache = resolve(tmp, "cache")
    const cached = binary(resolve(cache, "v0.2.0", "winvm-keeper"))
    const override = binary(resolve(tmp, "dev", "winvm-keeper"))

    expect(
      findKeeper({ env: { WINVM_KEEPER: override }, execPath, cache, pin }),
    ).toEqual({ path: override, source: "override" })
    expect(findKeeper({ env: {}, execPath, cache, pin })).toEqual({
      path: bundled,
      source: "app",
    })
    expect(
      findKeeper({ env: {}, execPath: "/usr/local/bin/bun", cache, pin }),
    ).toEqual({ path: cached, source: "cache" })
  })

  it("finds nothing without a pin, an app or an override, and ignores an empty WINVM_KEEPER", () => {
    expect(
      findKeeper({
        env: { WINVM_KEEPER: "" },
        execPath: "/x/bun",
        cache: resolve(tmp, "cache"),
        pin: null,
      }),
    ).toBeNull()
    expect(
      findKeeper({
        env: {},
        execPath: "/x/bun",
        cache: resolve(tmp, "cache"),
        pin,
      }),
    ).toBeNull()
  })

  it("reads an unpinned keeper.json as no pin", () => {
    expect(keeperPin({ version: null, url: null, sha256: null })).toBeNull()
    expect(keeperPin(pin)).toEqual(pin)
  })
})

describe("ensureKeeper", () => {
  it("downloads the pinned keeper, checks its digest and makes it executable", () => {
    const body = "#!/bin/sh\necho pinned\n"
    const source = binary(resolve(tmp, "release", "winvm-keeper-v0.2.0"), body)
    const cache = resolve(tmp, "cache")
    const found = ensureKeeper({
      pin: { version: "v0.2.0", url: `file://${source}`, sha256: sha256(body) },
      cache,
    })
    const path = resolve(cache, "v0.2.0", "winvm-keeper")
    expect(found).toEqual({ path, source: "cache" })
    expect(readFileSync(path, "utf8")).toBe(body)
    expect(statSync(path).mode & 0o111).toBe(0o111)
  })

  it("refuses a download that does not match the pin", () => {
    const source = binary(resolve(tmp, "release", "winvm-keeper"))
    const cache = resolve(tmp, "cache")
    expect(() =>
      ensureKeeper({
        pin: {
          version: "v0.2.0",
          url: `file://${source}`,
          sha256: "0".repeat(64),
        },
        cache,
      }),
    ).toThrow("does not match its pinned digest")
    expect(existsSync(resolve(cache, "v0.2.0", "winvm-keeper"))).toBe(false)
  })

  it("does nothing without a pin", () => {
    expect(ensureKeeper({ pin: null, cache: resolve(tmp, "cache") })).toBeNull()
    expect(existsSync(resolve(tmp, "cache"))).toBe(false)
  })
})

describe("installing the keeper by content", () => {
  it("copies it to <root>/<sha256[:12]>/winvm-keeper and leaves an installed copy alone", () => {
    const body = "#!/bin/sh\necho v1\n"
    const source = binary(resolve(tmp, "app", "winvm-keeper"), body)
    const root = resolve(tmp, "keeper")
    const installed = installKeeper(source, root)
    expect(installed).toBe(
      resolve(root, sha256(body).slice(0, 12), "winvm-keeper"),
    )
    expect(readFileSync(installed, "utf8")).toBe(body)
    expect(statSync(installed).mode & 0o777).toBe(0o755)
    const inode = statSync(installed).ino
    expect(installKeeper(source, root)).toBe(installed)
    expect(statSync(installed).ino).toBe(inode)
    expect(readdirSync(resolve(root, sha256(body).slice(0, 12)))).toEqual([
      "winvm-keeper",
    ])
  })

  it("puts an updated binary beside the old one instead of over it", () => {
    const source = resolve(tmp, "app", "winvm-keeper")
    const root = resolve(tmp, "keeper")
    const first = installKeeper(binary(source, "one\n"), root)
    const second = installKeeper(binary(source, "two\n"), root)
    expect(second).not.toBe(first)
    expect(readFileSync(first, "utf8")).toBe("one\n")
    expect(readFileSync(second, "utf8")).toBe("two\n")
  })
})

function fakeLaunchd(jobs: Record<string, Partial<JobInfo>>): Launchd & {
  readonly calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    bootstrap: (plist) => {
      calls.push(`bootstrap ${plist}`)
    },
    bootout: (label) => {
      calls.push(`bootout ${label}`)
      return label in jobs
    },
    print: (label) => {
      const job = jobs[label]
      return job === undefined
        ? null
        : {
            state: "running",
            pid: null,
            lastExit: null,
            program: null,
            runs: 1,
            ...job,
          }
    },
    labels: (prefix) => Object.keys(jobs).filter((l) => l.startsWith(prefix)),
  }
}

describe("collecting old keeper versions", () => {
  it("removes versions no loaded keeper job runs, and keeps the current one", () => {
    const root = resolve(tmp, "keeper")
    const used = installKeeper(binary(resolve(tmp, "a"), "used\n"), root)
    const current = installKeeper(binary(resolve(tmp, "b"), "current\n"), root)
    const stale = installKeeper(binary(resolve(tmp, "c"), "stale\n"), root)
    const launchd = fakeLaunchd({
      [`${KEEPER_PREFIX}abcd1234.default`]: { program: used },
      "com.example.other": { program: stale },
    })

    const removed = collectKeepers({ root, launchd, current })

    expect(removed).toEqual([resolve(stale, "..")])
    expect(existsSync(used)).toBe(true)
    expect(existsSync(current)).toBe(true)
    expect(existsSync(stale)).toBe(false)
  })

  it("leaves a root it does not recognise alone", () => {
    const root = resolve(tmp, "keeper")
    mkdirSync(resolve(root, "notes"), { recursive: true })
    expect(
      collectKeepers({ root, launchd: fakeLaunchd({}), current: null }),
    ).toEqual([])
    expect(existsSync(resolve(root, "notes"))).toBe(true)
  })
})

describe("starting a keeper job", () => {
  it("writes the plist beside the instance's keeper directory, boots out the old job, then bootstraps", () => {
    const dir = resolve(tmp, "instances", "default", "keeper")
    const launchd = fakeLaunchd({})
    const job = keeperJob({
      label: "co.stuffbucket.winvm.test.x",
      program: "/k",
      dir,
    })
    const plist = startKeeper({ launchd, job })
    expect(plist).toBe(resolve(dir, "keeper.plist"))
    expect(readFileSync(plist, "utf8")).toBe(plistXml(job))
    expect(statSync(plist).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(launchd.calls).toEqual([
      "bootout co.stuffbucket.winvm.test.x",
      `bootstrap ${plist}`,
    ])
  })
})

describe("parseJobPrint", () => {
  it("reads state, pid, program, runs and the last exit code", () => {
    const text = [
      "user/501/co.stuffbucket.winvm.keeper.abcd1234.default = {",
      "\tactive count = 1",
      "\tpath = /i/default/keeper/keeper.plist",
      "\tstate = running",
      "",
      "\tprogram = /k/0123456789ab/winvm-keeper",
      "\targuments = {",
      "\t\t/k/0123456789ab/winvm-keeper",
      "\t}",
      "",
      "\texit timeout = 60",
      "\truns = 2",
      "\tpid = 4242",
      "\tlast exit code = 1",
      "}",
    ].join("\n")
    expect(parseJobPrint(text)).toEqual({
      state: "running",
      pid: 4242,
      lastExit: 1,
      program: "/k/0123456789ab/winvm-keeper",
      runs: 2,
    })
  })

  it("has no pid or exit code for a job that is loaded but never ran to an exit", () => {
    expect(
      parseJobPrint(
        "x = {\n\tstate = not running\n\truns = 0\n\tlast exit code = (never exited)\n}",
      ),
    ).toEqual({
      state: "not running",
      pid: null,
      lastExit: null,
      program: null,
      runs: 0,
    })
  })
})

describe("keeperCheck", () => {
  it("names where the keeper comes from, and is never a missing prerequisite", () => {
    expect(keeperCheck({ path: "/a/winvm-keeper", source: "app" })).toEqual({
      label: "keeper /a/winvm-keeper (app)",
      ok: true,
      hint: "",
    })
    expect(keeperCheck(null)).toMatchObject({
      label: "keeper not installed (not used yet)",
      ok: true,
    })
  })
})

describe("the keeper's record lines", () => {
  it("parse as keeper entries in the shared golden fixture", () => {
    const fixture = readFileSync(
      resolve(
        import.meta.dir,
        "..",
        "..",
        "..",
        "native",
        "keeper",
        "tests",
        "fixtures",
        "record.jsonl",
      ),
      "utf8",
    )
    const lines = fixture.trim().split("\n")
    expect(lines.length).toBeGreaterThan(5)
    for (const line of lines) {
      const entry = parseEntry(line)
      expect(entry).toMatchObject({ kind: "keeper", instance: "default" })
      expect(entry !== null && "what" in entry && typeof entry.what).toBe(
        "string",
      )
    }
    expect(parseEntry(lines[0] ?? "")).toMatchObject({
      what: "started",
      pid: 4242,
    })
  })
})
