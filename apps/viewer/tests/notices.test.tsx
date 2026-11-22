import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { Notices } = await import("../ui/src/features/notices/Notices")
const { RESTORED_BUSY } = await import("../ui/src/model")
const { copy } = await import("./copy")

type NoticesProps = import("../ui/src/features/notices/Notices").NoticesProps

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})
afterAll(() => GlobalRegistrator.unregister())

const ignore = (): void => undefined

const NONE: NoticesProps = {
  failure: null,
  session: null,
  closeFailed: null,
  finding: null,
  notice: null,
  copyJob: null,
  copyResult: null,
  checks: null,
  operating: false,
  statusError: null,
  onDismissFailure: ignore,
  onDismissCloseFailed: ignore,
  onDismissNotice: ignore,
  onDismissCopy: ignore,
  onReveal: ignore,
  onSetup: ignore,
}

function render(props: Partial<NoticesProps>): HTMLElement {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(<Notices {...NONE} {...props} />))
  return host
}

const titles = (host: HTMLElement): string[] =>
  [...host.querySelectorAll(".callout__title")].map((el) => el.textContent)

describe("Notices", () => {
  it("renders nothing when there is nothing to say", () => {
    expect(render({}).innerHTML).toBe("")
  })

  it("shows the Finder banner on its own", () => {
    const host = render({ finding: "Desktop" })
    expect(titles(host)).toEqual([
      copy("files.finder.opening", { place: "Desktop" }),
    ])
    expect(host.querySelector(".callout__detail")?.textContent).toBe(
      copy("files.finder.firstTime"),
    )
  })

  it("orders the banners as the main window always has", () => {
    const host = render({
      failure: { verb: "start", code: 1, output: "boom" },
      session: { kind: "missed" },
      closeFailed: { message: "stuck" },
      finding: "Desktop",
      notice: { tone: "notice", title: "A notice" },
      copyJob: { way: "in", done: 0, total: 1, name: "a.txt" },
      checks: {
        ready: false,
        timeMachine: "ok",
        checks: [{ label: "Runtime", ok: false, hint: "winvm setup" }],
      },
      statusError: "bad status",
    })
    expect(titles(host)).toEqual([
      copy("error.start"),
      copy("close.sessionTitle"),
      copy("close.failed"),
      copy("files.finder.opening", { place: "Desktop" }),
      "A notice",
      copy("files.copying", { name: "a.txt" }),
      copy("host.notReady"),
      copy("error.status"),
    ])
  })

  it("calls a restored-busy failure a notice, not an error", () => {
    const host = render({
      failure: { verb: "load", code: RESTORED_BUSY, output: "busy" },
    })
    expect(titles(host)).toEqual([copy("notice.restoredBusy")])
    expect(host.querySelector(".callout--notice")).not.toBeNull()
  })

  it("shows a copy result only once the copy has finished", () => {
    const result = { ok: false, title: copy("files.copyFailed") }
    expect(
      titles(
        render({
          copyJob: { way: "in", done: 0, total: 2, name: "a.txt" },
          copyResult: result,
        }),
      ),
    ).toEqual([copy("files.copying", { name: "a.txt" })])
    act(() => root?.unmount())
    expect(titles(render({ copyResult: result }))).toEqual([
      copy("files.copyFailed"),
    ])
  })

  it("leaves out a close failure's output when the failure already shows it", () => {
    const host = render({
      failure: { verb: "stow", code: 1, output: "same" },
      closeFailed: { message: "same" },
    })
    expect(host.querySelectorAll("pre.output")).toHaveLength(1)
  })
})
