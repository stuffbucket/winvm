import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8")
const config = Bun.TOML.parse(read("mise.toml")) as {
  tasks: Record<string, { run: string | string[]; alias?: string }>
}
const instructions = read("AGENTS.md")
const skills = ["winvm-mise", "winvm-release"] as const

function localLinks(file: string): string[] {
  return [...read(file).matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1]!)
    .filter((link) => !/^[a-z]+:|^#/.test(link))
    .map((link) => resolve(ROOT, dirname(file), link.split("#")[0]!))
}

describe("development command contract", () => {
  test("exposes the six core tasks from the repo root", () => {
    for (const name of ["setup", "dev", "build", "test", "check", "doctor"]) {
      expect(config.tasks[name]).toBeDefined()
    }
  })

  test("quality tasks delegate to existing package scripts", () => {
    expect(config.tasks["check"]!.run).toBe("pnpm run check")
    expect(config.tasks["test"]!.run).toBe("pnpm run test")
    expect(config.tasks["typecheck"]!.run).toBe("pnpm run typecheck")
    expect(config.tasks["check:force"]!.run).toEqual([
      "pnpm exec turbo run typecheck test --force",
      "bun test scripts",
    ])
  })

  test("native build uses viewer tool scope without a release version or launch", () => {
    expect(config.tasks["build"]!.run).toBe("mise -C apps/viewer exec -- pnpm run app")
    expect(config.tasks["build"]!.alias).toBe("app:build")
    expect(config.tasks["dev"]!.run).toContain('open -n "$app"')
    expect(config.tasks["dev"]!.run).toContain('if [ ! -d "$app" ]')
    expect(config.tasks["dev"]!.run).not.toContain("/Applications/")
  })

  test("UI watch is distinct from launching and token generation is explicit", () => {
    expect(config.tasks["ui:build"]!.run).toBe("pnpm --filter @winvm/viewer run build:ui")
    expect(config.tasks["ui:watch"]!.run).toBe("pnpm --filter @winvm/viewer run dev:ui")
    expect(config.tasks["tokens:generate"]!.run).toBe("pnpm --filter @winvm/viewer run tokens")
  })
})

describe("mise skill discovery", () => {
  test("AGENTS points to namespaced skills and shared development recipes", () => {
    for (const name of skills) {
      expect(instructions).toContain(`.claude/skills/${name}/SKILL.md`)
      expect(read(`.claude/skills/${name}/SKILL.md`)).toMatch(
        new RegExp(`^---\\nname: ${name}\\n`),
      )
    }
    expect(instructions).toContain("docs/development.md")
  })

  test("one development skill discovers tasks and preserves operation boundaries", () => {
    const content = read(".claude/skills/winvm-mise/SKILL.md")
    expect(content).toContain("mise tasks ls --local")
    expect(content).toContain("mise tasks info <task>")
    expect(content).toContain("../../../docs/development.md")
    expect(content).toContain("### Run / dev")
    expect(content).toContain("### Build")
    expect(content).toContain("### Test / check")
    for (const name of ["winvm-run", "winvm-build", "winvm-check"]) {
      expect(existsSync(resolve(ROOT, `.claude/skills/${name}/SKILL.md`))).toBe(false)
      expect(instructions).not.toContain(name)
      expect(read("README.md")).not.toContain(name)
      expect(read("docs/development.md")).not.toContain(name)
    }
  })

  test("new documentation and skill links resolve", () => {
    const files = [
      "AGENTS.md",
      "docs/development.md",
      ...skills.filter((name) => name !== "winvm-release").map((name) => `.claude/skills/${name}/SKILL.md`),
    ]
    for (const file of files) {
      for (const link of localLinks(file)) expect(existsSync(link)).toBe(true)
    }
  })
})
