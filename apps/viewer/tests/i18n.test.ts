import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

import en from "../ui/src/i18n/en.json"

const SRC = resolve(import.meta.dir, "..", "ui", "src")

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

const catalog = new Set(Object.keys(en))

// Keys built at run time, from the values they are built from.
const built = [
  ...["loading", "starting", "running", "paused", "stopped", "stowed", "missing"].map((s) => `state.${s}`),
  ...["start", "stop", "reboot", "pause", "resume", "kill", "setup"].map((v) => `busy.${v}`),
  ...["start", "stop", "reboot", "pause", "resume", "kill", "setup", "open"].map((v) => `error.${v}`),
  ...["stop", "reboot", "kill"].flatMap((v) => [`confirm.${v}.title`, `confirm.${v}.body`]),
  ...["stopped", "stowed", "missing"].flatMap((p) => [`overview.${p}.title`, `overview.${p}.body`]),
  ...["connecting", "lost", "refused"].map((v) => `screen.${v}`),
  ...["step.disk", "step.machine", "step.windows"],
  ...["fact.image", "fact.cpus", "fact.memory", "fact.changes", "fact.saves"],
  ...["detail.windows", "detail.uptime", "detail.hardware", "detail.image", "detail.screen", "detail.disk", "detail.saves"],
  ...["ability.exec", "ability.files", "ability.saves", "ability.agent"],
]

describe("the en catalog", () => {
  it("has every key the UI names literally", () => {
    const used = sources(SRC).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1] ?? ""))
    expect(used.length).toBeGreaterThan(20)
    expect(used.filter((k) => !catalog.has(k))).toEqual([])
  })

  it("has every key the UI builds", () => {
    expect(built.filter((k) => !catalog.has(k))).toEqual([])
  })
})
