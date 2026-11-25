import { userEvent } from "storybook/test"

interface AppWindow extends Window {
  __fakeMenu?: (id: string) => void
  __fakeScreen?: () => boolean
  __paintDesktop?: (
    g: CanvasRenderingContext2D | null,
    width: number,
    height: number,
    name: string,
  ) => void
}

export interface App {
  readonly win: AppWindow
  readonly doc: Document
}

const POLL_MS = 50
const TIMEOUT_MS = 20_000
const SETTLE_MS = 400

export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

async function until<T>(
  probe: () => T | null | undefined | false,
  what: string,
): Promise<T> {
  const started = Date.now()
  for (;;) {
    const found = probe()
    if (found !== null && found !== undefined && found !== false) return found
    if (Date.now() - started > TIMEOUT_MS)
      throw new Error(`timed out waiting for ${what}`)
    await pause(POLL_MS)
  }
}

export async function appIn(canvas: HTMLElement, ready: string): Promise<App> {
  const frame = await until(
    () => canvas.querySelector("iframe"),
    "the window iframe",
  )
  const doc = await until(() => {
    const d = frame.contentDocument
    return d?.readyState === "complete" && d.querySelector(ready) !== null
      ? d
      : null
  }, ready)
  const win: AppWindow = await until(() => frame.contentWindow, "the window")
  await pause(SETTLE_MS)
  return { win, doc }
}

export async function menu(app: App, id: string): Promise<void> {
  await until(() => app.win.__fakeMenu, "the fake menu")
  app.win.__fakeMenu?.(id)
  await pause(SETTLE_MS)
}

export async function liveScreen(app: App): Promise<void> {
  await until(() => app.win.__fakeScreen?.() === true, "the display")
  await pause(SETTLE_MS)
}

const DESKTOP = { width: 1920, height: 1200 }

export async function paintedScreen(app: App): Promise<void> {
  const target = await until(
    () => app.doc.querySelector(".screen__canvas"),
    "the screen canvas",
  )
  const canvas = app.doc.createElement("canvas")
  canvas.width = DESKTOP.width
  canvas.height = DESKTOP.height
  canvas.style.width = "100%"
  canvas.style.height = "100%"
  app.win.__paintDesktop?.(
    canvas.getContext("2d"),
    DESKTOP.width,
    DESKTOP.height,
    "Work PC",
  )
  target.replaceChildren(canvas)
  app.doc.querySelector(".screen__message")?.remove()
  await pause(SETTLE_MS)
}

const named = (el: Element): string =>
  (el.getAttribute("aria-label") ?? el.textContent).trim()

const matches = (text: string, name: string | RegExp): boolean =>
  typeof name === "string" ? text === name : name.test(text)

export async function press(app: App, name: string | RegExp): Promise<void> {
  const button = await until(
    () =>
      [...app.doc.querySelectorAll("button")].find((b) =>
        matches(named(b), name),
      ),
    `the ${String(name)} button`,
  )
  await userEvent.click(button)
  await pause(SETTLE_MS)
}

export async function clickText(app: App, text: string): Promise<void> {
  const found = await until(
    () =>
      [...app.doc.querySelectorAll<HTMLElement>("body *")].find(
        (el) => el.children.length === 0 && el.textContent.trim() === text,
      ),
    text,
  )
  await userEvent.click(found)
  await pause(SETTLE_MS)
}

export async function keys(app: App, text: string): Promise<void> {
  await userEvent.setup({ document: app.doc }).keyboard(text)
  await pause(SETTLE_MS)
}

export async function clickOn(app: App, selector: string): Promise<void> {
  await userEvent.click(
    await until(() => app.doc.querySelector(selector), selector),
  )
  await pause(SETTLE_MS)
}

export async function waitFor(app: App, selector: string): Promise<Element> {
  const found = await until(() => app.doc.querySelector(selector), selector)
  await pause(SETTLE_MS)
  return found
}
