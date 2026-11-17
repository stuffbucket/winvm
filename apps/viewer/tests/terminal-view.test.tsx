import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { TerminalTransport } from "@winvm/terminal"
import type { JSX } from "react"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { TerminalView } = await import("@winvm/terminal")
const { terminalTypography } = await import(
  "../ui/src/features/terminal/appearance"
)

type Root = ReturnType<typeof createRoot>
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})
afterAll(() => GlobalRegistrator.unregister())

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  })
}

interface Seen {
  readonly spawns: string[]
  readonly terminated: string[]
  readonly focused: string[]
}

function fakeTransport(seen: Seen, failFirstSpawn = false): TerminalTransport {
  let spawned = 0
  return {
    spawn: ({ id, shell }): Promise<void> => {
      spawned += 1
      seen.spawns.push(`${id} ${shell ?? ""}`)
      return failFirstSpawn && spawned === 1
        ? Promise.reject(new Error("no shell"))
        : Promise.resolve()
    },
    write: (): Promise<void> => Promise.resolve(),
    resize: (): Promise<void> => Promise.resolve(),
    terminate: (id: string): Promise<void> => {
      seen.terminated.push(id)
      return Promise.resolve()
    },
    focus: (id: string): Promise<void> => {
      seen.focused.push(id)
      return Promise.resolve()
    },
    subscribe: (): (() => void) => () => undefined,
  }
}

function mount(): (node: JSX.Element) => void {
  const host = document.createElement("div")
  document.body.append(host)
  const r = createRoot(host)
  root = r
  return (node) => {
    act(() => {
      r.render(node)
    })
  }
}

describe("a terminal view's session", () => {
  it("starts once per session and emulator, not when its look, folder, shell or transport object changes", async () => {
    const seen: Seen = { spawns: [], terminated: [], focused: [] }
    const show = mount()
    show(<TerminalView id="t1" shell="pwsh" transport={fakeTransport(seen)} />)
    await settle()
    expect(seen.spawns).toEqual(["t1 pwsh"])

    show(
      <TerminalView
        id="t1"
        shell="cmd"
        cwd="C:\\"
        theme={{ background: "#000000" }}
        typography={{ ...terminalTypography, fontSize: 15 }}
        transport={fakeTransport(seen)}
      />,
    )
    await settle()
    expect(seen.spawns).toEqual(["t1 pwsh"])
    expect(seen.terminated).toEqual([])

    show(<TerminalView id="t2" shell="cmd" transport={fakeTransport(seen)} />)
    await settle()
    expect(seen.spawns).toEqual(["t1 pwsh", "t2 cmd"])
    expect(seen.terminated).toEqual(["t1"])
  })

  it("starts again when Retry is pressed after a start that failed", async () => {
    const seen: Seen = { spawns: [], terminated: [], focused: [] }
    const show = mount()
    const transport = fakeTransport(seen, true)
    show(<TerminalView id="t1" shell="pwsh" transport={transport} />)
    await settle()
    const retry = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry",
    )
    if (retry === undefined) throw new Error("no Retry button")
    act(() => {
      retry.click()
    })
    await settle()
    expect(seen.spawns).toEqual(["t1 pwsh", "t1 pwsh"])
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it("renews the focus lease for the session it shows when the window regains focus", async () => {
    const seen: Seen = { spawns: [], terminated: [], focused: [] }
    const show = mount()
    const transport = fakeTransport(seen)
    show(<TerminalView id="t1" shell="pwsh" transport={transport} />)
    await settle()
    show(<TerminalView id="t2" shell="pwsh" transport={transport} />)
    await settle()
    act(() => {
      window.dispatchEvent(new Event("blur"))
      window.dispatchEvent(new Event("focus"))
    })
    await settle()
    expect(seen.focused.at(-1)).toBe("t2")
  })
})
