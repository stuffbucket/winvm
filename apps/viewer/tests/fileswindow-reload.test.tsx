import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { FilesWindow } = await import("../ui/src/features/files/FilesWindow")

type Root = ReturnType<typeof createRoot>
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  delete (window as { __TAURI__?: unknown }).__TAURI__
})
afterAll(() => GlobalRegistrator.unregister())

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

const listing = {
  path: "C:\\Users\\me\\Desktop",
  parent: "C:\\Users\\me",
  entries: [],
  total: 0,
  places: [],
}

describe("the Files window", () => {
  it("lists the folder again once a copy into it lands", async () => {
    const lists: string[] = []
    const puts: string[][] = []
    let drop: ((e: { payload: unknown }) => void) | null = null
    const invoke = (
      cmd: string,
      a?: { path?: string; args?: string[] },
    ): Promise<unknown> => {
      if (cmd === "agent_fetch" && a?.path?.startsWith("/fs/list") === true) {
        lists.push(a.path)
        return Promise.resolve({ status: 200, body: listing })
      }
      if (cmd === "winvm" && a?.args?.[0] === "put") {
        puts.push(a.args)
        return Promise.resolve({ code: 0, stdout: "", stderr: "" })
      }
      return Promise.resolve(null)
    }
    const listen = (): Promise<() => void> => Promise.resolve(() => undefined)
    Object.assign(window, {
      __TAURI__: {
        core: { invoke },
        event: { listen },
        webview: {
          getCurrentWebview: () => ({
            onDragDropEvent: (cb: (e: { payload: unknown }) => void) => {
              drop = cb
              return Promise.resolve(() => undefined)
            },
          }),
        },
      },
    })
    const host = document.createElement("div")
    document.body.append(host)
    const r = createRoot(host)
    root = r
    act(() => {
      r.render(<FilesWindow instance="demo" initialTitle={null} />)
    })
    await settle()
    const before = lists.length
    expect(before).toBeGreaterThan(0)
    act(() => {
      drop?.({ payload: { type: "drop", paths: ["/Users/me/a.txt"] } })
    })
    await settle()
    expect(puts).toHaveLength(1)
    expect(lists.length).toBeGreaterThan(before + 1)
    expect(lists.at(-1)).not.toContain("hidden")
  })
})
