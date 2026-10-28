/**
 * `winvm skills`: put winvm's agent skills (the repository's skills/ folder,
 * one folder per skill, each with a SKILL.md) where coding agents look for
 * them, as symlinks, so every tool reads the same files; and zip them for
 * Claude Desktop, which takes skills by upload.
 *
 * Where each tool reads user skills (checked against Claude Code 2.1.312,
 * Codex CLI 0.146.1 and Copilot CLI 1.0.91):
 *
 *   ~/.claude/skills    Claude Code (only; it does not read ~/.agents/skills)
 *   ~/.agents/skills    Codex and Copilot CLI
 *   ~/.codex/skills     Codex too, which does not de-duplicate: a skill in both
 *                       it and ~/.agents/skills is listed twice. Never used here.
 *   ~/.copilot/skills   Copilot too (it de-duplicates). Not needed.
 *
 * So --codex, --copilot and --agents all mean ~/.agents/skills, and --all is
 * that plus ~/.claude/skills. Only symlinks are ever made or removed; a real
 * folder of the same name is somebody else's and is left alone.
 */
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

import type { Args } from "./args"
import { PACKAGE_DIR } from "./paths"

const fail = (msg: string): number => {
  console.error(`::error::${msg}`)
  return 1
}

/** The skills shipped with this winvm: the repository's skills/, or the app's Resources/winvm/skills. */
export function skillsDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const own = env["WINVM_SKILLS_DIR"]
  if (own !== undefined && own !== "") return resolve(own)
  return resolve(PACKAGE_DIR, "..", "..", "skills")
}

/** Skill folder names: the folders holding a SKILL.md. */
export function listSkills(dir: string): readonly string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(resolve(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort()
}

export type Target = "claude-code" | "agents"

export interface TargetInfo {
  readonly target: Target
  readonly dir: string
  readonly readBy: readonly string[]
}

export function targetInfo(target: Target, home: string, env: Readonly<Record<string, string | undefined>> = process.env): TargetInfo {
  if (target === "claude-code") {
    const cfg = env["CLAUDE_CONFIG_DIR"]
    return { target, dir: resolve(cfg !== undefined && cfg !== "" ? cfg : resolve(home, ".claude"), "skills"), readBy: ["Claude Code"] }
  }
  return { target, dir: resolve(home, ".agents", "skills"), readBy: ["Codex", "GitHub Copilot CLI"] }
}

/** The targets the flags ask for; none means all. */
export function targetsOf(args: Args): readonly Target[] {
  const f = args.flags
  if (f.has("all")) return ["agents", "claude-code"]
  const out = new Set<Target>()
  if (f.has("agents") || f.has("codex") || f.has("copilot")) out.add("agents")
  if (f.has("claude-code")) out.add("claude-code")
  return out.size === 0 ? ["agents", "claude-code"] : [...out]
}

export type LinkState = "linked" | "missing" | "other-link" | "not-a-link"

export interface SkillState {
  readonly name: string
  readonly state: LinkState
  readonly path: string
  readonly points?: string
}

function stateOf(dir: string, name: string, source: string): SkillState {
  const path = resolve(dir, name)
  let st
  try {
    st = lstatSync(path)
  } catch {
    return { name, state: "missing", path }
  }
  if (!st.isSymbolicLink()) return { name, state: "not-a-link", path }
  const points = resolve(dirname(path), readlinkSync(path))
  return { name, state: points === resolve(source, name) ? "linked" : "other-link", path, points }
}

export interface Change {
  readonly name: string
  readonly path: string
  readonly action: "linked" | "relinked" | "already" | "skipped" | "removed" | "absent"
  readonly note?: string
}

/** Link every skill into `dir`. Replaces our own stale links (another winvm's, or dangling); never a real folder. */
export function install(source: string, dir: string, skills: readonly string[]): readonly Change[] {
  mkdirSync(dir, { recursive: true })
  return skills.map((name): Change => {
    const s = stateOf(dir, name, source)
    const target = resolve(source, name)
    if (s.state === "linked") return { name, path: s.path, action: "already" }
    if (s.state === "not-a-link") return { name, path: s.path, action: "skipped", note: "a folder that is not a link is there; left alone" }
    if (s.state === "other-link") rmSync(s.path, { force: true })
    symlinkSync(target, s.path, "dir")
    return { name, path: s.path, action: s.state === "other-link" ? "relinked" : "linked", ...(s.points === undefined ? {} : { note: `was ${s.points}` }) }
  })
}

/** Remove the links `install` made (or a stale link of the same name). */
export function uninstall(source: string, dir: string, skills: readonly string[]): readonly Change[] {
  return skills.map((name): Change => {
    const s = stateOf(dir, name, source)
    if (s.state === "missing") return { name, path: s.path, action: "absent" }
    if (s.state === "not-a-link") return { name, path: s.path, action: "skipped", note: "not a link; left alone" }
    rmSync(s.path, { force: true })
    return { name, path: s.path, action: "removed" }
  })
}

/** Is `name` a valid Agent Skills name (also what Claude Desktop's upload takes)? */
export const validName = (name: string): boolean => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64

/** One zip per skill, each holding the skill's folder at its root: Claude Desktop's upload format. */
export function pack(source: string, out: string, skills: readonly string[]): readonly string[] {
  mkdirSync(out, { recursive: true })
  return skills.map((name) => {
    const zip = resolve(out, `${name}.zip`)
    rmSync(zip, { force: true })
    const r = spawnSync("/usr/bin/zip", ["-q", "-r", "-X", zip, name, "-x", "*.DS_Store"], { cwd: source, encoding: "utf8" })
    if (r.status !== 0) throw new Error(`zip ${name}: ${(r.stderr || r.stdout || "").trim() || `exit ${String(r.status)}`}`)
    return zip
  })
}

const USAGE =
  "usage: winvm skills [status] [--json]\n" +
  "       winvm skills install   [--claude-code] [--codex] [--copilot] [--agents] [--all] [--json]\n" +
  "       winvm skills uninstall [--claude-code] [--codex] [--copilot] [--agents] [--all] [--json]\n" +
  "       winvm skills pack [--out DIR] [--json]\n" +
  "       winvm skills path"

export function skillsCmd(args: Args, home: string = homedir()): number {
  const sub = args.positional[0] ?? "status"
  const json = args.flags.has("json")
  const source = skillsDir()
  const skills = listSkills(source)
  if (sub === "path") {
    console.log(source)
    return existsSync(source) ? 0 : 1
  }
  if (skills.length === 0) return fail(`no skills in ${source} (WINVM_SKILLS_DIR names another folder)`)
  const bad = skills.filter((s) => !validName(s))
  if (bad.length > 0) return fail(`not valid skill names: ${bad.join(", ")}`)

  if (sub === "status") {
    const targets = (["agents", "claude-code"] as const).map((t) => {
      const info = targetInfo(t, home)
      return { ...info, skills: skills.map((s) => stateOf(info.dir, s, source)) }
    })
    if (json) {
      console.log(JSON.stringify({ source, skills, targets }, null, 2))
      return 0
    }
    console.log(`skills: ${source}`)
    for (const t of targets) {
      const linked = t.skills.filter((s) => s.state === "linked").length
      console.log(`  ${t.dir}  (${t.readBy.join(", ")}): ${String(linked)} of ${String(skills.length)} linked`)
      for (const s of t.skills.filter((x) => x.state !== "linked")) console.log(`    ${s.name}: ${s.state}${s.points === undefined ? "" : ` -> ${s.points}`}`)
    }
    return 0
  }

  if (sub === "install" || sub === "uninstall") {
    const results = targetsOf(args).map((t) => {
      const info = targetInfo(t, home)
      return { ...info, changes: sub === "install" ? install(source, info.dir, skills) : uninstall(source, info.dir, skills) }
    })
    if (json) console.log(JSON.stringify({ source, action: sub, targets: results }, null, 2))
    else {
      for (const r of results) {
        console.log(`${r.dir}  (${r.readBy.join(", ")})`)
        for (const c of r.changes) console.log(`  ${c.name}: ${c.action}${c.note === undefined ? "" : ` (${c.note})`}`)
      }
      if (sub === "install") console.log("New sessions of those tools pick them up. Claude Desktop takes uploads: `winvm skills pack`.")
    }
    return results.some((r) => r.changes.some((c) => c.action === "skipped")) ? 1 : 0
  }

  if (sub === "pack") {
    const out = resolve(args.flags.get("out") ?? "winvm-skills")
    let zips: readonly string[]
    try {
      zips = pack(source, out, skills)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    if (json) {
      console.log(JSON.stringify({ out, zips }, null, 2))
      return 0
    }
    console.log(`${String(zips.length)} skill zips in ${out}:`)
    for (const z of zips) console.log(`  ${z}`)
    console.log(
      "\nIn Claude Desktop: Customize > Skills > + > Upload a skill, once per zip (code execution must be on).\n" +
        "Desktop's skills run in Claude's sandbox, not on this Mac, so they reach Windows through the winvm\n" +
        "MCP server: `winvm mcp install claude-desktop -i NAME`.",
    )
    return 0
  }

  console.error(USAGE)
  return 2
}
