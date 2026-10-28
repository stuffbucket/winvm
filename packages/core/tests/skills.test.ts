/**
 * `winvm skills` and `winvm script`, without a VM: links made and removed in a
 * temporary home, never the real one.
 */
import { describe, expect, it } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseArgs } from "../src/args"
import { scriptArgv } from "../src/agentcmds"
import { install, listSkills, pack, skillsDir, targetInfo, targetsOf, uninstall, validName } from "../src/skillcmds"

function fixture(): { root: string; source: string; home: string } {
  const root = mkdtempSync(resolve(tmpdir(), "winvm-skills-"))
  const source = resolve(root, "skills")
  for (const n of ["winvm", "winvm-gui"]) {
    mkdirSync(resolve(source, n), { recursive: true })
    writeFileSync(resolve(source, n, "SKILL.md"), `---\nname: ${n}\ndescription: test\n---\n`)
  }
  mkdirSync(resolve(source, "not-a-skill"))
  return { root, source, home: resolve(root, "home") }
}

describe("winvm skills", () => {
  it("ships the repository's skills folder", () => {
    expect(skillsDir({})).toBe(resolve(import.meta.dir, "..", "..", "..", "skills"))
    expect(skillsDir({ WINVM_SKILLS_DIR: "/x/skills" })).toBe("/x/skills")
    expect(listSkills(skillsDir({}))).toContain("winvm")
  })

  it("links into ~/.agents/skills for Codex and Copilot, ~/.claude/skills for Claude Code", () => {
    expect(targetsOf(parseArgs([]))).toEqual(["agents", "claude-code"])
    expect(targetsOf(parseArgs(["--all"]))).toEqual(["agents", "claude-code"])
    expect(targetsOf(parseArgs(["--codex", "--copilot"]))).toEqual(["agents"])
    expect(targetsOf(parseArgs(["--claude-code"]))).toEqual(["claude-code"])
    expect(targetInfo("agents", "/h", {}).dir).toBe("/h/.agents/skills")
    expect(targetInfo("claude-code", "/h", {}).dir).toBe("/h/.claude/skills")
    expect(targetInfo("claude-code", "/h", { CLAUDE_CONFIG_DIR: "/c" }).dir).toBe("/c/skills")
  })

  it("installs links, idempotently, replaces stale links, and leaves real folders alone", () => {
    const f = fixture()
    try {
      const dir = resolve(f.home, ".agents", "skills")
      const skills = listSkills(f.source)
      expect(skills).toEqual(["winvm", "winvm-gui"])
      expect(install(f.source, dir, skills).map((c) => c.action)).toEqual(["linked", "linked"])
      expect(readlinkSync(resolve(dir, "winvm"))).toBe(resolve(f.source, "winvm"))
      expect(install(f.source, dir, skills).map((c) => c.action)).toEqual(["already", "already"])

      rmSync(resolve(dir, "winvm"))
      symlinkSync("/nowhere", resolve(dir, "winvm"))
      rmSync(resolve(dir, "winvm-gui"))
      mkdirSync(resolve(dir, "winvm-gui"))
      expect(install(f.source, dir, skills).map((c) => c.action)).toEqual(["relinked", "skipped"])

      expect(uninstall(f.source, dir, skills).map((c) => c.action)).toEqual(["removed", "skipped"])
      expect(existsSync(resolve(dir, "winvm-gui"))).toBe(true)
      expect(() => lstatSync(resolve(dir, "winvm"))).toThrow()
      expect(uninstall(f.source, dir, ["winvm"]).map((c) => c.action)).toEqual(["absent"])
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it("packs one zip per skill with the skill's folder at its root", () => {
    const f = fixture()
    try {
      const zips = pack(f.source, resolve(f.root, "out"), ["winvm", "winvm-gui"])
      expect(zips.map((z) => z.split("/").at(-1))).toEqual(["winvm.zip", "winvm-gui.zip"])
      const r = Bun.spawnSync(["/usr/bin/unzip", "-Z1", zips[0] ?? ""])
      expect(r.stdout.toString().trim().split("\n").sort()).toEqual(["winvm/", "winvm/SKILL.md"])
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it("takes only names every tool and Claude Desktop accept", () => {
    expect(validName("winvm-gui")).toBe(true)
    for (const bad of ["Winvm", "winvm_gui", "-winvm", "winvm-", "a".repeat(65)]) expect(validName(bad)).toBe(false)
  })
})

describe("winvm script", () => {
  it("runs .ps1 in Windows PowerShell 5.1 and .cmd/.bat in cmd", () => {
    expect(scriptArgv("C:\\winvm\\scripts\\a.ps1", ["-Name", "x"])).toEqual([
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\winvm\\scripts\\a.ps1",
      "-Name",
      "x",
    ])
    expect(scriptArgv("C:\\winvm\\scripts\\b.CMD", [])).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/c", "C:\\winvm\\scripts\\b.CMD"])
    expect(scriptArgv("C:\\winvm\\scripts\\c.sh", [])).toBeNull()
  })
})
