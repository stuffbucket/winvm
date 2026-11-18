import { afterAll, afterEach, describe, expect, it, jest } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { JSX } from "react"

import { rejectLikeTauri } from "./reject-like-tauri"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { useWinvm } = await import("../ui/src/features/winvm/useWinvm")
const { useUsage } = await import("../ui/src/features/usage/useUsage")
const { Resources } = await import("../ui/src/features/usage/Resources")
const en = (await import("../ui/src/i18n/en.json")).default as Record<
  string,
  string
>
const { copy } = await import("./copy")

type Root = ReturnType<typeof createRoot>
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  delete (window as { __TAURI__?: unknown }).__TAURI__
  jest.useRealTimers()
})
afterAll(() => GlobalRegistrator.unregister())

function render(node: JSX.Element): HTMLElement {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(node))
  return host
}

type Winvm = ReturnType<typeof useWinvm>

interface Slot<T> {
  current: T | null
}

function WinvmProbe({ slot }: { readonly slot: Slot<Winvm> }): null {
  slot.current = useWinvm()
  return null
}

function WinvmAlertProbe({
  slot,
}: {
  readonly slot: Slot<Winvm>
}): JSX.Element {
  const w = useWinvm()
  slot.current = w
  return <p role="alert">{w.statusError}</p>
}

function UsageProbe({
  instance,
  read,
}: {
  readonly instance: string | null
  readonly read: (pid: number, instance: string | null) => Promise<unknown>
}): null {
  useUsage(4242, instance, 4, 4096, read)
  return null
}

type UsageView = ReturnType<typeof useUsage>

function UsageViewProbe({
  pid,
  read,
  slot,
}: {
  readonly pid: number | null
  readonly read: (pid: number, instance: string | null) => Promise<unknown>
  readonly slot: Slot<UsageView>
}): null {
  slot.current = useUsage(pid, "demo", 4, 4096, read)
  return null
}

function latest(slot: Slot<Winvm>): () => Winvm {
  return () => {
    if (slot.current === null) throw new Error("useWinvm has not rendered")
    return slot.current
  }
}

function renderWinvm(): () => Winvm {
  const slot: Slot<Winvm> = { current: null }
  render(<WinvmProbe slot={slot} />)
  return latest(slot)
}

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

interface Output {
  code: number
  stdout: string
  stderr: string
}

interface Call {
  readonly args: readonly string[]
  readonly resolve: (o: Output) => void
  readonly reject: (failure: unknown) => void
  done: boolean
}

function fakeTauri(open?: () => Output): {
  opens: string[][]
  calls: Call[]
  reads(): Call[]
  verb(v: string): Call
} {
  const calls: Call[] = []
  const opens: string[][] = []
  const held = new Set([
    "status",
    "pause",
    "resume",
    "sleep",
    "wake",
    "stop",
    "stow",
    "setup",
  ])
  const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
    const args = a?.args ?? []
    if (cmd !== "winvm") return Promise.resolve(null)
    if (args[0] === "open" && open !== undefined) {
      opens.push(args)
      return Promise.resolve(open())
    }
    if (!held.has(args[0] ?? ""))
      return Promise.resolve({ code: 1, stdout: "", stderr: "" })
    return new Promise<Output>((resolve) => {
      const call: Call = {
        args,
        done: false,
        resolve: (o) => {
          call.done = true
          resolve(o)
        },
        reject: (failure) => {
          call.done = true
          resolve(rejectLikeTauri(failure))
        },
      }
      calls.push(call)
    })
  }
  Object.assign(window, { __TAURI__: { core: { invoke } } })
  return {
    opens,
    calls,
    reads: () =>
      calls.filter((c) => c.args[0] === "status" && c.args.includes("-i")),
    verb: (v) => {
      const c = calls.find((x) => x.args[0] === v && !x.done)
      if (c === undefined) throw new Error(`no ${v} pending`)
      return c
    },
  }
}

const status = (
  state: string,
  agent: "ok" | "silent" | null = "ok",
  operation: string | null = null,
  name = "demo",
): Output => ({
  code: 0,
  stderr: "",
  stdout: JSON.stringify({
    name,
    title: null,
    operation:
      operation === null
        ? null
        : { operation, pid: 777, startedAt: "2026-11-12T10:00:00.000Z" },
    state,
    vmStatus: state === "running" ? "running" : "paused",
    image: "win11-arm64",
    pid: 4242,
    uptimeSeconds: 60,
    cpus: 4,
    memoryMiB: 4096,
    screen: "virtio-gpu 1280x800",
    overlayBytes: 1,
    guest:
      agent === null ? null : { agent, agentVersion: "9", os: "Windows 11" },
    saves: { count: 0, bytes: 0 },
    notes: [],
  }),
})

describe("pausing in the window", () => {
  it("shows paused the moment Pause returns, and a status read that raced it never puts running back", async () => {
    const tauri = fakeTauri()
    const w = renderWinvm()
    await flush()
    const list = tauri.calls.find(
      (c) => c.args[0] === "status" && !c.args.includes("-i"),
    )
    list?.resolve({
      ...status("running"),
      stdout: JSON.stringify({
        instances: [JSON.parse(status("running").stdout)],
      }),
    })
    await flush()
    tauri.reads()[0]?.resolve(status("running"))
    await flush()
    expect(w().phase).toBe("running")

    let acted: Promise<unknown> | null = null
    act(() => {
      acted = w().act("pause")
    })
    await flush()
    expect(w().busy).toBe("pause")
    const raced = tauri.reads().filter((c) => !c.done)
    expect(raced.length).toBeGreaterThan(0)

    tauri
      .verb("pause")
      .resolve({ code: 0, stdout: 'paused "demo"\n', stderr: "" })
    await flush()
    expect(w().busy).toBeNull()
    expect(w().phase).toBe("paused")

    for (const c of raced) c.resolve(status("running"))
    await flush()
    expect(w().phase).toBe("paused")

    const after = tauri.reads().filter((c) => !c.done)
    expect(after.length).toBeGreaterThanOrEqual(2)
    after.at(-1)?.resolve(status("paused", null))
    await flush()
    expect(w().phase).toBe("paused")
    after[0]?.resolve(status("running"))
    await flush()
    expect(w().phase).toBe("paused")
    await act(async () => {
      await acted
    })
  })

  it("shows running the moment Wake returns, and asleep until then", async () => {
    const tauri = fakeTauri()
    const w = renderWinvm()
    await flush()
    tauri.calls
      .find((c) => c.args[0] === "status" && !c.args.includes("-i"))
      ?.resolve({
        ...status("asleep", null),
        stdout: JSON.stringify({
          instances: [JSON.parse(status("asleep", null).stdout)],
        }),
      })
    await flush()
    tauri.reads()[0]?.resolve(status("asleep", null))
    await flush()
    expect(w().phase).toBe("asleep")

    act(() => {
      void w().act("wake")
    })
    await flush()
    const raced = tauri.reads().filter((c) => !c.done)
    tauri.verb("wake").resolve({ code: 0, stdout: "", stderr: "" })
    await flush()
    expect(w().phase).toBe("running")
    for (const c of raced) c.resolve(status("asleep", null))
    await flush()
    expect(w().phase).toBe("running")
  })

  it("keeps the old phase when Pause fails", async () => {
    const tauri = fakeTauri()
    const w = renderWinvm()
    await flush()
    tauri.calls
      .find((c) => c.args[0] === "status" && !c.args.includes("-i"))
      ?.resolve({
        ...status("running"),
        stdout: JSON.stringify({
          instances: [JSON.parse(status("running").stdout)],
        }),
      })
    await flush()
    tauri.reads()[0]?.resolve(status("running"))
    await flush()
    act(() => {
      void w().act("pause")
    })
    await flush()
    tauri.verb("pause").resolve({ code: 1, stdout: "", stderr: "::error::no" })
    await flush()
    expect(w().phase).toBe("running")
    expect(w().failure?.verb).toBe("pause")
  })
})

const sidecarFailure = (
  kind: "missing" | "timeout",
  operation: string,
): Record<string, unknown> => ({
  kind,
  operation,
  message: `raw ${kind} text from Rust`,
  stdout: "",
  stderr: "",
  code: null,
  signal: null,
  timeoutMs: kind === "timeout" ? 45_000 : null,
  detail: kind === "missing" ? "No such file or directory (os error 2)" : null,
})

describe("when the sidecar fails", () => {
  it("says the helper is missing when the first status can't run", async () => {
    const tauri = fakeTauri()
    const w = renderWinvm()
    await flush()
    tauri.calls
      .find((c) => c.args[0] === "status" && !c.args.includes("-i"))
      ?.reject(sidecarFailure("missing", "status"))
    await flush()
    expect(w().statusError).toBe(copy("sidecar.missing"))
  })

  it("explains a status timeout, keeps polling, and clears it when status answers again", async () => {
    jest.useFakeTimers()
    const tauri = fakeTauri()
    const w = renderWinvm()
    await flush()
    tauri.calls
      .find((c) => c.args[0] === "status" && !c.args.includes("-i"))
      ?.resolve({
        ...status("running"),
        stdout: JSON.stringify({
          instances: [JSON.parse(status("running").stdout)],
        }),
      })
    await flush()
    tauri.reads()[0]?.reject(sidecarFailure("timeout", "status"))
    await flush()
    expect(w().statusError).toBe(
      copy("sidecar.timeout", { operation: "status", seconds: 45 }),
    )

    const before = tauri.reads().length
    act(() => {
      jest.advanceTimersByTime(4000)
    })
    await flush()
    expect(tauri.reads().length).toBe(before + 1)
    tauri.reads().at(-1)?.resolve(status("running"))
    await flush()
    expect(w().statusError).toBeNull()
    expect(w().phase).toBe("running")
  })

  it("retries a startup status that timed out, one at a time, until it answers; then polls the instance", async () => {
    jest.useFakeTimers()
    const tauri = fakeTauri()
    const slot: Slot<Winvm> = { current: null }
    const host = render(<WinvmAlertProbe slot={slot} />)
    const w = latest(slot)
    await flush()
    const bare = (): Call[] =>
      tauri.calls.filter(
        (c) => c.args[0] === "status" && !c.args.includes("-i"),
      )
    expect(bare()).toHaveLength(1)
    bare()[0]?.reject(sidecarFailure("timeout", "status"))
    await flush()
    expect(host.textContent).toBe(
      copy("sidecar.timeout", { operation: "status", seconds: 45 }),
    )
    expect(w().name).toBeNull()
    expect(bare()).toHaveLength(1)

    act(() => {
      jest.advanceTimersByTime(4000)
    })
    await flush()
    expect(bare()).toHaveLength(2)
    act(() => {
      jest.advanceTimersByTime(12_000)
    })
    await flush()
    expect(bare()).toHaveLength(2)
    expect(host.textContent).toBe(
      copy("sidecar.timeout", { operation: "status", seconds: 45 }),
    )

    bare()[1]?.resolve({
      ...status("running"),
      stdout: JSON.stringify({
        instances: [JSON.parse(status("running").stdout)],
      }),
    })
    await flush()
    expect(w().name).toBe("demo")
    expect(w().statusError).toBeNull()
    expect(host.textContent).toBe("")

    expect(tauri.reads()).toHaveLength(1)
    tauri.reads()[0]?.resolve(status("running"))
    await flush()
    expect(w().phase).toBe("running")
    act(() => {
      jest.advanceTimersByTime(4000)
    })
    await flush()
    expect(tauri.reads()).toHaveLength(2)
    expect(bare()).toHaveLength(2)
  })

  it("shows a verb whose helper is missing as that verb's failure, with the same copy", async () => {
    const tauri = fakeTauri()
    const w = renderWinvm()
    await flush()
    tauri.calls
      .find((c) => c.args[0] === "status" && !c.args.includes("-i"))
      ?.resolve({
        ...status("running"),
        stdout: JSON.stringify({
          instances: [JSON.parse(status("running").stdout)],
        }),
      })
    await flush()
    tauri.reads()[0]?.resolve(status("running"))
    await flush()
    act(() => {
      void w().act("pause")
    })
    await flush()
    tauri.verb("pause").reject(sidecarFailure("missing", "pause"))
    await flush()
    expect(w().failure?.verb).toBe("pause")
    expect(w().failure?.output).toBe(copy("sidecar.missing"))
    expect(w().phase).toBe("running")
  })
})

describe("the meters while held", () => {
  it("read only ps while the machine is paused, and Windows' figures again once it runs", async () => {
    jest.useFakeTimers()
    const asked: (string | null)[] = []
    const read = (_pid: number, instance: string | null): Promise<unknown> => {
      asked.push(instance)
      return Promise.resolve({
        atMs: Date.now(),
        host: { cpuSeconds: 1, rssBytes: 1024 },
        guest: null,
        guestError: null,
      })
    }
    render(<UsageProbe instance={null} read={read} />)
    await flush()
    act(() => {
      jest.advanceTimersByTime(2500)
    })
    await flush()
    act(() => {
      jest.advanceTimersByTime(2500)
    })
    await flush()
    expect(asked.length).toBeGreaterThanOrEqual(3)
    expect(asked.every((i) => i === null)).toBe(true)

    act(() => root?.render(<UsageProbe instance="demo" read={read} />))
    await flush()
    expect(asked.at(-1)).toBe("demo")
  })

  it("start over for another process: no history, and no CPU worked out against the last one's sample", async () => {
    jest.useFakeTimers()
    const read = (pid: number): Promise<unknown> =>
      Promise.resolve({
        atMs: Date.now(),
        host: { cpuSeconds: pid * Date.now(), rssBytes: 1024 },
        guest: null,
        guestError: null,
      })
    const slot: Slot<UsageView> = { current: null }
    render(<UsageViewProbe pid={1} read={read} slot={slot} />)
    await flush()
    act(() => {
      jest.advanceTimersByTime(2500)
    })
    await flush()
    expect(slot.current?.cpuHistory).toHaveLength(1)
    expect(slot.current?.now?.macCpu).not.toBeNull()

    act(() => {
      jest.advanceTimersByTime(1000)
    })
    act(() => root?.render(<UsageViewProbe pid={2} read={read} slot={slot} />))
    await flush()
    expect(slot.current?.cpuHistory).toEqual([])
    expect(slot.current?.now?.macCpu).toBeNull()
  })

  it("say Paused or Asleep instead of Windows' figures", () => {
    const usage = {
      now: {
        cpu: 3,
        cpuSource: "windows" as const,
        macCpu: 12,
        memory: { used: 1, total: 4, source: "windows" as const },
        disk: null,
      },
      cpuHistory: [],
      memoryHistory: [],
    }
    const ctx = { cpus: 4, overlayBytes: null }
    const paused = render(
      <Resources usage={usage} context={ctx} held="paused" />,
    )
    expect(paused.textContent).toBe(en["usage.paused"] ?? "?")
    act(() => root?.unmount())
    const asleep = render(
      <Resources usage={usage} context={ctx} held="asleep" />,
    )
    expect(asleep.textContent).toBe(en["usage.asleep"] ?? "?")
    act(() => root?.unmount())
    const running = render(<Resources usage={usage} context={ctx} />)
    expect(running.textContent).toContain(en["usage.cpu"] ?? "?")
    expect(running.textContent).toContain("3%")
    expect(running.textContent).toContain(
      "On the Mac, with the screen and disk: 12%",
    )
  })

  it("exposes each meter's label, value and note without nesting the note in the meter", () => {
    const GB = 1024 ** 3
    const usage = {
      now: {
        cpu: 3,
        cpuSource: "windows" as const,
        macCpu: 12,
        memory: { used: 2 * GB, total: 4 * GB, source: "windows" as const },
        disk: { used: 10 * GB, total: 40 * GB },
      },
      cpuHistory: [0.1, 0.2],
      memoryHistory: [0.4, 0.5],
    }
    const host = render(
      <Resources usage={usage} context={{ cpus: 4, overlayBytes: 5 * GB }} />,
    )
    const meters = [...host.querySelectorAll<HTMLElement>('[role="meter"]')]
    expect(meters.map((m) => m.getAttribute("aria-label"))).toEqual([
      en["usage.cpu"] ?? "?",
      en["usage.memory"] ?? "?",
      en["usage.disk"] ?? "?",
    ])
    expect(meters.map((m) => m.getAttribute("aria-valuenow"))).toEqual([
      "3",
      "50",
      "25",
    ])
    expect(meters[0]?.getAttribute("aria-valuetext")).toBe("3%")
    const noteOf = (m: HTMLElement | undefined): HTMLElement | null => {
      const id = m?.getAttribute("aria-describedby")
      return id === null || id === undefined
        ? null
        : document.getElementById(id)
    }
    const cpuNote = noteOf(meters[0])
    expect(cpuNote?.textContent).toContain(
      "On the Mac, with the screen and disk: 12%",
    )
    expect(meters[0]?.contains(cpuNote ?? null)).toBe(false)
    expect(noteOf(meters[1])).toBeNull()
    const diskNote = noteOf(meters[2])
    expect(diskNote?.textContent).toBe("Its changes take 5 GB on this Mac")
    expect(meters[2]?.contains(diskNote ?? null)).toBe(false)
    for (const m of meters) expect(m.textContent).toBe("")
  })
})

async function boot(
  tauri: ReturnType<typeof fakeTauri>,
  state = "running",
  names: readonly string[] = ["demo"],
): Promise<{ w: () => ReturnType<typeof useWinvm> }> {
  const slot: Slot<Winvm> = { current: null }
  render(<WinvmProbe slot={slot} />)
  await flush()
  const list = tauri.calls.find(
    (c) => c.args[0] === "status" && !c.args.includes("-i"),
  )
  list?.resolve({
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      instances: names.map(
        (n) => JSON.parse(status(state, "ok", null, n).stdout) as unknown,
      ),
    }),
  })
  await flush()
  tauri.reads()[0]?.resolve(status(state))
  await flush()
  return { w: latest(slot) }
}

describe("the screen's address", () => {
  it("is asked for once the machine runs, again after each status poll until it comes, and then no more", async () => {
    jest.useFakeTimers()
    const failed: Output = { code: 1, stdout: "", stderr: "no screen yet" }
    const found: Output = {
      code: 0,
      stdout: JSON.stringify({
        display: 1,
        vncPort: 5901,
        websocketPort: 5701,
        password: null,
      }),
      stderr: "",
    }
    let answer = failed
    const tauri = fakeTauri(() => answer)
    const { w } = await boot(tauri)
    const first = tauri.opens.length
    expect(first).toBeGreaterThan(0)
    expect(tauri.opens[0]).toEqual(["open", "--json", "-i", "demo"])
    expect(w().connection).toBeNull()

    answer = found
    act(() => {
      jest.advanceTimersByTime(4000)
    })
    await flush()
    expect(tauri.opens).toHaveLength(first)
    tauri.reads().at(-1)?.resolve(status("running"))
    await flush()
    expect(tauri.opens).toHaveLength(first + 1)
    expect(w().connection?.websocketPort).toBe(5701)

    act(() => {
      jest.advanceTimersByTime(4000)
    })
    await flush()
    tauri.reads().at(-1)?.resolve(status("running"))
    await flush()
    expect(tauri.opens).toHaveLength(first + 1)
  })
})

describe("operations in the window", () => {
  it("shows an operation another command is running as external, polls fast while it runs, and clears it when status says none", async () => {
    jest.useFakeTimers()
    const tauri = fakeTauri()
    const { w } = await boot(tauri)
    expect(w().operation).toBeNull()

    const before = tauri.reads().length
    act(() => {
      jest.advanceTimersByTime(4000)
    })
    await flush()
    expect(tauri.reads().length).toBe(before + 1)
    tauri
      .reads()
      .at(-1)
      ?.resolve(status("running", "ok", "stow"))
    await flush()
    expect(w().operation).toEqual({ operation: "stow", source: "external" })
    expect(w().busy).toBeNull()

    const reads = (): number => tauri.reads().length
    tauri
      .reads()
      .at(-1)
      ?.resolve(status("running", "ok", "stow"))
    await flush()
    const n = reads()
    act(() => {
      jest.advanceTimersByTime(1500)
    })
    await flush()
    expect(reads()).toBe(n + 1)
    tauri
      .reads()
      .at(-1)
      ?.resolve(status("running", "ok", "stow"))
    await flush()

    act(() => {
      jest.advanceTimersByTime(1500)
    })
    await flush()
    tauri.reads().at(-1)?.resolve(status("stowed", null))
    await flush()
    expect(w().operation).toBeNull()
    expect(w().phase).toBe("stowed")
    const m = reads()
    await flush()
    act(() => {
      jest.advanceTimersByTime(1500)
    })
    await flush()
    expect(reads()).toBe(m)
  })

  it("names this viewer's own verb as the machine's operation, whatever status says meanwhile, and falls back to status after", async () => {
    const tauri = fakeTauri()
    const { w } = await boot(tauri)

    act(() => {
      void w().act("stow")
    })
    await flush()
    expect(w().busy).toBe("stow")
    expect(w().operation).toMatchObject({ operation: "stow", source: "local" })

    tauri
      .reads()
      .filter((c) => !c.done)
      .at(-1)
      ?.resolve(status("running", "ok", "stop"))
    await flush()
    expect(w().operation).toMatchObject({ operation: "stow", source: "local" })

    tauri.verb("stow").resolve({ code: 0, stdout: "", stderr: "" })
    await flush()
    expect(w().busy).toBeNull()
    tauri
      .reads()
      .filter((c) => !c.done)
      .at(-1)
      ?.resolve(status("running", "ok", "stop"))
    await flush()
    expect(w().operation).toEqual({ operation: "stop", source: "external" })
  })

  it("runs a verb on the instance it is given, however the selection has moved, and leaves the selected machine alone", async () => {
    const tauri = fakeTauri()
    const { w } = await boot(tauri, "running", ["demo", "other"])
    expect(w().name).toBe("demo")
    const runOn = w().runOn

    let ran: Promise<unknown> | null = null
    act(() => {
      ran = runOn("other", "pause")
    })
    await flush()
    expect(tauri.verb("pause").args.slice(0, 3)).toEqual([
      "pause",
      "-i",
      "other",
    ])
    expect(tauri.verb("pause").args[3]).toBe("--op-id")
    expect(w().busy).toBeNull()
    expect(w().operation).toBeNull()

    act(() => {
      w().select("other")
    })
    await flush()
    expect(w().busy).toBe("pause")
    expect(w().operation).toMatchObject({ operation: "pause", source: "local" })
    act(() => {
      w().select("demo")
    })
    await flush()
    expect(w().operation).toBeNull()

    const readsOfOther = tauri
      .reads()
      .filter((c) => c.args.includes("other")).length
    tauri.verb("pause").resolve({ code: 0, stdout: "", stderr: "" })
    await flush()
    expect(tauri.reads().filter((c) => c.args.includes("other")).length).toBe(
      readsOfOther + 1,
    )
    tauri
      .reads()
      .filter((c) => !c.done && c.args.includes("other"))
      .at(-1)
      ?.resolve(status("paused", null, null, "other"))
    await flush()
    await act(async () => {
      await ran
    })
    expect(w().phase).not.toBe("paused")
    expect(w().phases.other).toBe("paused")
    expect(w().last?.verb).toBe("pause")
  })

  it("keeps act on the selected machine", async () => {
    const tauri = fakeTauri()
    const { w } = await boot(tauri, "running", ["demo", "other"])
    act(() => {
      void w().act("stop")
    })
    await flush()
    expect(tauri.verb("stop").args.slice(0, 3)).toEqual(["stop", "-i", "demo"])
    expect(tauri.verb("stop").args[3]).toBe("--op-id")
  })

  it("runs setup against the host however it is asked, and makes every machine wait for it", async () => {
    const tauri = fakeTauri()
    const { w } = await boot(tauri, "running", ["demo", "other"])
    act(() => {
      void w().runOn("other", "setup")
    })
    await flush()
    const setup = tauri.calls.find((c) => c.args[0] === "setup")
    expect(setup?.args).toEqual(["setup"])
    expect(w().operation).toEqual({ operation: "setup", source: "local" })
  })

  it("hands the close flow a fresh status for one machine, or for all of them, and null when it can't read", async () => {
    const tauri = fakeTauri()
    const { w } = await boot(tauri, "running", ["demo", "other"])

    let one = null as Promise<unknown> | null
    act(() => {
      one = w().refreshOne("other")
    })
    await flush()
    const read = tauri
      .reads()
      .filter((c) => !c.done && c.args.includes("other"))
      .at(-1)
    expect(read?.args).toEqual(["status", "--json", "-i", "other"])
    read?.resolve(status("stowed", null, "stow", "other"))
    await flush()
    expect(await one).toMatchObject({
      name: "other",
      state: "stowed",
      operation: { operation: "stow" },
    })
    expect(w().phases.other).toBe("stowed")
    expect(w().status?.name).toBe("demo")
    expect(w().operation).toBeNull()

    act(() => {
      one = w().refreshOne("demo")
    })
    await flush()
    tauri
      .reads()
      .filter((c) => !c.done && c.args.includes("demo"))
      .at(-1)
      ?.resolve(status("paused", null, "pause"))
    await flush()
    expect(await one).toMatchObject({ name: "demo", state: "paused" })
    expect(w().operation).toEqual({ operation: "pause", source: "external" })

    let all = null as Promise<unknown> | null
    act(() => {
      all = w().refreshAll()
    })
    await flush()
    const list = tauri.calls
      .filter(
        (c) => c.args[0] === "status" && !c.args.includes("-i") && !c.done,
      )
      .at(-1)
    list?.resolve({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        instances: [
          JSON.parse(status("running").stdout),
          JSON.parse(status("stopped", null, null, "other").stdout),
        ],
      }),
    })
    await flush()
    const got = (await all) as readonly { name: string; state: string }[] | null
    expect(got?.map((s) => [s.name, s.state])).toEqual([
      ["demo", "running"],
      ["other", "stopped"],
    ])
    expect(w().phases.other).toBe("stopped")

    act(() => {
      one = w().refreshOne("other")
    })
    await flush()
    tauri
      .reads()
      .filter((c) => !c.done && c.args.includes("other"))
      .at(-1)
      ?.resolve({ code: 1, stdout: "", stderr: "boom" })
    await flush()
    expect(await one).toBeNull()
  })

  it("maps each viewer verb to its shared operation", async () => {
    const { operationFor } = await import(
      "../ui/src/features/winvm/statusGuard"
    )
    expect(operationFor("stow")).toBe("stow")
    expect(operationFor("save")).toBe("save")
    expect(operationFor("load")).toBe("load")
    expect(operationFor("setup")).toBe("setup")
  })
})
