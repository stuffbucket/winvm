/**
 * Native labels bypass the web UI's translations. Check their Rust literals in
 * the no-Rust test suite: these once contained double-encoded UTF-8 punctuation.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(resolve(import.meta.dir, "../src-tauri/src/lib.rs"), "utf8")
const labels = new Map(
  [...source.matchAll(/MenuItem::with_id\(\s*app,\s*"([^"]+)",\s*"([^"]+)"/g)].map((match) => [match[1], match[2]]),
)

describe("native text encoding", () => {
  test.each([
    ["rename-window", "Rename Window…"],
    ["checkpoints", "Checkpoints…"],
    ["check-updates", "Check for Updates…"],
    ["install-cli", "Install Command Line Tool…"],
  ])("%s ends with a Unicode ellipsis, not UTF-8 decoded as Latin-1", (id, expected) => {
    expect(labels.get(id)).toBe(expected)
  })

  test("the Files window title has a Unicode em dash", () => {
    expect(source).toContain('.title(format!("Files in Windows — {shown}"))')
  })

  test("native menu labels have no leading padding or corrupted code points", () => {
    expect(labels.size).toBeGreaterThan(0)
    for (const label of labels.values()) {
      expect(label).toBeDefined()
      expect(label).toBe(label?.trim())
      expect(label).not.toMatch(/[\u0080-\u009f�]/u)
    }
  })

  test("app-management commands share About's icon gutter before the original separator", () => {
    // A separate iconless section pulls Install left on macOS 26. Insert both
    // commands immediately after About, without adding another separator.
    expect(source).toMatch(/app_menu\.insert\(&install, 1\)\?;\s*app_menu\.insert\(&updates, 1\)\?;/)
    expect(source).not.toMatch(/app_menu\.insert_items/)
  })
})
