/**
 * The agent skills in skills/ are checked against the CLI they describe:
 * every `winvm …` command line in them must name a real verb, sub-command and
 * flags (on this branch, or on a PENDING branch that ships with them); the
 * generated command reference must be current; the frontmatter must load in
 * Claude Code, Codex and Copilot CLI; and each host helper's sh and PowerShell
 * variants must behave the same.
 *
 * The PowerShell helper runs under `pwsh` when the host has it; otherwise,
 * with WINVM_TEST_INSTANCE naming a running machine (and WINVM_HOME /
 * WINVM_RUNTIME as needed), it runs in that machine's Windows PowerShell 5.1.
 */
import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseArgs } from "../packages/core/src/args"
import { USAGE } from "../packages/core/src/commands"
import { PENDING, REFERENCE, ROOT, SKILLS, combinedUsage, commandLines, frontmatter, renderReference, skillFiles, skillNames, words } from "./skills"

const CLI = resolve(ROOT, "apps", "cli", "src", "winvm.ts")
const CORE = resolve(ROOT, "packages", "core", "src")
const read = (p: string): string => readFileSync(p, "utf8")

// ---------------------------------------------------------------------------
// What the CLI accepts

/** verb -> the core module that handles it, from winvm.ts's dispatch. */
function dispatch(): Map<string, string> {
  const src = read(CLI)
  const aliases = new Map<string, string>()
  for (const m of src.matchAll(/import \* as (\w+) from "@winvm\/core\/(\w+)"/g)) aliases.set(m[1] ?? "", m[2] ?? "")
  const verbs = new Map<string, string>()
  let pending: string[] = []
  for (const line of src.split("\n")) {
    const c = /^\s*case "([a-z-]+)":/.exec(line)
    if (c !== null) pending.push(c[1] ?? "")
    const call = /process\.exit\((?:await )?(\w+)\.\w+\(/.exec(line) ?? /await (\w+)\.runService\(/.exec(line)
    if ((call !== null || /process\.exit\(/.test(line)) && pending.length > 0) {
      for (const v of pending) verbs.set(v, aliases.get(call?.[1] ?? "") ?? "commands")
      pending = []
    }
  }
  return verbs
}

/** A core module's source with the core modules it imports. */
function moduleText(mod: string): string {
  const own = read(resolve(CORE, `${mod}.ts`))
  const deps = [...own.matchAll(/from "\.\/(\w+)"/g)].map((m) => resolve(CORE, `${m[1] ?? ""}.ts`)).filter(existsSync)
  return [own, ...deps.map(read)].join("\n")
}

/** Flags a module (and the core modules it imports) mentions or reads. */
function moduleFlags(mod: string): Set<string> {
  const out = new Set<string>()
  const add = (file: string): string => {
    const p = resolve(CORE, `${file}.ts`)
    if (!existsSync(p)) return ""
    const t = read(p)
    for (const m of t.matchAll(/--([a-z][a-z0-9-]*)/g)) out.add(m[1] ?? "")
    for (const m of t.matchAll(/\b(?:get|has|dur|f)\((?:args, )?"([a-z][a-z0-9-]*)"/g)) out.add(m[1] ?? "")
    return t
  }
  const text = add(mod)
  for (const m of text.matchAll(/from "\.\/(\w+)"/g)) add(m[1] ?? "")
  return out
}

/** verb -> its usage block (its line and the indented lines under it), from the combined usage. */
function usageBlocks(): Map<string, string> {
  const blocks = new Map<string, string>()
  let current: string[] = []
  for (const line of combinedUsage().split("\n")) {
    const head = /^ {2}([a-z][a-z-]*(?:\s*\|\s*[a-z][a-z-]*)*)\b/.exec(line)
    if (head !== null) current = (head[1] ?? "").split("|").map((s) => s.trim())
    else if (!/^ {3,}/.test(line)) current = []
    for (const v of current) blocks.set(v, `${blocks.get(v) ?? ""}${line}\n`)
  }
  return blocks
}

/** Sub-commands the skills may use, each checked against the source below. */
const SUBVERBS: Record<string, readonly string[]> = {
  agent: ["install", "status", "connect"],
  golden: ["create", "reset"],
  mcp: ["install", "uninstall", "status"],
  cua: ["run", "serve"],
  ui: ["windows", "tree", "find", "wait", "click", "rightclick", "doubleclick", "invoke", "toggle", "expand", "collapse", "select", "focus", "set", "type", "tray", "menu", "settle", "at", "ping", "help"],
  webview: ["enable", "disable", "targets", "eval", "click", "wait", "text"],
  skills: ["status", "install", "uninstall", "pack", "path"],
  ...Object.fromEntries(PENDING.flatMap((p) => Object.entries(p.subverbs ?? {}))),
}

// ---------------------------------------------------------------------------
// The command lines in the skills

function allCommandLines(): { file: string; line: string }[] {
  const out: { file: string; line: string }[] = []
  for (const rel of skillFiles()) {
    if (resolve(SKILLS, rel) === REFERENCE) continue // the CLI's own usage text
    const text = read(resolve(SKILLS, rel))
    if (rel.endsWith(".md")) {
      for (const line of commandLines(text)) out.push({ file: rel, line })
      continue
    }
    for (const raw of text.split("\n")) {
      const m = /^\s*(?:#\s*)?(winvm\s.*?)\s*`?$/.exec(raw)
      if (m !== null) for (const line of commandLines(`\`${m[1] ?? ""}\``)) out.push({ file: rel, line })
    }
    if (rel.endsWith(".yml")) {
      const job = Bun.YAML.parse(text) as { steps?: { shell?: string; run?: string }[] }
      for (const s of job.steps ?? []) {
        if (s.shell !== "winvm") continue
        for (const l of (s.run ?? "").split("\n").filter((x) => x.trim() !== "")) out.push({ file: rel, line: `winvm ${l.trim()}` })
      }
    }
  }
  return out
}

describe("the skills' winvm commands", () => {
  const verbs = dispatch()
  const pendingVerbs = new Set(PENDING.flatMap((p) => p.verbs))
  const blocks = usageBlocks()
  const lines = allCommandLines()

  it("finds plenty of them", () => {
    expect(lines.length).toBeGreaterThan(100)
  })

  it("name verbs winvm dispatches", () => {
    const bad = lines.filter(({ line }) => {
      const v = words(line)[1] ?? ""
      return !verbs.has(v) && !pendingVerbs.has(v)
    })
    expect(bad).toEqual([])
  })

  it("use sub-commands that exist", () => {
    for (const [verb, subs] of Object.entries(SUBVERBS)) {
      const mod = verbs.get(verb)
      const where = `${mod === undefined ? "" : moduleText(mod)}\n${blocks.get(verb) ?? ""}`
      for (const s of subs) {
        const found = where.includes(`"${s}"`) || where.includes(`'${s}'`) || new RegExp(`\\b${s}\\b`).test(blocks.get(verb) ?? "")
        expect(found ? "" : `${verb} ${s}: not in ${mod ?? "the usage text"}`).toBe("")
      }
    }
    // These do something without a sub-command: list, serve, report.
    const optional = new Set(["saves", "mcp", "share", "skills"])
    const bad = lines.filter(({ line }) => {
      const w = words(line)
      const subs = SUBVERBS[w[1] ?? ""]
      // A bare `winvm VERB` names the command rather than running it.
      if (subs === undefined || w.length === 2) return false
      const first = parseArgs(w.slice(2)).positional[0]
      return first === undefined ? !optional.has(w[1] ?? "") : !subs.includes(first)
    })
    expect(bad).toEqual([])
  })

  it("use only flags the CLI has", () => {
    const bad: string[] = []
    for (const { file, line } of lines) {
      const w = words(line)
      const verb = w[1] ?? ""
      const dd = w.indexOf("--")
      const own = dd < 0 ? w.slice(2) : w.slice(2, dd)
      const allowed = new Set<string>()
      for (const m of (blocks.get(verb) ?? "").matchAll(/--([a-z][a-z0-9-]*)/g)) allowed.add(m[1] ?? "")
      const mod = verbs.get(verb)
      if (mod !== undefined) for (const f of moduleFlags(mod)) allowed.add(f)
      for (const t of own) {
        if (!t.startsWith("--")) continue
        const f = t.slice(2).split("=")[0] ?? ""
        if (!allowed.has(f)) bad.push(`${file}: ${line}  (--${f})`)
      }
    }
    expect(bad).toEqual([])
  })

  it("give -i a value", () => {
    const bad = lines.filter(({ line }) => {
      const w = words(line)
      const i = w.indexOf("-i")
      return i >= 0 && (w[i + 1] === undefined || w[i + 1]?.startsWith("-") === true)
    })
    expect(bad).toEqual([])
  })
})

describe("the command reference", () => {
  it("is generated from the current usage text", () => {
    expect(read(REFERENCE)).toBe(renderReference())
  })

  it("lists pending branches only until they merge", () => {
    const verbs = dispatch()
    for (const p of PENDING) {
      for (const v of p.verbs) expect(verbs.has(v) ? `${v} is merged: remove ${p.branch} from PENDING in scripts/skills.ts` : "").toBe("")
      for (const l of p.usage) expect(USAGE.includes(l) ? `merged: ${l}` : "").toBe("")
    }
  })

  it("matches each pending branch's usage text, where git has the branch", () => {
    for (const p of PENDING) {
      const r = spawnSync("git", ["-C", ROOT, "show", `origin/${p.branch}:packages/core/src/commands.ts`], { encoding: "utf8" })
      if (r.status !== 0) continue
      for (const l of p.usage) expect(r.stdout.includes(l.replaceAll("\\", "\\\\")) ? "" : `${p.branch} has no line: ${l}`).toBe("")
    }
  })
})

describe("the skills themselves", () => {
  const names = skillNames()

  it("are the expected set", () => {
    expect(names).toEqual([
      "winvm",
      "winvm-build-environment",
      "winvm-checkpoints",
      "winvm-ci-jobs",
      "winvm-first-run",
      "winvm-gui",
      "winvm-inside-windows",
      "winvm-machines",
    ])
  })

  it("have frontmatter every tool loads", () => {
    for (const n of names) {
      const fm = frontmatter(read(resolve(SKILLS, n, "SKILL.md")))
      expect(fm).not.toBeNull()
      if (fm === null) continue
      expect(fm["name"]).toBe(n)
      expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(n) && n.length <= 64).toBe(true)
      const d = fm["description"] ?? ""
      expect(d.length).toBeGreaterThan(50)
      expect(d.length).toBeLessThanOrEqual(1024)
      expect((fm["compatibility"] ?? "").length).toBeLessThanOrEqual(500)
      for (const k of Object.keys(fm)) expect(["name", "description", "compatibility", "license", "metadata", "allowed-tools"]).toContain(k)
    }
  })

  it("stay short, and link only to files that exist", () => {
    for (const n of names) {
      const text = read(resolve(SKILLS, n, "SKILL.md"))
      expect(text.split("\n").length).toBeLessThanOrEqual(160)
      for (const m of text.matchAll(/\]\(([^)#:]+)\)/g)) expect(existsSync(resolve(SKILLS, n, m[1] ?? ""))).toBe(true)
    }
  })

  it("keep guest scripts to Windows PowerShell 5.1: ASCII, stop on errors, documented exit codes", () => {
    const guest = skillFiles().filter((f) => f.includes("/templates/") && f.endsWith(".ps1"))
    expect(guest.length).toBeGreaterThanOrEqual(5)
    for (const f of guest) {
      const t = read(resolve(SKILLS, f))
      expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(t) ? "" : `${f} is not ASCII`).toBe("")
      expect(t).toContain("$ErrorActionPreference = 'Stop'")
      expect(t).toContain("Exit codes:")
      expect(t).not.toMatch(/\bpwsh\b/)
    }
  })

  it("are linked where the tools look in this repository", () => {
    for (const p of [".agents/skills", ".claude/skills"]) {
      const full = resolve(ROOT, p)
      expect(lstatSync(full).isSymbolicLink()).toBe(true)
      expect(readlinkSync(full)).toBe("../skills")
    }
  })
})

// ---------------------------------------------------------------------------
// Host helpers: sh and PowerShell in lockstep

const helpers = (): string[] => skillFiles().filter((f) => f.includes("/scripts/") && f.endsWith(".sh"))

interface Case {
  readonly name: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly exit: number
  readonly stdout?: string
  readonly log: readonly string[]
}

const SPEC = "C:\\specs\\env.yml"
const CASES: readonly Case[] = [
  {
    name: "applies and checkpoints",
    args: ["-i", "box", "--save", "box-ready", "--note", "two words", "--json", SPEC],
    env: {},
    exit: 0,
    stdout: '{"ok":true,"instance":"box","spec":"C:\\\\specs\\\\env.yml","checkpoint":"box-ready","stage":"done","exit":0}',
    log: [`run ${SPEC} -i box --keep`, "save -i box box-ready --note two words"],
  },
  {
    name: "a failing step takes no checkpoint",
    args: ["-i", "box", "--save", "box-ready", "--json", SPEC],
    env: { FAKE_RUN_EXIT: "5" },
    exit: 1,
    stdout: '{"ok":false,"instance":"box","spec":"C:\\\\specs\\\\env.yml","checkpoint":null,"stage":"apply","exit":5}',
    log: [`run ${SPEC} -i box --keep`],
  },
  {
    name: "a failing checkpoint",
    args: ["-i", "box", "--save", "box-ready", "--json", SPEC],
    env: { FAKE_SAVE_EXIT: "7" },
    exit: 3,
    stdout: '{"ok":false,"instance":"box","spec":"C:\\\\specs\\\\env.yml","checkpoint":null,"stage":"save","exit":7}',
    log: [`run ${SPEC} -i box --keep`, "save -i box box-ready"],
  },
  { name: "no checkpoint asked for", args: ["-i", "box", SPEC], env: {}, exit: 0, log: [`run ${SPEC} -i box --keep`] },
  { name: "no machine", args: [SPEC], env: {}, exit: 2, log: [] },
  { name: "an unknown flag", args: ["-i", "box", "--bogus", SPEC], env: {}, exit: 2, log: [] },
]

const unquote = (s: string): string => s.replaceAll('"', "").trim()

describe("host helpers", () => {
  it("come in pairs with the same usage and exit codes", () => {
    expect(helpers().length).toBeGreaterThan(0)
    for (const sh of helpers()) {
      const ps = sh.replace(/\.sh$/, ".ps1")
      expect(existsSync(resolve(SKILLS, ps))).toBe(true)
      // The usage line, and everything from "Exit codes" to the WINVM_TEMPLATES line.
      const head = (f: string): string => {
        const ls = read(resolve(SKILLS, f)).split("\n")
        const usage = ls.filter((l) => /^#\s+apply-env\.\w+ -i/.test(l))
        const from = ls.findIndex((l) => l.startsWith("# Exit codes"))
        const to = ls.findIndex((l) => l.startsWith("# WINVM_TEMPLATES"))
        return [...usage, ...ls.slice(from, to + 1)].join("\n").replace(/\.(sh|ps1)\b/g, ".x")
      }
      expect(head(ps)).toBe(head(sh))
    }
  })

  const fake = (): { dir: string; winvm: string; log: string } => {
    const dir = mkdtempSync(resolve(tmpdir(), "winvm-skills-"))
    const winvm = resolve(dir, "winvm")
    const log = resolve(dir, "log")
    writeFileSync(
      winvm,
      '#!/bin/sh\necho "$*" >> "$FAKE_LOG"\necho "fake winvm $1"\ncase "$1" in run) exit "${FAKE_RUN_EXIT:-0}";; save) exit "${FAKE_SAVE_EXIT:-0}";; esac\nexit 0\n',
    )
    chmodSync(winvm, 0o755)
    return { dir, winvm, log }
  }

  const check = (c: Case, got: { exit: number; stdout: string; log: string }): void => {
    expect(`${c.name}: exit ${String(got.exit)}`).toBe(`${c.name}: exit ${String(c.exit)}`)
    if (c.stdout !== undefined) expect(got.stdout.trim()).toBe(c.stdout)
    expect(got.log.split("\n").map(unquote).filter((l) => l !== "")).toEqual(c.log.map(unquote))
  }

  for (const sh of ["winvm-build-environment/scripts/apply-env.sh"]) {
    for (const c of CASES) {
      it(`sh: ${c.name}`, () => {
        const f = fake()
        try {
          const r = spawnSync("/bin/sh", [resolve(SKILLS, sh), ...c.args], {
            encoding: "utf8",
            env: { PATH: "/usr/bin:/bin", HOME: f.dir, WINVM: f.winvm, FAKE_LOG: f.log, ...c.env },
          })
          check(c, { exit: r.status ?? -1, stdout: r.stdout, log: existsSync(f.log) ? read(f.log) : "" })
          if (c.stdout === undefined && c.exit === 0) expect(r.stdout).toContain("fake winvm run")
        } finally {
          rmSync(f.dir, { recursive: true, force: true })
        }
      })
    }
  }

  const pwsh = spawnSync("/bin/sh", ["-c", "command -v pwsh"], { encoding: "utf8" }).stdout.trim()
  it.skipIf(pwsh === "")("ps1 under pwsh: the same cases", () => {
    for (const c of CASES) {
      const f = fake()
      try {
        const r = spawnSync(pwsh, ["-NoProfile", "-File", resolve(SKILLS, "winvm-build-environment/scripts/apply-env.ps1"), ...c.args], {
          encoding: "utf8",
          env: { PATH: `/usr/bin:/bin:${resolve(pwsh, "..")}`, HOME: f.dir, WINVM: f.winvm, FAKE_LOG: f.log, ...c.env },
        })
        check(c, { exit: r.status ?? -1, stdout: r.stdout, log: existsSync(f.log) ? read(f.log) : "" })
      } finally {
        rmSync(f.dir, { recursive: true, force: true })
      }
    }
  })

  const instance = process.env["WINVM_TEST_INSTANCE"] ?? ""
  it.skipIf(pwsh !== "" || instance === "")(
    "ps1 in the guest's Windows PowerShell 5.1: the same cases",
    () => {
      const winvm = (...a: string[]): { status: number; stdout: string; stderr: string } => {
        const r = spawnSync(process.execPath, [CLI, ...a, "-i", instance], { encoding: "utf8" })
        return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
      }
      const dir = mkdtempSync(resolve(tmpdir(), "winvm-skills-"))
      try {
        const fakeCmd = resolve(dir, "winvm.cmd")
        writeFileSync(
          fakeCmd,
          [
            "@echo off",
            "echo %*>>\"%FAKE_LOG%\"",
            "echo fake winvm %1",
            'if "%1"=="run" exit /b %FAKE_RUN_EXIT%',
            'if "%1"=="save" exit /b %FAKE_SAVE_EXIT%',
            "exit /b 0",
            "",
          ].join("\r\n"),
        )
        const psq = (s: string): string => `'${s.replaceAll("'", "''")}'`
        const driver = [
          "$ErrorActionPreference = 'Continue'",
          ...CASES.flatMap((c, i) => [
            `$env:FAKE_LOG = 'C:\\winvm\\t\\log${String(i)}'`,
            `Remove-Item -Force -ErrorAction SilentlyContinue $env:FAKE_LOG`,
            `$env:FAKE_RUN_EXIT = '${c.env["FAKE_RUN_EXIT"] ?? "0"}'`,
            `$env:FAKE_SAVE_EXIT = '${c.env["FAKE_SAVE_EXIT"] ?? "0"}'`,
            "$env:WINVM = 'C:\\winvm\\t\\winvm.cmd'",
            `$out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\winvm\\t\\apply-env.ps1 ${c.args.map(psq).join(" ")} 2>$null`,
            "$code = $LASTEXITCODE",
            "$log = if (Test-Path $env:FAKE_LOG) { (Get-Content $env:FAKE_LOG) -join '~' } else { '' }",
            `Write-Output ('CASE|${String(i)}|' + $code + '|' + (($out | Where-Object { $_ -like '{*' }) -join '') + '|' + $log)`,
          ]),
          "",
        ].join("\r\n")
        writeFileSync(resolve(dir, "driver.ps1"), driver)
        for (const [from, to] of [
          [resolve(SKILLS, "winvm-build-environment/scripts/apply-env.ps1"), "C:\\winvm\\t\\apply-env.ps1"],
          [fakeCmd, "C:\\winvm\\t\\winvm.cmd"],
        ] as const) {
          expect(winvm("put", from, to).status).toBe(0)
        }
        const r = winvm("script", resolve(dir, "driver.ps1"))
        expect(r.status).toBe(0)
        const rows = r.stdout.split(/\r?\n/).filter((l) => l.startsWith("CASE|"))
        expect(rows.length).toBe(CASES.length)
        for (const row of rows) {
          const [, idx, code, json, log] = row.split("|")
          const c = CASES[Number(idx)]
          if (c === undefined) continue
          check(c, { exit: Number(code), stdout: json ?? "", log: (log ?? "").split("~").join("\n") })
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    300_000,
  )
})

