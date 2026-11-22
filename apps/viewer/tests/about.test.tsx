import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { About } = await import("../ui/src/features/about/About")
const { CONTRIBUTORS, isDevelopment, SOURCE, WEBSITE, shortBuild } =
  await import("../ui/src/features/about/details")

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

const BUILD = `sha256:${"ab12".repeat(16)}`

interface Fake {
  readonly invoked: { cmd: string; args: unknown }[]
  readonly windowCalls: string[]
}

function fakeTauri(answers: {
  readonly winvm?: (args: readonly string[]) => unknown
  readonly installedCli?: () => unknown
}): Fake {
  const fake: Fake = { invoked: [], windowCalls: [] }
  const invoke = (cmd: string, args: unknown): Promise<unknown> => {
    fake.invoked.push({ cmd, args })
    if (cmd === "winvm") {
      const answer = answers.winvm?.((args as { args: string[] }).args)
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer)
    }
    if (cmd === "installed_cli") {
      const answer = answers.installedCli?.() ?? null
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer)
    }
    return Promise.resolve(null)
  }
  const getCurrentWindow = (): unknown => ({
    show: () => {
      fake.windowCalls.push("show")
      return Promise.resolve()
    },
    close: () => {
      fake.windowCalls.push("close")
      return Promise.resolve()
    },
  })
  Object.assign(window, {
    __TAURI__: { core: { invoke }, window: { getCurrentWindow } },
  })
  return fake
}

const ok = (stdout: unknown): unknown => ({
  code: 0,
  stdout: JSON.stringify(stdout),
  stderr: "",
})

const everything = {
  winvm: (args: readonly string[]): unknown =>
    args[0] === "version"
      ? ok({ version: "0.1.4", build: BUILD, runtime: "11.1.2-2" })
      : ok({ images: [], instances: [{ name: "a" }, { name: "b" }] }),
  installedCli: (): unknown => "~/.local/bin/winvm",
}

async function mount(version: string): Promise<HTMLElement> {
  const host = document.createElement("div")
  document.body.append(host)
  const r = createRoot(host)
  root = r
  act(() => {
    r.render(<About version={version} />)
  })
  await settle()
  return host
}

const rows = (host: HTMLElement): [string, string][] =>
  [...host.querySelectorAll(".about__detail")].map((row) => [
    row.querySelector("dt")?.textContent ?? "",
    row.querySelector("dd")?.textContent ?? "",
  ])

describe("the About window", () => {
  it("names winvm and its version, links, details and contributors, in that order", async () => {
    fakeTauri(everything)
    const host = await mount("0.1.4")
    expect(host.querySelector("h1")?.textContent).toBe("winvm")
    expect(host.querySelector(".about__version")?.textContent).toBe(
      "Version 0.1.4",
    )
    expect(
      [...host.querySelectorAll("a")].map((a) => [
        a.textContent,
        a.getAttribute("href"),
      ]),
    ).toEqual([
      ["Website", WEBSITE],
      ["GitHub", SOURCE],
      ["stuffbucket", "https://github.com/stuffbucket"],
    ])
    expect(rows(host)).toEqual([
      ["Windows runtime", "11.1.2-2"],
      ["Command line tool", "~/.local/bin/winvm"],
      ["Windows machines", "2"],
      ["Build", "ab12ab12ab12"],
    ])
    expect(host.querySelector(".about__label")?.textContent).toBe(
      "Contributors",
    )
  })

  it("calls a build with the placeholder version a development build", async () => {
    fakeTauri(everything)
    const host = await mount("0.0.0")
    expect(host.querySelector(".about__version")?.textContent).toBe(
      "Development build",
    )
  })

  it("shows itself without waiting for its details, which show a dash until they come", async () => {
    let answer: (v: unknown) => void = () => undefined
    const pending = new Promise((r) => {
      answer = r
    })
    const fake = fakeTauri({})
    const invoke = (cmd: string): Promise<unknown> =>
      cmd === "winvm" || cmd === "installed_cli" ? pending : Promise.resolve()
    Object.assign(
      (window as unknown as { __TAURI__: { core: object } }).__TAURI__.core,
      { invoke },
    )
    const host = await mount("0.1.4")
    expect(fake.windowCalls).toEqual(["show"])
    expect(rows(host).map(([, v]) => v)).toEqual(["—", "—", "—", "—"])
    answer(null)
    await settle()
  })

  it("shows a dash for what it can't read, and says when the command line tool isn't installed", async () => {
    fakeTauri({
      winvm: (args) =>
        args[0] === "version"
          ? { code: 2, stdout: "", stderr: "unknown command" }
          : new Error("helper missing"),
      installedCli: () => null,
    })
    const host = await mount("0.1.4")
    expect(rows(host)).toEqual([
      ["Windows runtime", "—"],
      ["Command line tool", "Not installed"],
      ["Windows machines", "—"],
      ["Build", "—"],
    ])
  })

  it("shows a dash when the command line tool can't be looked for", async () => {
    fakeTauri({ ...everything, installedCli: () => new Error("no HOME") })
    const host = await mount("0.1.4")
    expect(rows(host)[1]).toEqual(["Command line tool", "—"])
  })

  it("opens its links through the app, not in the window", async () => {
    const fake = fakeTauri(everything)
    const host = await mount("0.1.4")
    const links = [...host.querySelectorAll("a")]
    for (const link of links) {
      const click = new MouseEvent("click", { bubbles: true, cancelable: true })
      act(() => {
        link.dispatchEvent(click)
      })
      expect(click.defaultPrevented).toBe(true)
    }
    expect(
      fake.invoked.filter((i) => i.cmd === "open_link").map((i) => i.args),
    ).toEqual([
      { url: WEBSITE },
      { url: SOURCE },
      { url: "https://github.com/stuffbucket" },
    ])
  })

  it("closes on Escape and on its close button", async () => {
    const fake = fakeTauri(everything)
    const host = await mount("0.1.4")
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      )
    })
    const close = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Close"]',
    )
    if (close === null) throw new Error("no close button")
    act(() => {
      close.click()
    })
    expect(fake.windowCalls).toEqual(["show", "close", "close"])
  })

  it("is a drag region everywhere but its links and button", async () => {
    fakeTauri(everything)
    const host = await mount("0.1.4")
    expect(
      host
        .querySelector('[role="dialog"]')
        ?.getAttribute("data-tauri-drag-region"),
    ).toBe("deep")
  })
})

describe("the About window's links", () => {
  it("are the ones the app agrees to open", () => {
    const rust = readFileSync(
      resolve(import.meta.dir, "..", "src-tauri", "src", "about.rs"),
      "utf8",
    )
    const list = /const LINKS: &\[&str\] = &\[([^\]]*)\]/.exec(rust)?.[1] ?? ""
    const allowed = Array.from(list.matchAll(/"([^"]+)"/g), (m) => m[1] ?? "")
    expect(allowed).toEqual([
      WEBSITE,
      SOURCE,
      ...CONTRIBUTORS.map((c) => c.url),
    ])
  })

  it("shortens a build to its first twelve hex digits", () => {
    expect(shortBuild(BUILD)).toBe("ab12ab12ab12")
  })
})

describe("the checked-in app version", () => {
  it("is the placeholder About calls a development build, which a release replaces", () => {
    const conf = JSON.parse(
      readFileSync(
        resolve(import.meta.dir, "..", "src-tauri", "tauri.conf.json"),
        "utf8",
      ),
    ) as { version: string }
    expect(conf.version).toBe("0.0.0")
    expect(isDevelopment(conf.version)).toBe(true)
    expect(isDevelopment("0.1.4")).toBe(false)
  })
})
