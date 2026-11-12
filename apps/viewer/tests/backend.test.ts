/**
 * The backend funnel: how a sidecar failure from the app (a structured object
 * from the Rust side, or an older plain string) reaches the UI. Normal exits
 * come back as Output, as callers expect; a missing helper, one that would not
 * start, or one stopped at its deadline is a SidecarError with copy to act on.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  errorMessage,
  isSidecarError,
  normalizeSidecarFailure,
  type SidecarFailure,
  SidecarError,
  shareStart,
  winvm,
} from "../ui/src/backend"
import { copy } from "./copy"

const timeout: SidecarFailure = {
  kind: "timeout",
  operation: "status",
  message: "`winvm status` didn't answer in 45 seconds, so it was stopped.",
  stdout: "half\n",
  stderr: "",
  code: null,
  signal: null,
  timeoutMs: 45_000,
  detail: null,
}

let rejection: unknown = null
let answer: unknown = null
const asked: { cmd: string; args: unknown }[] = []

const hadWindow = "window" in globalThis
beforeEach(() => {
  rejection = null
  answer = null
  asked.length = 0
  const invoke = (cmd: string, args?: unknown): Promise<unknown> => {
    asked.push({ cmd, args })
    return rejection === null ? Promise.resolve(answer) : Promise.reject(rejection)
  }
  if (!hadWindow) Object.assign(globalThis, { window: {} })
  Object.assign(globalThis.window, { __TAURI__: { core: { invoke } } })
})
afterEach(() => {
  delete (globalThis.window as { __TAURI__?: unknown }).__TAURI__
  if (!hadWindow) delete (globalThis as { window?: unknown }).window
})

describe("normalizeSidecarFailure", () => {
  it("keeps a structured failure as it came", () => {
    expect(normalizeSidecarFailure(timeout, "status")).toEqual(timeout)
  })

  it("fills what an older or partial object leaves out", () => {
    expect(normalizeSidecarFailure({ kind: "missing", operation: "status", message: "gone" }, "status")).toEqual({
      kind: "missing",
      operation: "status",
      message: "gone",
      stdout: "",
      stderr: "",
      code: null,
      signal: null,
      timeoutMs: null,
      detail: null,
    })
  })

  it("reads a legacy string rejection: a file not found is a missing helper, anything else would not launch", () => {
    const missing = normalizeSidecarFailure("No such file or directory (os error 2)", "status")
    expect(missing.kind).toBe("missing")
    expect(missing.detail).toBe("No such file or directory (os error 2)")
    const other = normalizeSidecarFailure("not a winvm command this app runs: None", "status")
    expect(other.kind).toBe("launch")
    expect(other.message).toBe("not a winvm command this app runs: None")
  })

  it("never turns an object into [object Object]", () => {
    expect(normalizeSidecarFailure({ what: "?" }, "status").message).not.toContain("[object Object]")
    expect(normalizeSidecarFailure({ kind: "bogus", message: "odd" }, "status")).toMatchObject({ kind: "launch", message: "odd" })
  })
})

describe("winvm()", () => {
  it("resolves a normal nonzero exit as Output, as before, with the failure attached", async () => {
    rejection = { kind: "exit", operation: "pause", message: "no", stdout: "", stderr: "::error::no\n", code: 3, signal: null, timeoutMs: null, detail: null }
    const out = await winvm("pause", "-i", "demo")
    expect(out.code).toBe(3)
    expect(out.stdout).toBe("")
    expect(out.stderr).toBe("::error::no\n")
    expect(out.failure?.kind).toBe("exit")
  })

  it("gives a signalled exit code -1, as the old Output did", async () => {
    rejection = { kind: "exit", operation: "status", message: "signal 9", stdout: "", stderr: "", code: null, signal: 9, timeoutMs: null, detail: null }
    const out = await winvm("status", "--json")
    expect(out.code).toBe(-1)
    expect(out.failure?.signal).toBe(9)
  })

  it("passes a clean answer through", async () => {
    answer = { code: 0, stdout: "{}\n", stderr: "" }
    expect(await winvm("status", "--json")).toEqual({ code: 0, stdout: "{}\n", stderr: "" })
  })

  it("throws a SidecarError with actionable copy for a timeout", async () => {
    rejection = timeout
    const e: unknown = await winvm("status", "--json").catch((x: unknown) => x)
    expect(isSidecarError(e)).toBe(true)
    expect(e instanceof SidecarError && e.failure.kind).toBe("timeout")
    expect(errorMessage(e)).toBe(copy("sidecar.timeout", { operation: "status", seconds: "45" }))
  })

  it("throws a SidecarError for a missing helper", async () => {
    rejection = { kind: "missing", operation: "status", message: "gone", stdout: "", stderr: "", code: null, signal: null, timeoutMs: null, detail: "os error 2" }
    const e: unknown = await winvm("status", "--json").catch((x: unknown) => x)
    expect(isSidecarError(e)).toBe(true)
    expect(errorMessage(e)).toBe(copy("sidecar.missing"))
  })

  it("throws a SidecarError for an older string rejection, with the string kept", async () => {
    rejection = "Permission denied (os error 13)"
    const e: unknown = await winvm("doctor", "--json").catch((x: unknown) => x)
    expect(isSidecarError(e)).toBe(true)
    expect(errorMessage(e)).toBe(copy("sidecar.launch", { operation: "doctor", detail: "Permission denied (os error 13)" }))
  })
})

describe("shareStart()", () => {
  it("resolves an early exit as Output and throws a timed-out handshake", async () => {
    rejection = { kind: "exit", operation: "cua serve", message: "no", stdout: "", stderr: "::error::busy\n", code: 1, signal: null, timeoutMs: null, detail: null }
    expect((await shareStart("demo")).code).toBe(1)
    rejection = { ...timeout, operation: "cua serve", timeoutMs: 60_000 }
    const e: unknown = await shareStart("demo").catch((x: unknown) => x)
    expect(isSidecarError(e)).toBe(true)
    expect(errorMessage(e)).toBe(copy("sidecar.timeout", { operation: "cua serve", seconds: "60" }))
  })
})

describe("errorMessage", () => {
  it("reads errors, strings and structured failures alike", () => {
    expect(errorMessage(new Error("plain"))).toBe("plain")
    expect(errorMessage("text")).toBe("text")
    expect(errorMessage(timeout)).toBe(copy("sidecar.timeout", { operation: "status", seconds: "45" }))
  })
})
