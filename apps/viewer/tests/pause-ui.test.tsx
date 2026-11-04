/**
 * Pausing, in the window: the status answers that race a Pause, the meters
 * while held, and the Resources panel. Rendered in happy-dom, with the app's
 * Tauri bridge faked (window.__TAURI__) and winvm's answers handed out by hand.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it, jest } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { useWinvm } = await import("../ui/src/features/winvm/useWinvm")
const { useUsage } = await import("../ui/src/features/usage/useUsage")
const { Resources } = await import("../ui/src/features/usage/Resources")
const en = (await import("../ui/src/i18n/en.json")).default as Record<string, string>

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
  done: boolean
}

/** The app's bridge, with `status` and the power verbs answered by the test; the rest answered at once. */
function fakeTauri(): { calls: Call[]; reads(): Call[]; verb(v: string): Call } {
  const calls: Call[] = []
  const held = new Set(["status", "pause", "resume", "sleep", "wake"])
  const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
    const args = a?.args ?? []
    if (cmd !== "winvm") return Promise.resolve(null)
    if (!held.has(args[0] ?? "")) return Promise.resolve({ code: 1, stdout: "", stderr: "" })
    return new Promise<Output>((resolve) => {
      const call: Call = {
        args,
        done: false,
        resolve: (o) => {
          call.done = true
          resolve(o)
        },
      }
      calls.push(call)
    })
  }
  Object.assign(window, { __TAURI__: { core: { invoke } } })
  return {
    calls,
    reads: () => calls.filter((c) => c.args[0] === "status" && c.args.includes("-i")),
    verb: (v) => {
      const c = calls.find((x) => x.args[0] === v && !x.done)
      if (c === undefined) throw new Error(`no ${v} pending`)
      return c
    },
  }
}

const status = (state: string, agent: "ok" | "silent" | null = "ok"): Output => ({
  code: 0,
  stderr: "",
  stdout: JSON.stringify({
    name: "demo",
    title: null,
    state,
    vmStatus: state === "running" ? "running" : "paused",
    image: "win11-arm64",
    pid: 4242,
    uptimeSeconds: 60,
    cpus: 4,
    memoryMiB: 4096,
    screen: "virtio-gpu 1280x800",
    overlayBytes: 1,
    guest: agent === null ? null : { agent, agentVersion: "9", os: "Windows 11" },
    saves: { count: 0, bytes: 0 },
    notes: [],
  }),
})

describe("pausing in the window", () => {
  it("shows paused the moment Pause returns, and a status read that raced it never puts running back", async () => {
    const tauri = fakeTauri()
    let w: ReturnType<typeof useWinvm> | null = null
    function Probe(): null {
      w = useWinvm()
      return null
    }
    render(<Probe />)
    await flush()
    // The list of machines, then this one's first read.
    const list = tauri.calls.find((c) => c.args[0] === "status" && !c.args.includes("-i"))
    list?.resolve({ ...status("running"), stdout: JSON.stringify({ instances: [JSON.parse(status("running").stdout)] }) })
    await flush()
    tauri.reads()[0]?.resolve(status("running"))
    await flush()
    expect(w!.phase).toBe("running")

    // Pause: while it runs, the poll (now fast) reads again; QEMU still says running to it.
    let acted: Promise<unknown> | null = null
    act(() => {
      acted = w!.act("pause")
    })
    await flush()
    expect(w!.busy).toBe("pause")
    const raced = tauri.reads().filter((c) => !c.done)
    expect(raced.length).toBeGreaterThan(0)

    tauri.verb("pause").resolve({ code: 0, stdout: 'paused "demo"\n', stderr: "" })
    await flush()
    // At once, without waiting for a read.
    expect(w!.busy).toBeNull()
    expect(w!.phase).toBe("paused")

    // The reads that were out when Pause ended answer "running": stale, dropped.
    for (const c of raced) c.resolve(status("running"))
    await flush()
    expect(w!.phase).toBe("paused")

    // Reads started after it: the newest lands first; the older one, answering later, is dropped.
    const after = tauri.reads().filter((c) => !c.done)
    expect(after.length).toBeGreaterThanOrEqual(2)
    after.at(-1)?.resolve(status("paused", null))
    await flush()
    expect(w!.phase).toBe("paused")
    after[0]?.resolve(status("running"))
    await flush()
    expect(w!.phase).toBe("paused")
    await act(async () => {
      await acted
    })
  })

  it("shows running the moment Wake returns, and asleep until then", async () => {
    const tauri = fakeTauri()
    let w: ReturnType<typeof useWinvm> | null = null
    function Probe(): null {
      w = useWinvm()
      return null
    }
    render(<Probe />)
    await flush()
    tauri.calls.find((c) => c.args[0] === "status" && !c.args.includes("-i"))?.resolve({
      ...status("asleep", null),
      stdout: JSON.stringify({ instances: [JSON.parse(status("asleep", null).stdout)] }),
    })
    await flush()
    tauri.reads()[0]?.resolve(status("asleep", null))
    await flush()
    expect(w!.phase).toBe("asleep")

    act(() => {
      void w!.act("wake")
    })
    await flush()
    const raced = tauri.reads().filter((c) => !c.done)
    tauri.verb("wake").resolve({ code: 0, stdout: "", stderr: "" })
    await flush()
    expect(w!.phase).toBe("running")
    for (const c of raced) c.resolve(status("asleep", null))
    await flush()
    expect(w!.phase).toBe("running")
  })

  it("keeps the old phase when Pause fails", async () => {
    const tauri = fakeTauri()
    let w: ReturnType<typeof useWinvm> | null = null
    function Probe(): null {
      w = useWinvm()
      return null
    }
    render(<Probe />)
    await flush()
    tauri.calls.find((c) => c.args[0] === "status" && !c.args.includes("-i"))?.resolve({
      ...status("running"),
      stdout: JSON.stringify({ instances: [JSON.parse(status("running").stdout)] }),
    })
    await flush()
    tauri.reads()[0]?.resolve(status("running"))
    await flush()
    act(() => {
      void w!.act("pause")
    })
    await flush()
    tauri.verb("pause").resolve({ code: 1, stdout: "", stderr: "::error::no" })
    await flush()
    expect(w!.phase).toBe("running")
    expect(w!.failure?.verb).toBe("pause")
  })
})

describe("the meters while held", () => {
  it("read only ps while the machine is paused, and Windows' figures again once it runs", async () => {
    jest.useFakeTimers()
    const asked: (string | null)[] = []
    const read = async (_pid: number, instance: string | null): Promise<unknown> => {
      asked.push(instance)
      return { atMs: Date.now(), host: { cpuSeconds: 1, rssBytes: 1024 }, guest: null, guestError: null }
    }
    function Probe({ instance }: { readonly instance: string | null }): null {
      useUsage(4242, instance, 4, 4096, read)
      return null
    }
    // Paused: App passes no instance (the agent can't answer).
    render(<Probe instance={null} />)
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

    // Running again.
    act(() => root?.render(<Probe instance="demo" />))
    await flush()
    expect(asked.at(-1)).toBe("demo")
  })

  it("say Paused or Asleep instead of Windows' figures", () => {
    const usage = {
      now: { cpu: 3, cpuSource: "windows" as const, macCpu: 12, memory: { used: 1, total: 4, source: "windows" as const }, disk: null },
      cpuHistory: [],
      memoryHistory: [],
      macCpuHistory: [],
    }
    const ctx = { cpus: 4, overlayBytes: null }
    const paused = render(<Resources usage={usage} context={ctx} held="paused" />)
    expect(paused.textContent).toBe(en["usage.paused"] ?? "?")
    act(() => root?.unmount())
    const asleep = render(<Resources usage={usage} context={ctx} held="asleep" />)
    expect(asleep.textContent).toBe(en["usage.asleep"] ?? "?")
    act(() => root?.unmount())
    const running = render(<Resources usage={usage} context={ctx} />)
    expect(running.textContent).toContain(en["usage.cpu"] ?? "?")
    // Windows' own figure leads; what the Mac spends is named on hover, not in a caption.
    expect(running.textContent).toContain("3%")
    expect(running.querySelector(".resource__note")).toBeNull()
  })
})

describe("the meters' two values", () => {
  const GB = 1024 ** 3
  const now = (o: object = {}) => ({
    cpu: 3,
    cpuSource: "windows" as const,
    macCpu: 12,
    memory: { used: 1, total: 4, source: "windows" as const },
    disk: { used: 12 * GB, total: 63 * GB },
    ...o,
  })
  const view = (n: ReturnType<typeof now>) => ({ now: n, cpuHistory: [2, 3, 4], memoryHistory: [0.2, 0.3], macCpuHistory: [10, 12, 14] })
  const meter = (host: HTMLElement, label: string): HTMLElement | null => host.querySelector<HTMLElement>(`[aria-label^="${label}"]`)

  it("name both CPU values in full and draw the Mac's as a second, dashed line on the same chart", () => {
    const host = render(<Resources usage={view(now())} context={{ cpus: 4, overlayBytes: 3.2 * GB }} />)
    const cpu = meter(host, "CPU")
    expect(cpu?.getAttribute("role")).toBe("img")
    expect(cpu?.getAttribute("aria-label")).toBe("CPU. Windows: 3%. On this Mac: 12%.")
    expect(cpu?.getAttribute("tabindex")).toBe("0")
    expect(cpu?.querySelectorAll(".sparkline__line")).toHaveLength(2)
    expect(cpu?.querySelectorAll(".sparkline__line--other")).toHaveLength(1)
    // At rest the headline alone shows, in Windows' figure.
    expect(cpu?.querySelector(".resource__value")?.textContent).toBe("3%")
  })

  it("name both disk values in full and lay the Mac's changes over the same bar", () => {
    const host = render(<Resources usage={view(now())} context={{ cpus: 4, overlayBytes: 3.2 * GB }} />)
    const disk = meter(host, "Disk")
    expect(disk?.getAttribute("aria-label")).toBe("Disk. Windows: 12 GB of 63 GB. Changes on this Mac: 3.2 GB.")
    expect(disk?.querySelector(".resource__value")?.textContent).toBe("C: 12 GB of 63 GB")
    // The same total: 12/63 and 3.2/63 of one track.
    expect((disk?.querySelector(".resource__fill") as HTMLElement).style.inlineSize).toBe("19.05%")
    expect((disk?.querySelector(".resource__overlay") as HTMLElement).style.inlineSize).toContain("5.08%")
    expect(host.querySelector(".resource__note")).toBeNull()
  })

  it("keep a tiny overlay visible, and a huge one on the track", () => {
    const tiny = render(<Resources usage={view(now())} context={{ cpus: 4, overlayBytes: 0.05 * GB }} />)
    expect((tiny.querySelector(".resource__overlay") as HTMLElement).style.inlineSize).toMatch(/^max\(.*, ?0\.08%\)$/)
    act(() => root?.unmount())
    const big = render(<Resources usage={view(now())} context={{ cpus: 4, overlayBytes: 90 * GB }} />)
    expect((big.querySelector(".resource__overlay") as HTMLElement).style.inlineSize).toContain("100%")
    expect(meter(big, "Disk")?.getAttribute("aria-label")).toContain("Changes on this Mac: 90 GB")
  })

  it("have no second value without the Mac's figures", () => {
    const first = render(<Resources usage={{ ...view(now({ macCpu: null })), macCpuHistory: [] }} context={{ cpus: 4, overlayBytes: null }} />)
    expect(first.querySelector('[role="img"]')).toBeNull()
    expect(first.querySelector(".sparkline__line--other")).toBeNull()
    expect(first.querySelector(".resource__overlay")).toBeNull()
    expect(first.querySelector('[role="meter"][aria-label="CPU"]')).not.toBeNull()
    act(() => root?.unmount())
    // Without the agent QEMU's figure is the headline, said so, and not drawn twice.
    const mac = render(<Resources usage={view(now({ cpu: 12, cpuSource: "mac", disk: null }))} context={{ cpus: 4, overlayBytes: 3 * GB }} />)
    expect(mac.querySelector(".resource__value")?.textContent).toBe("12% on the Mac")
    expect(mac.querySelector(".sparkline__line--other")).toBeNull()
  })

  it("hide the legend on Escape while pointed at or focused, and show it again after", () => {
    const host = render(<Resources usage={view(now())} context={{ cpus: 4, overlayBytes: 3.2 * GB }} />)
    const cpu = meter(host, "CPU") as HTMLElement
    expect(cpu.hasAttribute("data-dismissed")).toBe(false)
    act(() => {
      cpu.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }))
    })
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }))
    })
    expect(cpu.hasAttribute("data-dismissed")).toBe(true)
    act(() => {
      cpu.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }))
    })
    expect(cpu.hasAttribute("data-dismissed")).toBe(false)
    expect(cpu.querySelector(".resource__legend")?.textContent).toBe("Windows: 3%On this Mac: 12%")
  })
})
