import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { JSX } from "react"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { SharedFolder } = await import(
  "../ui/src/features/sharedfolder/SharedFolder"
)
const folder = await import("../ui/src/features/sharedfolder/folder")
const { useSharedFolder } = await import(
  "../ui/src/features/sharedfolder/useSharedFolder"
)
const { parseSharedFolder } = await import("../ui/src/model")
type View =
  import("../ui/src/features/sharedfolder/useSharedFolder").SharedFolderView
type Status = import("../ui/src/model").SharedFolderStatus

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

const status = (over: Partial<Status> = {}): Status => ({
  available: true,
  reason: null,
  folder: null,
  letter: "Z",
  readonly: false,
  running: true,
  serving: null,
  pending: false,
  guest: { installed: true, mounted: true },
  ...over,
})

function view(over: Partial<View> = {}): View & { calls: string[] } {
  const calls: string[] = []
  return {
    status: status(),
    error: null,
    working: null,
    home: "/Users/me",
    choose: () => calls.push("choose"),
    stop: () => calls.push("stop"),
    setReadonly: (on) => calls.push(`readonly:${String(on)}`),
    install: () => calls.push("install"),
    ...over,
    calls,
  }
}

const buttons = (host: HTMLElement): string[] =>
  [...host.querySelectorAll("button")].map(
    (b) => b.getAttribute("aria-label") ?? b.textContent,
  )
const button = (label: string): HTMLButtonElement => {
  const b = [...document.querySelectorAll("button")].find(
    (x) => (x.getAttribute("aria-label") ?? x.textContent) === label,
  )
  if (b === undefined) throw new Error(`no button "${label}"`)
  return b
}

describe("the share commands", () => {
  it("name the machine and ask for JSON", () => {
    expect(folder.statusArgs("demo")).toEqual([
      "share",
      "-i",
      "demo",
      "status",
      "--json",
    ])
    expect(folder.clearArgs("demo")).toEqual([
      "share",
      "-i",
      "demo",
      "clear",
      "--json",
    ])
    expect(folder.installArgs("demo")).toEqual([
      "share",
      "-i",
      "demo",
      "install",
      "--restart",
      "--json",
    ])
  })

  it("set keeps the letter and says read-only only when it is", () => {
    expect(folder.setArgs("demo", "/Users/me/Shared", "Z", false)).toEqual([
      "share",
      "-i",
      "demo",
      "set",
      "/Users/me/Shared",
      "--letter",
      "Z",
      "--json",
    ])
    expect(folder.setArgs("demo", "/a b", "Y", true)).toEqual([
      "share",
      "-i",
      "demo",
      "set",
      "/a b",
      "--letter",
      "Y",
      "--readonly",
      "--json",
    ])
  })

  it("errors read as what follows ::error::, else everything printed", () => {
    expect(
      folder.cliError({
        code: 1,
        stdout: "",
        stderr: "::error::That folder doesn't exist.\n",
      }),
    ).toBe("That folder doesn't exist.")
    expect(
      folder.cliError({
        code: 1,
        stdout: "",
        stderr: "unknown command share\n",
      }),
    ).toBe("unknown command share")
  })
})

describe("paths", () => {
  it("show the home folder as ~", () => {
    expect(folder.homePath("/Users/me/Projects/site", "/Users/me")).toBe(
      "~/Projects/site",
    )
    expect(folder.homePath("/Users/me", "/Users/me/")).toBe("~")
    expect(folder.homePath("/Users/meg/x", "/Users/me")).toBe("/Users/meg/x")
    expect(folder.homePath("/Volumes/Work", null)).toBe("/Volumes/Work")
  })

  it("keep the last part whole when the middle gives way", () => {
    expect(folder.tailToKeep("~/Projects/site")).toBe(8)
    expect(folder.tailToKeep("~/a/Quarterly reports")).toBe(16)
    expect(folder.tailToKeep("~/a/Reports")).toBe(8)
    expect(folder.tailToKeep("~")).toBe(1)
  })
})

describe("the status", () => {
  it("parses the CLI's JSON, and nothing else", () => {
    const json = JSON.stringify(
      status({
        folder: "/Users/me/Shared",
        pending: true,
        guest: { installed: null, mounted: null },
      }),
    )
    expect(parseSharedFolder(json)?.folder).toBe("/Users/me/Shared")
    expect(parseSharedFolder("::error::no")).toBeNull()
    expect(parseSharedFolder(JSON.stringify({ available: true }))).toBeNull()
  })

  it("asks for Windows' setup only for a shared folder Windows can't show", () => {
    expect(
      folder.needsSetup(
        status({ folder: "/x", guest: { installed: false, mounted: false } }),
      ),
    ).toBe(true)
    expect(
      folder.needsSetup(
        status({ folder: null, guest: { installed: false, mounted: false } }),
      ),
    ).toBe(false)
    expect(
      folder.needsSetup(
        status({ folder: "/x", guest: { installed: null, mounted: null } }),
      ),
    ).toBe(false)
  })

  it("puts Off or the drive beside the section's title", () => {
    expect(folder.sectionHint(status())).toEqual({ key: "folder.hintOff" })
    expect(folder.sectionHint(status({ folder: "/x", letter: "Y" }))).toEqual({
      key: "folder.hintOn",
      values: { letter: "Y" },
    })
    expect(folder.sectionHint(status({ available: false }))).toBeNull()
  })
})

describe("the Shared folder section", () => {
  it("offers Choose folder… when nothing is shared", () => {
    const v = view()
    const host = render(<SharedFolder view={v} guestReady />)
    expect(host.textContent).toContain(
      "Share a folder on this Mac with Windows",
    )
    expect(buttons(host)).toEqual(["Choose folder…"])
    act(() => {
      button("Choose folder…").click()
    })
    expect(v.calls).toEqual(["choose"])
  })

  it("shows the folder under ~ and the drive Windows shows, and can stop", () => {
    const v = view({
      status: status({
        folder: "/Users/me/Projects/site",
        serving: "/Users/me/Projects/site",
      }),
    })
    const host = render(<SharedFolder view={v} guestReady />)
    expect(host.querySelector(".oneline")?.getAttribute("title")).toBe(
      "~/Projects/site",
    )
    expect(host.textContent).toContain("In File Explorer as Mac (Z:)")
    expect(buttons(host)).toEqual([
      "Show in Finder",
      "Choose folder…",
      "Stop sharing",
    ])
    act(() => {
      button("Stop sharing").click()
    })
    expect(v.calls).toEqual(["stop"])
  })

  it("says a change waits for Windows' next start", () => {
    const host = render(
      <SharedFolder
        view={view({
          status: status({
            folder: "/Users/me/New",
            serving: "/Users/me/Old",
            pending: true,
          }),
        })}
        guestReady
      />,
    )
    expect(host.textContent).toContain(
      "Windows sees this the next time it starts.",
    )
  })

  it("toggles read-only", () => {
    const v = view({ status: status({ folder: "/Users/me/Shared" }) })
    const host = render(<SharedFolder view={v} guestReady />)
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')
    act(() => box?.click())
    expect(v.calls).toEqual(["readonly:true"])
  })

  it("shows why, and no buttons, when the machine can't share", () => {
    const host = render(
      <SharedFolder
        view={view({
          status: status({
            available: false,
            reason: "This machine uses the fixed 800 × 600 display.",
          }),
        })}
        guestReady
      />,
    )
    expect(host.textContent).toBe(
      "This machine uses the fixed 800 × 600 display.",
    )
    expect(buttons(host)).toEqual([])
  })

  it("confirms the one-time setup before restarting Windows", () => {
    const v = view({
      status: status({
        folder: "/Users/me/Shared",
        guest: { installed: false, mounted: false },
      }),
    })
    render(<SharedFolder view={v} guestReady />)
    act(() => {
      button("Set up in Windows…").click()
    })
    expect(document.querySelector("dialog")?.textContent).toContain(
      "restarts Windows twice",
    )
    act(() => {
      button("Set up and restart").click()
    })
    expect(v.calls).toEqual(["install"])
  })

  it("holds the buttons while the setup runs", () => {
    const host = render(
      <SharedFolder
        view={view({
          working: "install",
          status: status({
            folder: "/Users/me/Shared",
            guest: { installed: false, mounted: false },
          }),
        })}
        guestReady
      />,
    )
    expect(host.textContent).toContain("It restarts twice")
    expect(button("Choose folder…").disabled).toBe(true)
    expect(button("Stop sharing").disabled).toBe(true)
  })

  it("never says instance", () => {
    const states: Status[] = [
      status(),
      status({ folder: "/x", pending: true }),
      status({ folder: null, pending: true }),
      status({ available: false, reason: null }),
      status({ folder: "/x", guest: { installed: false, mounted: false } }),
    ]
    for (const s of states) {
      const host = render(
        <SharedFolder view={view({ status: s })} guestReady={false} />,
      )
      expect(host.textContent.toLowerCase()).not.toContain("instance")
      act(() => root?.unmount())
      root = null
    }
  })
})

type Phase = import("../ui/src/model").Phase

interface FolderProps {
  readonly instance: string | null
  readonly phase: Phase | null
  readonly guestReady: boolean
  readonly active: boolean
  readonly slot: { current: View | null }
}

function FolderProbe({
  instance,
  phase,
  guestReady,
  active,
  slot,
}: FolderProps): null {
  slot.current = useSharedFolder(instance, phase, guestReady, active)
  return null
}

describe("useSharedFolder", () => {
  afterEach(() => {
    delete (window as { __TAURI__?: unknown }).__TAURI__
  })

  const settle = async (): Promise<void> => {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
  }

  it("reads while shown, again whenever the phase or Windows' readiness changes, not while the setup runs, and drops one machine's status for the next", async () => {
    const asked: string[] = []
    let finishInstall: (() => void) | null = null
    const answer = { code: 0, stdout: JSON.stringify(status()), stderr: "" }
    const invoke = (cmd: string, a?: { args?: string[] }): Promise<unknown> => {
      const args = a?.args ?? []
      if (cmd !== "winvm") return Promise.resolve(null)
      asked.push(args.slice(2, 4).join(" "))
      if (args[2] === "b") return new Promise(() => undefined)
      if (args[3] === "install")
        return new Promise((resolve) => {
          finishInstall = () => {
            resolve(answer)
          }
        })
      return Promise.resolve(answer)
    }
    Object.assign(window, { __TAURI__: { core: { invoke } } })
    const slot: { current: View | null } = { current: null }
    const shown = (over: Partial<FolderProps> = {}): JSX.Element => (
      <FolderProbe
        instance="a"
        phase="running"
        guestReady={false}
        active={false}
        slot={slot}
        {...over}
      />
    )
    render(shown())
    await settle()
    expect(asked).toEqual([])
    act(() => root?.render(shown({ active: true })))
    await settle()
    expect(asked).toEqual(["a status"])
    expect(slot.current?.status?.letter).toBe("Z")
    act(() => root?.render(shown({ active: true })))
    await settle()
    expect(asked).toHaveLength(1)
    act(() => root?.render(shown({ active: true, guestReady: true })))
    await settle()
    expect(asked).toEqual(["a status", "a status"])
    act(() => {
      slot.current?.install()
    })
    await settle()
    expect(asked.at(-1)).toBe("a install")
    act(() =>
      root?.render(shown({ active: true, guestReady: true, phase: "paused" })),
    )
    await settle()
    expect(asked.at(-1)).toBe("a install")
    await act(async () => {
      finishInstall?.()
      await Promise.resolve()
    })
    await settle()
    expect(asked.at(-1)).toBe("a status")
    expect(asked).toHaveLength(4)
    act(() =>
      root?.render(
        shown({
          active: true,
          guestReady: true,
          phase: "paused",
          instance: "b",
        }),
      ),
    )
    await settle()
    expect(asked.at(-1)).toBe("b status")
    expect(slot.current?.status).toBeNull()
  })
})
