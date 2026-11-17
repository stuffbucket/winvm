import { afterAll, afterEach, describe, expect, it, jest } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { JSX } from "react"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { App } = await import("../ui/src/App")

type Root = ReturnType<typeof createRoot>
let root: Root | null = null

class QuietSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  binaryType = "arraybuffer"
  protocol = "binary"
  readyState = 0
  onopen: unknown = null
  onclose: unknown = null
  onerror: unknown = null
  onmessage: unknown = null
  send(): void {}
  close(): void {
    this.readyState = 3
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}
Object.assign(globalThis, { WebSocket: QuietSocket })

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  delete (window as { __TAURI__?: unknown }).__TAURI__
  jest.useRealTimers()
})
afterAll(() => GlobalRegistrator.unregister())

function render(node: JSX.Element): void {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(node))
}

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

const SPAWNING = new Set(["winvm", "close_run", "share_start"])

const stopped = (name: string): Record<string, unknown> => ({
  name,
  title: null,
  operation: null,
  state: "stopped",
  vmStatus: null,
  image: "win11-arm64",
  pid: null,
  uptimeSeconds: null,
  cpus: 4,
  memoryMiB: 4096,
  screen: null,
  overlayBytes: 1,
  guest: null,
  saves: { count: 0, bytes: 0 },
  notes: [],
})

const missing = (name: string): Record<string, unknown> => ({
  ...stopped(name),
  state: "missing",
  image: null,
})

interface Machine {
  readonly spawns: string[][]
  emit(payload: unknown): void
}

function idleMachine(names: readonly string[]): Machine {
  const spawns: string[][] = []
  const listeners = new Map<string, ((e: { payload: unknown }) => void)[]>()
  const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
    const args = a?.args ?? []
    if (SPAWNING.has(cmd)) spawns.push([cmd, ...args])
    if (cmd === "events_state")
      return Promise.resolve({ up: true, restarts: 0 })
    if (cmd === "close_state")
      return Promise.resolve({
        state: "idle",
        machine: null,
        command: null,
        last: null,
        resolved: [],
        session: null,
      })
    if (cmd !== "winvm") return Promise.resolve(null)
    const ok = (o: unknown, code = 0): unknown => ({
      code,
      stdout: JSON.stringify(o),
      stderr: "",
    })
    if (args[0] === "status") {
      const i = args.indexOf("-i")
      if (i < 0) return Promise.resolve(ok({ instances: names.map(stopped) }))
      const n = args[i + 1] ?? "default"
      return Promise.resolve(
        names.includes(n) ? ok(stopped(n)) : ok(missing(n), 1),
      )
    }
    if (args[0] === "doctor")
      return Promise.resolve(ok({ ready: true, checks: [], timeMachine: "" }))
    return Promise.resolve({ code: 0, stdout: "", stderr: "" })
  }
  const listen = (
    name: string,
    cb: (e: { payload: unknown }) => void,
  ): Promise<() => void> => {
    listeners.set(name, [...(listeners.get(name) ?? []), cb])
    return Promise.resolve(() => {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((x) => x !== cb),
      )
    })
  }
  Object.assign(window, {
    __TAURI__: {
      core: { invoke },
      event: { listen, emit: () => Promise.resolve() },
    },
  })
  return {
    spawns,
    emit: (payload) => {
      for (const cb of listeners.get("winvm-event") ?? []) cb({ payload })
    },
  }
}

async function spawnsPerMinute(
  names: readonly string[],
  minutes: number,
): Promise<{ startup: number; perMinute: number; verbs: string[] }> {
  jest.useFakeTimers()
  const machine = idleMachine(names)
  render(<App />)
  await flush()
  machine.emit({ type: "hello", cursor: "c0", instances: names })
  for (let s = 0; s < 60; s += 1) {
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    await flush()
  }
  const startup = machine.spawns.length
  for (let s = 0; s < minutes * 60; s += 1) {
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    await flush()
  }
  const steady = machine.spawns.slice(startup)
  return {
    startup,
    perMinute: steady.length / minutes,
    verbs: [...new Set(steady.map((s) => s.slice(0, 3).join(" ")))],
  }
}

describe("CLI processes the viewer spawns on an idle machine with no VM running", () => {
  it("with no machines at all, reads once a minute and the list every ten minutes once the stream is up", async () => {
    const got = await spawnsPerMinute([], 10)
    console.log(`no machines: ${JSON.stringify(got)}`)
    expect(got.perMinute).toBeLessThanOrEqual(1.1)
    expect(got.verbs).toEqual(["winvm status --json"])
  }, 60_000)

  it("with one stopped machine, reads once a minute and the list every ten minutes once the stream is up", async () => {
    const got = await spawnsPerMinute(["demo"], 10)
    console.log(`one stopped machine: ${JSON.stringify(got)}`)
    expect(got.perMinute).toBeLessThanOrEqual(1.1)
    expect(got.verbs).toEqual(["winvm status --json"])
  }, 60_000)
})
