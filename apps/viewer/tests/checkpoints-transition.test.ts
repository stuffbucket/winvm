/** Full-display Checkpoints: centered canvas easing, native presentation, and a motion-free cut. */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { PresentationQueue } from "../ui/src/features/checkpoints/presentation"

const read = (rel: string): string => readFileSync(resolve(import.meta.dir, rel), "utf8")
const CSS = read("../ui/src/styles/checkpoints.css").replace(/\/\*[\s\S]*?\*\//g, "")
const SOURCE = read("../ui/src/features/checkpoints/CheckpointCanvas.tsx")
const APP = read("../ui/src/App.tsx")
const NATIVE = read("../src-tauri/src/lib.rs")

const body = (selector: string): string => {
  const found = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => (m[1] ?? "").replace(/\s+/g, " ").trim() === selector).map((m) => m[2] ?? "")
  if (found.length === 0) throw new Error(`no rule for ${selector}`)
  return found.join("\n")
}

describe("entering and leaving Checkpoints", () => {
  it("fades, blurs and scales the canvas, not the input-shielding surface", () => {
    const hidden = body('.checkpoints[data-phase="entering"] .checkpoints__canvas, .checkpoints[data-phase="leaving"] .checkpoints__canvas')
    expect(hidden).toMatch(/opacity:\s*0/)
    expect(hidden).toMatch(/transform:\s*scale\(0\.8\)/)
    expect(hidden).toMatch(/filter:\s*blur\(var\(--space-1\)\)/)
    expect(body(".checkpoints__canvas")).toMatch(/transform-origin:\s*center/)
    expect(body('.checkpoints[data-phase="entering"][data-ready="true"] .checkpoints__canvas')).toContain("checkpoint-enter 200ms ease-out")
    expect(body(".checkpoints__canvas")).toContain("filter: none")
    expect(body(".checkpoints__canvas")).toContain("transform: none")
    expect(body(".checkpoints")).toContain("background: var(--surface-base)")
    expect(body(".checkpoints")).not.toMatch(/transform|opacity/)
    expect(SOURCE).not.toContain('className="checkpoints__backdrop-screen"')
  })

  it("does not fly the camera to enter or leave, and restores native presentation before closing", () => {
    const enter = SOURCE.slice(SOURCE.indexOf("const entered = useRef(false)"), SOURCE.indexOf("const leavingNow = useRef(false)"))
    const out = SOURCE.slice(SOURCE.indexOf("const leavingNow = useRef(false)"), SOURCE.indexOf("const closeRequest"))
    expect(enter).toContain("setCamera(overview())")
    expect(enter).not.toContain("flyCamera")
    expect(enter).toContain("camera === cameraNow()")
    expect(out).not.toContain("flyCamera")
    expect(out).toContain('motion?.addEventListener("change", preferenceChanged)')
    expect(SOURCE).toContain('else if (phase === "leaving") finishLeaving.current?.()')
    expect(out).toContain("surfaceFadeMs()")
    expect(out.indexOf("await checkpointPresentation.set(false)")).toBeLessThan(out.indexOf("props.current.onClosed()"))
    expect(NATIVE).toContain("window.set_simple_fullscreen(true)")
    expect(NATIVE).toContain("window.set_simple_fullscreen(false)")
    expect(NATIVE).toContain("!window.is_fullscreen()")
    expect(APP).toContain("ready={guestReady && !checkpoints}")
    expect(APP).toContain("forwardInput={input.forward && !settingsOpen && !checkpoints}")
  })

  it("is a cut under reduced motion: no scale, blur, transition or dismissal wait", () => {
    expect(CSS).toContain("@media (prefers-reduced-motion: reduce)")
    const reduced = body(".checkpoints .checkpoints__canvas, .checkpoints .checkpoints__backdrop")
    expect(reduced).toContain("transition: none")
    expect(reduced).toContain("transform: none")
    expect(reduced).toContain("filter: none")
    expect(SOURCE).toMatch(/prefers-reduced-motion: reduce[\s\S]{0,80}\? 0 : SURFACE_FADE_MS/)
  })
})

describe("native presentation ordering", () => {
  it("serializes enter, effect cleanup, replay and a fast dismissal", async () => {
    const events: boolean[] = []
    let finish: (() => void) | undefined
    const first = new Promise<void>((resolve) => { finish = resolve })
    const queue = new PresentationQueue(async (enabled) => {
      events.push(enabled)
      if (events.length === 1) await first
    })
    const entered = queue.set(true)
    const cleaned = queue.set(false)
    const replayed = queue.set(true)
    const dismissed = queue.set(false)
    await Promise.resolve(); await Promise.resolve()
    expect(events).toEqual([true])
    finish?.()
    await Promise.all([entered, cleaned, replayed, dismissed])
    expect(events).toEqual([true, false, true, false])
  })

  it("still restores after an enter failure, and allows retry after an exit failure", async () => {
    const events: boolean[] = []
    const queue = new PresentationQueue(async (enabled) => {
      events.push(enabled)
      if (events.length <= 2) throw new Error("window unavailable")
    })
    await expect(queue.set(true)).rejects.toThrow("window unavailable")
    await expect(queue.set(false)).rejects.toThrow("window unavailable")
    await queue.set(false)
    expect(events).toEqual([true, false, false])
  })
})
