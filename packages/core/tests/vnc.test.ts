/**
 * VNC displays across homes: a display something else on the host listens on
 * is moved off at launch. Real sockets on loopback, no VM.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import type { InstanceMeta } from "../src/paths"
import { instanceDir, pathsFor } from "../src/paths"
import { displayFree, ensureFreeDisplay, vncPort, websocketPort } from "../src/vnc"

let state = ""
let previousHome: string | undefined
const held: Server[] = []

async function hold(port: number): Promise<void> {
  const s = createServer()
  await new Promise<void>((res) => s.listen(port, "127.0.0.1", () => res()))
  held.push(s)
}

/** A display (above the ones people use) whose two ports are free right now. */
async function someFreeDisplay(from: number): Promise<number> {
  for (let d = from; d < 100; d += 1) if (await displayFree(d)) return d
  throw new Error("no free display to test with")
}

function makeInstance(name: string, vnc: number): InstanceMeta {
  const meta: InstanceMeta = { image: "win11-arm64", vnc, created: new Date().toISOString() }
  mkdirSync(instanceDir(name), { recursive: true })
  writeFileSync(pathsFor(name).meta, JSON.stringify(meta))
  return meta
}

describe("VNC display in use on the host", () => {
  beforeEach(() => {
    previousHome = process.env["WINVM_HOME"]
    state = mkdtempSync(resolve(tmpdir(), "winvm-vnc-"))
    process.env["WINVM_HOME"] = state
    spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(async () => {
    await Promise.all(held.splice(0).map((s) => new Promise((res) => s.close(res))))
    if (previousHome === undefined) delete process.env["WINVM_HOME"]
    else process.env["WINVM_HOME"] = previousHome
    rmSync(state, { recursive: true, force: true })
    mock.restore()
  })

  it("counts a display as taken when either its VNC or its websocket port is", async () => {
    const d = await someFreeDisplay(60)
    expect(await displayFree(d)).toBe(true)
    await hold(websocketPort(d))
    expect(await displayFree(d)).toBe(false)
    const e = await someFreeDisplay(d + 1)
    await hold(vncPort(e))
    expect(await displayFree(e)).toBe(false)
  })

  it("keeps a free display as it is", async () => {
    const d = await someFreeDisplay(60)
    const meta = makeInstance("a", d)
    expect(await ensureFreeDisplay("a", pathsFor("a"), meta)).toEqual(meta)
  })

  it("moves off a busy display to a free one no other instance here claims, and records it", async () => {
    const busy = await someFreeDisplay(60)
    await hold(vncPort(busy))
    const meta = makeInstance("a", busy)
    // Every display below `busy` is claimed by another instance in this home,
    // so the only acceptable answers are free displays above it.
    for (let d = 1; d < busy; d += 1) makeInstance(`other-${String(d)}`, d)
    const moved = await ensureFreeDisplay("a", pathsFor("a"), meta)
    expect(moved.vnc).toBeGreaterThan(busy)
    expect(await displayFree(moved.vnc)).toBe(true)
    expect(moved.image).toBe(meta.image)
    expect((JSON.parse(readFileSync(pathsFor("a").meta, "utf8")) as InstanceMeta).vnc).toBe(moved.vnc)
  })
})
