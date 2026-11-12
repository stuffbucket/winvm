/**
 * The close dialog: what it asks about one machine (its words, its progress, the three choices,
 * Remember, Cancel), how it is dismissed, and what it shows while the close waits on a command
 * it did not start. Rendered in happy-dom.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { ClosePolicyDialog } = await import("../ui/src/features/close/ClosePolicyDialog")
const { parseStatus } = await import("../ui/src/model")
const { copy } = await import("./copy")

type CloseFlowState = import("../ui/src/features/close/useCloseFlow").CloseFlowState
type CloseChoice = import("../ui/src/features/close/useCloseFlow").CloseChoice
type Status = import("../ui/src/model").Status

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})
afterAll(() => GlobalRegistrator.unregister())

function machine(name: string, title: string | null = null): Status {
  const s = parseStatus(
    JSON.stringify({
      name,
      title,
      closePolicy: "ask",
      operation: null,
      state: "running",
      vmStatus: "running",
      image: "win11-arm64",
      pid: 4242,
      uptimeSeconds: 60,
      cpus: 4,
      memoryMiB: 4096,
      screen: null,
      overlayBytes: null,
      guest: { agent: "ok", agentVersion: "9", os: "Windows 11" },
      saves: { count: 0, bytes: 0 },
      notes: [],
    }),
  )?.[0]
  if (s === undefined) throw new Error("unparseable")
  return s
}

interface Heard {
  chose: CloseChoice[]
  remember: boolean[]
  cancels: number
}

function render(state: CloseFlowState, heard: Heard = { chose: [], remember: [], cancels: 0 }): { host: HTMLElement; heard: Heard; show(next: CloseFlowState): void } {
  const host = document.createElement("div")
  document.body.append(host)
  const r = createRoot(host)
  root = r
  const show = (next: CloseFlowState): void =>
    act(() =>
      r.render(
        <ClosePolicyDialog
          state={next}
          onChoose={(p) => heard.chose.push(p)}
          onRemember={(v) => heard.remember.push(v)}
          onCancel={() => {
            heard.cancels += 1
          }}
        />,
      ),
    )
  show(state)
  return { host, heard, show }
}

const dialog = (host: HTMLElement): HTMLDialogElement | null => host.querySelector<HTMLDialogElement>("dialog.close-dialog")
const buttonNamed = (host: HTMLElement, label: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.querySelector(".close-dialog__choice-label")?.textContent === label || b.textContent === label)
  if (found === undefined) throw new Error(`no ${label} button`)
  return found
}

describe("ClosePolicyDialog", () => {
  it("asks what should happen to one machine, named by its title, with its place in the queue and the three choices explained", () => {
    const { host, heard } = render({ kind: "asking", machine: machine("work", "Work PC"), index: 2, total: 3, remember: false })
    const el = dialog(host)
    expect(el?.open).toBe(true)
    expect(el?.querySelector("h2")?.textContent).toBe(copy("close.title"))
    expect(copy("close.title")).toBe("What should happen to Windows?")
    expect(el?.textContent).toContain("Work PC")
    expect(el?.textContent).toContain("Machine 2 of 3")

    for (const [key, policy] of [
      ["close.leave", "leave"],
      ["close.stow", "stow"],
      ["close.shutdown", "shutdown"],
    ] as const) {
      const b = buttonNamed(host, copy(key))
      expect(b.textContent).toContain(copy(`${key}.body`))
      act(() => b.click())
      expect(heard.chose.at(-1)).toBe(policy)
    }
    expect([copy("close.leave"), copy("close.stow"), copy("close.shutdown")]).toEqual(["Leave Running", "Stow Windows", "Shut Down"])

    act(() => buttonNamed(host, copy("confirm.cancel")).click())
    expect(heard.cancels).toBe(1)
  })

  it("leaves out the progress when there is only one machine to ask about", () => {
    const { host } = render({ kind: "asking", machine: machine("solo"), index: 1, total: 1, remember: false })
    expect(dialog(host)?.textContent).toContain("solo")
    expect(dialog(host)?.textContent).not.toContain("Machine 1 of 1")
  })

  it("offers Remember unchecked on every ask, and reports a change to it", () => {
    const first: CloseFlowState = { kind: "asking", machine: machine("a"), index: 1, total: 2, remember: false }
    const { host, heard, show } = render(first)
    const box = (): HTMLInputElement => {
      const input = dialog(host)?.querySelector<HTMLInputElement>('input[type="checkbox"]')
      if (input == null) throw new Error("no Remember box")
      return input
    }
    expect(box().closest("label")?.textContent).toBe(copy("close.remember"))
    expect(copy("close.remember")).toBe("Remember for this Windows machine")
    expect(box().checked).toBe(false)
    act(() => box().click())
    expect(heard.remember).toEqual([true])
    show({ ...first, remember: true })
    expect(box().checked).toBe(true)
    // The next machine's ask starts unchecked.
    show({ kind: "asking", machine: machine("b"), index: 2, total: 2, remember: false })
    expect(box().checked).toBe(false)
  })

  it("puts focus on Cancel when it asks, and again when it asks about the next machine", () => {
    const { host, show } = render({ kind: "asking", machine: machine("a"), index: 1, total: 2, remember: false })
    expect(document.activeElement).toBe(buttonNamed(host, copy("confirm.cancel")))
    act(() => buttonNamed(host, copy("close.stow")).focus())
    expect(document.activeElement).toBe(buttonNamed(host, copy("close.stow")))
    show({ kind: "asking", machine: machine("b"), index: 2, total: 2, remember: false })
    expect(document.activeElement).toBe(buttonNamed(host, copy("confirm.cancel")))
  })

  it("treats Escape and a click on the backdrop as Cancel", () => {
    const { host, heard } = render({ kind: "asking", machine: machine("a"), index: 1, total: 1, remember: false })
    const el = dialog(host)
    if (el === null) throw new Error("no dialog")
    // Escape: the dialog's own cancel event, kept from closing it behind the flow's back.
    const escape = new Event("cancel", { cancelable: true })
    act(() => {
      el.dispatchEvent(escape)
    })
    expect(escape.defaultPrevented).toBe(true)
    expect(heard.cancels).toBe(1)
    expect(el.open).toBe(true)
    act(() => el.click())
    expect(heard.cancels).toBe(2)
    // A click inside the panel is not the backdrop.
    act(() => el.querySelector<HTMLElement>(".close-dialog__machine")?.click())
    expect(heard.cancels).toBe(2)
    expect(heard.chose).toEqual([])
  })

  it("while the close waits on a command it did not start, says what that command is and keeps Cancel ready", () => {
    const { host, heard } = render({
      kind: "waiting",
      machine: machine("lab", "Lab"),
      operation: { operation: "save", source: "external" },
      index: 1,
      total: 2,
    })
    const el = dialog(host)
    expect(el?.open).toBe(true)
    expect(el?.querySelector("[role=status]")?.textContent).toBe(copy("operation.save"))
    expect(el?.textContent).toContain(copy("close.waiting"))
    expect(el?.textContent).toContain("Lab")
    expect(el?.textContent).toContain("Machine 1 of 2")
    // Nothing to choose until it ends.
    expect(el?.querySelectorAll(".close-dialog__choice")).toHaveLength(0)
    expect(el?.querySelector('input[type="checkbox"]')).toBeNull()
    const cancel = buttonNamed(host, copy("confirm.cancel"))
    expect(cancel.disabled).toBe(false)
    expect(document.activeElement).toBe(cancel)
    act(() => cancel.click())
    expect(heard.cancels).toBe(1)
    const escape = new Event("cancel", { cancelable: true })
    act(() => {
      el?.dispatchEvent(escape)
    })
    expect(heard.cancels).toBe(2)
  })

  it("goes once the close runs its own stow or shutdown, so nothing in it can cancel that, and shows nothing otherwise", () => {
    const a = machine("a")
    const { host, heard, show } = render({ kind: "asking", machine: a, index: 1, total: 1, remember: false })
    expect(dialog(host)).not.toBeNull()
    show({ kind: "acting", machine: a, policy: "stow", index: 1, total: 1 })
    expect(dialog(host)).toBeNull()
    expect(host.querySelector("button")).toBeNull()
    for (const quiet of [{ kind: "idle" }, { kind: "failed", machine: a, message: "no" }] as const) {
      show(quiet)
      expect(host.innerHTML).toBe("")
    }
    expect(heard.cancels).toBe(0)
  })
})

/** A VNC socket that never connects: the real Screen mounts, and nothing reaches a network. */
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

interface World {
  state: "running" | "stowed"
}

const statusJson = (w: World): Record<string, unknown> => ({
  name: "demo",
  title: "Demo PC",
  closePolicy: "ask",
  operation: null,
  state: w.state,
  vmStatus: w.state === "running" ? "running" : null,
  image: "win11-arm64",
  pid: w.state === "running" ? 4242 : null,
  uptimeSeconds: 60,
  cpus: 4,
  memoryMiB: 4096,
  screen: "virtio-gpu 1280x800",
  overlayBytes: 1,
  guest: w.state === "running" ? { agent: "ok", agentVersion: "9", os: "Windows 11" } : null,
  saves: { count: 0, bytes: 0 },
  notes: [],
})

/** The app's bridge for the whole window: status from `world`, a stow the test finishes, the close commands recorded. */
function fakeApp(world: World) {
  const log: string[] = []
  const stows: ((o: { code: number; stdout: string; stderr: string }) => void)[] = []
  const listeners: ((e: { payload: unknown }) => void)[] = []
  const ok = (stdout: unknown) => ({ code: 0, stdout: JSON.stringify(stdout), stderr: "" })
  const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
    if (cmd !== "winvm") {
      log.push(cmd)
      return Promise.resolve(cmd === "close_pending" ? false : null)
    }
    const args = a?.args ?? []
    if (args[0] === "status") return Promise.resolve(ok(args.includes("-i") ? statusJson(world) : { instances: [statusJson(world)] }))
    if (args[0] === "open") return Promise.resolve(ok({ display: 1, vncPort: 5901, websocketPort: 5701, password: null }))
    log.push(`winvm ${args.join(" ")}`)
    if (args[0] === "stow") return new Promise((resolve) => stows.push(resolve))
    return Promise.resolve({ code: 1, stdout: "", stderr: "" })
  }
  const listen = (name: string, cb: (e: { payload: unknown }) => void): Promise<() => void> => {
    if (name === "viewer-close-requested") listeners.push(cb)
    return Promise.resolve(() => undefined)
  }
  Object.assign(window, { __TAURI__: { core: { invoke }, event: { listen, emit: () => Promise.resolve() } } })
  return {
    log,
    stows,
    requestClose: (): void => {
      for (const cb of listeners) cb({ payload: null })
    },
  }
}

describe("closing the window", () => {
  const flush = async (): Promise<void> => {
    await act(async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve()
    })
  }

  async function mountApp(world: World): Promise<{ host: HTMLElement; app: ReturnType<typeof fakeApp> }> {
    Object.assign(globalThis, { WebSocket: QuietSocket })
    const { App } = await import("../ui/src/App")
    const app = fakeApp(world)
    const host = document.createElement("div")
    document.body.append(host)
    const r = createRoot(host)
    root = r
    act(() => r.render(<App />))
    await flush()
    await flush()
    return { host, app }
  }

  it("asks in the window, then covers the display with the one operation overlay while Windows stows, and exits once it has", async () => {
    const world: World = { state: "running" }
    const { host, app } = await mountApp(world)
    expect(dialog(host)).toBeNull()

    act(() => app.requestClose())
    await flush()
    expect(app.log.filter((l) => l === "close_start")).toHaveLength(1)
    expect(dialog(host)?.textContent).toContain("Demo PC")

    act(() => buttonNamed(host, copy("close.stow")).click())
    await flush()
    expect(app.log).toContain("winvm stow -i demo")
    // The dialog has gone; the display's own overlay, the only one, says what is happening.
    expect(dialog(host)).toBeNull()
    const overlays = host.querySelectorAll(".display__operation")
    expect(overlays).toHaveLength(1)
    expect(overlays[0]?.textContent).toBe(copy("operation.stow"))
    expect(app.log).not.toContain("close_complete")

    world.state = "stowed"
    act(() => app.stows[0]?.({ code: 0, stdout: "", stderr: "" }))
    await flush()
    await flush()
    expect(app.log.filter((l) => l === "close_complete")).toHaveLength(1)
    expect(app.log).not.toContain("close_cancel")
  })

  it("stays open with what the stow said when it fails, and calls the close off", async () => {
    const world: World = { state: "running" }
    const { host, app } = await mountApp(world)
    act(() => app.requestClose())
    await flush()
    act(() => buttonNamed(host, copy("close.stow")).click())
    await flush()
    act(() => app.stows[0]?.({ code: 1, stdout: "", stderr: "winvm stow: the disk is full" }))
    await flush()
    await flush()
    expect(app.log).toContain("close_cancel")
    expect(app.log).not.toContain("close_complete")
    expect(dialog(host)).toBeNull()
    expect(host.querySelector(".notices")?.textContent).toContain("winvm stow: the disk is full")
    expect(host.querySelector(".notices")?.textContent).toContain(copy("close.failed"))
  })
})
