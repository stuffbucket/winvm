/**
 * Entering and leaving Checkpoints is a change of mode in this window: a fade
 * and a hair of scale in place, never a flight or a slide, and a cut under
 * reduced motion (docs/design/motion.md). The animation is CSS on the
 * surface's data-phase, so this checks the stylesheet's contract and that the
 * view does not start a camera flight to enter or leave.
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const read = (rel: string): string => readFileSync(resolve(import.meta.dir, rel), "utf8")
const CSS = read("../ui/src/styles/checkpoints.css").replace(/\/\*[\s\S]*?\*\//g, "")
const SOURCE = read("../ui/src/features/checkpoints/CheckpointCanvas.tsx")

const body = (selector: string): string => {
  const found = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => (m[1] ?? "").replace(/\s+/g, " ").trim() === selector).map((m) => m[2] ?? "")
  if (found.length === 0) throw new Error(`no rule for ${selector}`)
  return found.join("\n")
}

describe("entering and leaving Checkpoints", () => {
  it("fades the whole view, and only settles it by a hair: no slide, no sheet", () => {
    const hidden = body('.checkpoints[data-phase="entering"],\n.checkpoints[data-phase="leaving"]'.replace("\n", " "))
    expect(hidden).toMatch(/opacity:\s*0/)
    expect(hidden).toMatch(/transform:\s*scale\(0\.99\)/)
    expect(hidden + body(".checkpoints")).not.toMatch(/translate|rotate|animation/i)
    expect(body(".checkpoints")).toMatch(/transition:[\s\S]*opacity 200ms ease-out/)
  })

  it("does not fly the camera to enter or to leave", () => {
    const enter = SOURCE.slice(SOURCE.indexOf("// In: drawn in place"), SOURCE.indexOf("// Out: fades away"))
    const out = SOURCE.slice(SOURCE.indexOf("// Out: fades away"), SOURCE.indexOf("const closeRequest"))
    expect(enter).toContain("setCamera(overview())")
    expect(enter).not.toContain("flyCamera")
    expect(out).not.toContain("flyCamera")
    expect(out).toContain("surfaceFadeMs()")
  })

  it("is a cut under reduced motion: the stylesheet zeroes durations, and leaving does not wait", () => {
    const styles = read("../ui/src/styles/styles.css")
    expect(styles).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{\s*transition-duration: 0\.001ms !important/)
    expect(SOURCE).toMatch(/prefers-reduced-motion: reduce[\s\S]{0,80}\? 0 : SURFACE_FADE_MS/)
  })
})
