/**
 * The Windows machines menu and its flows, rendered in happy-dom: the Menu
 * wrapper over Base UI, the picker's states, New Machine…'s checks and
 * Delete…'s text and Keep checkpoints. And the pure rules under them.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { MenuGroup, MenuItem, MenuRadioGroup, MenuRadioItem, MenuRoot, MenuSeparator } = await import("../ui/src/components/Menu")
const { MachinePicker } = await import("../ui/src/features/machines/MachinePicker")
const { NewMachineDialog } = await import("../ui/src/features/machines/NewMachineDialog")
const { DeleteMachineBody } = await import("../ui/src/features/machines/DeleteMachine")
const machines = await import("../ui/src/features/machines/machines")
const { isValidInstanceName } = await import("../../../packages/core/src/args")

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

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** Open a Base UI menu from its trigger, as the keyboard does. */
async function open(trigger: HTMLElement): Promise<HTMLElement> {
  act(() => trigger.focus())
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
  })
  await flush()
  const menu = document.querySelector<HTMLElement>('[role="menu"]')
  if (menu === null) throw new Error("the menu did not open")
  return menu
}

const items = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')]
const click = (el: HTMLElement): void =>
  act(() => {
    el.click()
  })

describe("Menu (the Base UI wrapper)", () => {
  it("opens from its trigger with a heading, a check on the chosen item, and items that act", async () => {
    const chose: string[] = []
    const acted: string[] = []
    render(
      <MenuRoot trigger={<button type="button">Open</button>} label="Things">
        <MenuGroup label="Things">
          <MenuRadioGroup value="b" onValueChange={(v: unknown) => chose.push(String(v))}>
            <MenuRadioItem value="a" closeOnClick trailing="Off">
              A
            </MenuRadioItem>
            <MenuRadioItem value="b" closeOnClick trailing="On">
              B
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => acted.push("new")}>New</MenuItem>
      </MenuRoot>,
    )
    const trigger = document.querySelector("button") as HTMLElement
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu")
    const menu = await open(trigger)
    expect(menu.textContent).toContain("Things")
    expect(document.querySelector('[role="separator"]')).not.toBeNull()
    const [a, b, n] = items()
    expect(a?.getAttribute("aria-checked")).toBe("false")
    expect(b?.getAttribute("aria-checked")).toBe("true")
    expect(a?.textContent).toContain("Off")
    click(a as HTMLElement)
    expect(chose).toEqual(["a"])
    await flush()
    await open(trigger)
    click(items()[2] ?? (n as HTMLElement))
    expect(acted).toEqual(["new"])
  })
})

const noop = (): void => undefined
const pickerProps = {
  names: ["polish-a", "polish-b", "polish-c"],
  name: "polish-a",
  titles: { "polish-b": "Build box" } as Record<string, string | null>,
  phases: { "polish-b": "stopped", "polish-c": "stowed" } as const,
  phase: "running" as const,
  renaming: false,
  onRenamed: noop,
  onSelect: noop,
  onNew: noop,
  onRename: noop,
  onDelete: noop,
}

describe("the machine picker", () => {
  it("is one trigger: a computer, the name and a chevron, labelled Windows machine", () => {
    render(<MachinePicker {...pickerProps} />)
    const trigger = document.querySelector(".machine-picker") as HTMLElement
    expect(trigger.getAttribute("title")).toBe("Windows machine")
    expect(trigger.textContent).toBe("polish-a")
    expect(trigger.querySelectorAll("svg")).toHaveLength(2)
  })

  it("lists every machine by title with its state, checks this one, then New, Rename and Delete", async () => {
    const picked: string[] = []
    let deleting = 0
    render(<MachinePicker {...pickerProps} onSelect={(n) => picked.push(n)} onDelete={() => (deleting += 1)} />)
    const menu = await open(document.querySelector(".machine-picker") as HTMLElement)
    expect(menu.textContent).toContain("Windows machines")
    const rows = items().map((i) => i.textContent)
    expect(rows).toEqual(["polish-aRunning", "Build boxStopped", "polish-cSaved", "New Machine…", "Rename…", "Delete “polish-a”…"])
    expect(items()[0]?.getAttribute("aria-checked")).toBe("true")
    click(items()[1] as HTMLElement)
    expect(picked).toEqual(["polish-b"])
    await flush()
    await open(document.querySelector(".machine-picker") as HTMLElement)
    click(items()[5] as HTMLElement)
    expect(deleting).toBe(1)
  })

  it("still opens with one machine, so New Machine… is always there", async () => {
    let made = 0
    render(<MachinePicker {...pickerProps} names={["polish-a"]} onNew={() => (made += 1)} />)
    await open(document.querySelector(".machine-picker") as HTMLElement)
    const create = items().find((i) => i.textContent === "New Machine…") as HTMLElement
    click(create)
    expect(made).toBe(1)
  })

  it("edits the title in place while renaming", () => {
    render(<MachinePicker {...pickerProps} renaming />)
    expect(document.querySelector(".machine-picker")).toBeNull()
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("polish-a")
  })
})

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
    set?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("New Machine…", () => {
  const show = (onCreate: (m: { name: string; image: string | null; start: boolean }) => void): void => {
    render(<NewMachineDialog open names={["polish-a"]} images={["win11-arm64", "win11-arm64-v2"]} busy={false} error={null} onCreate={onCreate} onCancel={noop} />)
  }
  const create = (): HTMLButtonElement => document.querySelector('button[type="submit"]') as HTMLButtonElement

  it("checks the name as the CLI does, and says why it can't be used", () => {
    show(noop)
    const name = document.querySelector('input[name="name"]') as HTMLInputElement
    expect(create().disabled).toBe(true)
    type(name, "bad name")
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("letters, digits")
    expect(create().disabled).toBe(true)
    type(name, "Polish-A")
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("already a machine")
    type(name, "polish-new")
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(create().disabled).toBe(false)
  })

  it("creates with the first image and starts it, unless Advanced says otherwise", () => {
    const made: { name: string; image: string | null; start: boolean }[] = []
    show((m) => made.push(m))
    type(document.querySelector('input[name="name"]') as HTMLInputElement, " polish-new ")
    click(create())
    expect(made).toEqual([{ name: "polish-new", image: "win11-arm64", start: true }])
    act(() => {
      const image = document.querySelector('select[name="image"]') as HTMLSelectElement
      image.value = "win11-arm64-v2"
      image.dispatchEvent(new Event("change", { bubbles: true }))
    })
    click(document.querySelector('input[name="start"]') as HTMLInputElement)
    click(create())
    expect(made[1]).toEqual({ name: "polish-new", image: "win11-arm64-v2", start: false })
  })
})

describe("Delete…", () => {
  it("says what goes, that a running machine is turned off first, and keeps saves when asked", () => {
    const kept: boolean[] = []
    render(<DeleteMachineBody deleting={{ name: "polish-a", title: "Build box", live: true }} keepSaves={false} busy={false} onKeepSaves={(k) => kept.push(k)} />)
    const text = document.body.textContent ?? ""
    expect(text).toContain("deletes Build box's disk")
    expect(text).toContain("Its checkpoints go too, unless you keep them")
    expect(text).toContain("turned off first")
    click(document.querySelector('input[name="keep-saves"]') as HTMLInputElement)
    expect(kept).toEqual([true])
  })

  it("leaves out the running note for a stopped machine", () => {
    render(<DeleteMachineBody deleting={{ name: "polish-a", title: "polish-a", live: false }} keepSaves busy={false} onKeepSaves={noop} />)
    expect(document.body.textContent).not.toContain("turned off first")
    expect((document.querySelector('input[name="keep-saves"]') as HTMLInputElement).checked).toBe(true)
  })
})

describe("the machine rules", () => {
  it("take the names the CLI takes, and no taken one", () => {
    for (const n of ["polish-new", "a", "demo_2", "x.y", "", " ", "bad name", "-i", ".x", "a/b", "x".repeat(65)]) {
      const ok = machines.nameProblem(n, []) === null
      expect(ok).toBe(n.trim() !== "" && isValidInstanceName(n.trim()))
    }
    expect(machines.nameProblem("", [])).toBe("empty")
    expect(machines.nameProblem("Demo", ["demo"])).toBe("taken")
  })

  it("run winvm create and destroy with the flags chosen", () => {
    expect(machines.createArgs("polish-new", null)).toEqual(["create", "-i", "polish-new"])
    expect(machines.createArgs("polish-new", "win11-arm64")).toEqual(["create", "-i", "polish-new", "--image", "win11-arm64"])
    expect(machines.destroyArgs("polish-a", false)).toEqual(["destroy", "-i", "polish-a"])
    expect(machines.destroyArgs("polish-a", true)).toEqual(["destroy", "-i", "polish-a", "--keep-saves"])
  })

  it("read the images from winvm ls --json, and pick the next machine after a delete", () => {
    expect(machines.parseImages('{"images":[{"name":"win11-arm64","snapshots":true}],"instances":[]}')).toEqual(["win11-arm64"])
    expect(machines.parseImages("state: ~/.local/state/winvm")).toEqual([])
    expect(machines.nextAfterDelete(["a", "b", "c"], "b")).toBe("c")
    expect(machines.nextAfterDelete(["a", "b", "c"], "c")).toBe("b")
    expect(machines.nextAfterDelete(["a"], "a")).toBeNull()
    expect(machines.isLive("paused")).toBe(true)
    expect(machines.isLive("stowed")).toBe(false)
  })
})
