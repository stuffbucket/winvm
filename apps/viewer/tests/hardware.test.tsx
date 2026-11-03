/**
 * The panel's Hardware and Network: reading `winvm info --json`, the
 * `winvm config` it runs to change the size, and what each part shows
 * (rendered in happy-dom).
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Hardware } = await import("../ui/src/features/hardware/Hardware")
const { Network } = await import("../ui/src/features/hardware/Network")
const info = await import("../ui/src/features/hardware/info")
type View = import("../ui/src/features/hardware/useMachineInfo").MachineInfoView
type Info = import("../ui/src/features/hardware/info").MachineInfo

type Root = ReturnType<typeof createRoot>
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})
afterAll(() => GlobalRegistrator.unregister())

function render(node: JSX.Element): HTMLElement {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(node))
  return host
}

const RUNNING = {
  name: "hw-test",
  running: true,
  hardware: {
    running: { cpus: 6, memoryMiB: 8192 },
    next: { cpus: 6, memoryMiB: 8192 },
    limits: { cpus: { min: 2, max: 16 }, memoryMiB: { min: 4096, max: 32768, step: 1024 } },
    diskBytes: 64 * 1024 ** 3,
  },
  network: {
    mode: "user",
    label: "NAT (QEMU user networking)",
    guest: "10.0.2.15",
    gateway: "10.0.2.2",
    dns: "10.0.2.3",
    windows: { adapter: "Ethernet", ipv4: "10.0.2.15" },
    forwards: [
      { kind: "finder", host: "127.0.0.1", hostPort: 51234, guestPort: 445 },
      { kind: "agent", host: "127.0.0.1", hostPort: 47801, guestPort: 7801 },
    ],
    listeners: [
      { kind: "vnc", host: "127.0.0.1", port: 5909 },
      { kind: "websocket", host: "127.0.0.1", port: 5709 },
    ],
  },
}

const parsed = (over: object = {}): Info => {
  const got = info.parseMachineInfo(JSON.stringify({ ...RUNNING, ...over }))
  if (got === null) throw new Error("did not parse")
  return got
}

const view = (i: Info | null, over: Partial<View> = {}): View & { sizes: unknown[] } => {
  const sizes: unknown[] = []
  return { info: i, error: null, working: false, setSize: (s) => sizes.push(s), ...over, sizes }
}

describe("winvm info", () => {
  it("parses what the CLI prints, and nothing else", () => {
    expect(parsed().hardware.next).toEqual({ cpus: 6, memoryMiB: 8192 })
    expect(info.parseMachineInfo("not json")).toBeNull()
    expect(info.parseMachineInfo(JSON.stringify({ name: "x" }))).toBeNull()
  })

  it("names the machine, and asks for JSON", () => {
    expect(info.infoArgs("demo")).toEqual(["info", "-i", "demo", "--json"])
  })

  it("changes the size with config assignments, only what is given", () => {
    expect(info.sizeArgs("demo", { cpus: 6, memoryMiB: 8192 })).toEqual(["config", "-i", "demo", "cpus=6", "memory=8192"])
    expect(info.sizeArgs("demo", { cpus: 2 })).toEqual(["config", "-i", "demo", "cpus=2"])
  })

  it("is pending only while running with another size", () => {
    expect(info.pendingRestart(parsed())).toBe(false)
    expect(info.pendingRestart(parsed({ hardware: { ...RUNNING.hardware, next: { cpus: 4, memoryMiB: 8192 } } }))).toBe(true)
    expect(info.pendingRestart(parsed({ running: false, hardware: { ...RUNNING.hardware, running: null, next: { cpus: 4, memoryMiB: 4096 } } }))).toBe(false)
  })

  it("prefers Windows' own address", () => {
    expect(info.windowsAddress(parsed({ network: { ...RUNNING.network, windows: { adapter: "Ethernet", ipv4: "10.0.2.16" } } }))).toBe("10.0.2.16")
    expect(info.windowsAddress(parsed({ network: { ...RUNNING.network, windows: null } }))).toBe("10.0.2.15")
  })

  it("writes memory in GB", () => {
    expect(info.formatMemory(8192)).toBe("8 GB")
    expect(info.fromGB(6)).toBe(6144)
  })
})

describe("the Hardware part", () => {
  it("shows the size set and the disk, with no note while they match", () => {
    const host = render(<Hardware view={view(parsed())} />)
    const inputs = [...host.querySelectorAll<HTMLInputElement>("input.number-field__input")].map((i) => i.value)
    expect(inputs).toEqual(["6", "8"])
    expect(host.textContent).toContain("64 GB")
    expect(host.textContent).not.toContain("Applies the next time Windows starts")
  })

  it("says the change waits for the next start, and what runs now", () => {
    const host = render(<Hardware view={view(parsed({ hardware: { ...RUNNING.hardware, next: { cpus: 4, memoryMiB: 6144 } } }))} />)
    expect(host.textContent).toContain("Applies the next time Windows starts. Running now with 6 processors and 8 GB.")
  })

  it("says nothing about the next start while stopped", () => {
    const host = render(<Hardware view={view(parsed({ running: false, hardware: { ...RUNNING.hardware, running: null, next: { cpus: 4, memoryMiB: 6144 } } }))} />)
    expect(host.textContent).not.toContain("Applies the next time")
  })

  it("writes a stepper press as the whole size, once it settles", async () => {
    const v = view(parsed())
    const host = render(<Hardware view={v} />)
    const more = host.querySelector<HTMLButtonElement>('button[aria-label="More"]')
    expect(more).not.toBeNull()
    act(() => {
      more?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }))
      more?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }))
      more?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }))
    })
    await act(async () => await new Promise((r) => setTimeout(r, 700)))
    expect(v.sizes).toEqual([{ cpus: 7, memoryMiB: 8192 }])
  })

  it("shows what a failed change said", () => {
    const host = render(<Hardware view={view(parsed(), { error: "processors must be a whole number from 2 to 16" })} />)
    expect(host.querySelector(".action__error")?.textContent).toBe("processors must be a whole number from 2 to 16")
  })
})

describe("the Network part", () => {
  it("shows the mode, the addresses and every port, each copyable", () => {
    const host = render(<Network view={view(parsed())} />)
    const text = host.textContent ?? ""
    for (const s of ["NAT (QEMU user networking)", "10.0.2.15", "Ethernet", "10.0.2.2", "10.0.2.3", "Finder drives", "winvm agent", "Screen sharing (VNC)"]) {
      expect(text).toContain(s)
    }
    expect(text).toContain("127.0.0.1:51234 → 445")
    const copies = [...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))
    expect(copies).toContain("Copy 127.0.0.1:51234")
    expect(copies).toContain("Copy 10.0.2.2")
    expect(text).toContain("these ports listen only on this Mac")
  })

  it("says the ports show while Windows runs, when it doesn't", () => {
    const host = render(<Network view={view(parsed({ running: false, network: { ...RUNNING.network, windows: null, forwards: [], listeners: [] } }))} />)
    expect(host.textContent).toContain("These show while Windows is running.")
    expect(host.textContent).toContain("10.0.2.15")
  })
})
