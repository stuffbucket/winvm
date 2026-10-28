/**
 * The one place the UI reaches the app: Tauri commands that run winvm's own
 * CLI (the bundled sidecar) and return what it printed, plus the few things
 * only the app can do (menus, file picking and dropping, a long-running
 * `cua serve`, the Terminal window).
 */
import { type Installed, type MenuNode, type OpenRequest, parseInstalled, type Shell, shellsArgs } from "./features/terminal/shells"

export interface Output {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

type Unlisten = () => void

interface DragDrop {
  readonly payload: {
    readonly type: "enter" | "over" | "drop" | "leave"
    readonly paths?: readonly string[]
    /** Physical pixels from the webview's top left. */
    readonly position?: { readonly x: number; readonly y: number }
  }
}

interface NativeMenu {
  popup(): Promise<void>
}

interface TauriGlobal {
  readonly core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> }
  readonly window: { getCurrentWindow(): { show(): Promise<void>; setTitle(title: string): Promise<void>; close(): Promise<void> } }
  readonly menu: { readonly Menu: { "new"(options: { items: unknown[] }): Promise<NativeMenu> } }
  readonly event: {
    listen<T>(name: string, cb: (e: { payload: T }) => void): Promise<Unlisten>
    emit(name: string, payload?: unknown): Promise<void>
  }
  readonly webview: { getCurrentWebview(): { onDragDropEvent(cb: (e: DragDrop) => void): Promise<Unlisten> } }
}

function tauri(): TauriGlobal {
  const g = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
  if (g === undefined) throw new Error("this page runs inside the winvm app")
  return g
}

export const winvm = (...args: string[]): Promise<Output> => tauri().core.invoke<Output>("winvm", { args })

export const installCli = (): Promise<string> => tauri().core.invoke<string>("install_cli")

export const downloadsDir = (): Promise<string> => tauri().core.invoke<string>("downloads_dir")

/** Starts sharing the screen with an agent (`winvm cua serve`); resolves with what it printed when ready. */
export const shareStart = (instance: string): Promise<Output> => tauri().core.invoke<Output>("share_start", { instance })

export const shareStop = (): Promise<void> => tauri().core.invoke<void>("share_stop")

/** Files chosen in the open panel, or none. */
export async function pickFiles(title: string): Promise<string[]> {
  const got = await tauri().core.invoke<string[] | string | null>("plugin:dialog|open", { options: { multiple: true, directory: false, title } })
  if (got === null) return []
  return Array.isArray(got) ? got : [got]
}

/** A folder chosen in the open panel, or null. */
export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  const got = await tauri().core.invoke<string[] | string | null>("plugin:dialog|open", {
    options: { multiple: false, directory: true, canCreateDirectories: true, title, ...(defaultPath === undefined ? {} : { defaultPath }) },
  })
  return Array.isArray(got) ? (got[0] ?? null) : got
}

/** Where to save one file, from the save panel (which asks before replacing), or null. */
export const pickSavePath = (title: string, defaultPath: string): Promise<string | null> =>
  tauri().core.invoke<string | null>("plugin:dialog|save", { options: { title, defaultPath, canCreateDirectories: true } })

/** `dir/name` if free, else Finder's `name 2`, `name 3`…: a copy never replaces a Mac file. */
export const unusedPath = (dir: string, name: string, folder: boolean): Promise<string> =>
  tauri().core.invoke<string>("unused_path", { dir, name, folder })

/** Shows a Mac file or folder in Finder, selected. */
export const revealInFinder = (path: string): Promise<void> => tauri().core.invoke<void>("reveal", { path })

/** What a machine's agent answered: its HTTP status and body (JSON, or the text when it isn't). */
export interface AgentReply {
  readonly status: number
  readonly body: unknown
}

/**
 * A request to a machine's in-guest agent, made by the app directly (a few
 * ms; the CLI would cost a process start). The app asks `winvm agent connect`
 * where the agent is once, and again when it moves. Rejects only when the
 * agent can't be reached; an error status is a reply.
 */
export const agentFetch = (
  instance: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<AgentReply> => tauri().core.invoke<AgentReply>("agent_fetch", { instance, method, path, body: body ?? null, timeoutMs: timeoutMs ?? null })

function listen<T>(name: string, cb: (payload: T) => void): Unlisten {
  let unlisten: Unlisten | null = null
  let gone = false
  try {
    void tauri()
      .event.listen<T>(name, (e) => cb(e.payload))
      .then((u) => {
        if (gone) u()
        else unlisten = u
      })
  } catch {
    // not in the app
  }
  return () => {
    gone = true
    unlisten?.()
  }
}

/** App menu items the main window acts on: "install-cli", "reference", "new-terminal" and "rename-window". */
export const onMenu = (cb: (id: string) => void): Unlisten => listen<string>("menu", cb)

/** The window's edge is being dragged (true), or was let go (false). */
export const onLiveResize = (cb: (live: boolean) => void): Unlisten => listen<boolean>("live-resize", cb)

/** One sample for the meters: QEMU's CPU time and memory (`ps`), and Windows' own figures from `instance`'s agent when given. */
export const instanceUsage = (pid: number, instance: string | null): Promise<unknown> =>
  tauri().core.invoke<unknown>("instance_usage", { pid, instance })

/** A line on the app's stderr: the viewer's timings. */
export function trace(line: string): void {
  try {
    void tauri().core.invoke("trace", { line })
  } catch {
    // not in the app
  }
}

/** Which shells an instance has (`winvm terminal --shells --json`), or null if that couldn't be told. */
export async function installedShells(instance: string): Promise<Installed | null> {
  const out = await winvm(...shellsArgs(instance))
  return out.code === 0 ? parseInstalled(out.stdout) : null
}

/**
 * One tab for the Terminal window, with the shells its instance has when the
 * app knows (so the window need not ask again), and the instance's title.
 */
export interface TerminalRequest extends OpenRequest {
  readonly installed: readonly Shell[] | null
  readonly title: string | null
}

/** Opens a tab in the Terminal window, opening the window first or bringing it forward. */
export const openTerminal = (request: TerminalRequest): Promise<void> => tauri().core.invoke<void>("terminal_open", { request })

/** The tabs asked for since the Terminal window last looked. */
export const takeTerminalRequests = (): Promise<TerminalRequest[]> => tauri().core.invoke<TerminalRequest[]>("terminal_take")

/** Rung when tabs have been asked for. */
export const onTerminalOpen = (cb: () => void): Unlisten => listen<unknown>("terminal-open", () => cb())

export type TerminalMenuId = "new-tab" | "close-tab" | "rename-tab"

/** Menu items the Terminal window acts on: File's New Tab and Close, and Window's Rename Window… (its active tab). */
export const onTerminalMenu = (cb: (id: TerminalMenuId) => void): Unlisten => listen<TerminalMenuId>("terminal-menu", cb)

/** An instance's title, as every window shows it: null is its name. */
export interface InstanceTitle {
  readonly instance: string
  readonly title: string | null
}

/** Tells every window an instance's title (the main window does, when it learns or changes it). */
export function announceTitle(t: InstanceTitle): void {
  try {
    void tauri().event.emit("instance-title", t)
  } catch {
    // not in the app
  }
}

export const onInstanceTitle = (cb: (t: InstanceTitle) => void): Unlisten => listen<InstanceTitle>("instance-title", cb)

/** A plain native menu: actions, separators, and a check mark where `checked` is given. */
export type Action =
  | {
      readonly kind: "action"
      readonly label: string
      readonly enabled?: boolean
      readonly checked?: boolean
      /** Shown beside the label, e.g. "CmdOrCtrl+O"; the window's own keys do the work. */
      readonly accelerator?: string
      run(): void
    }
  | { readonly kind: "separator" }

export async function popupActions(actions: readonly Action[]): Promise<void> {
  const items = actions.map((a) => {
    if (a.kind === "separator") return { item: "Separator" }
    const base = { text: a.label, enabled: a.enabled ?? true, action: () => a.run(), ...(a.accelerator === undefined ? {} : { accelerator: a.accelerator }) }
    return a.checked === undefined ? base : { ...base, checked: a.checked }
  })
  const menu = await tauri().menu.Menu.new({ items })
  await menu.popup()
}

const menuItems = (nodes: readonly MenuNode[], pick: (node: Extract<MenuNode, { kind: "item" }>) => void): unknown[] =>
  nodes.map((n) => {
    if (n.kind === "separator") return { item: "Separator" }
    if (n.kind === "submenu") return { text: n.label, items: menuItems(n.items, pick) }
    return { text: n.label, enabled: n.enabled, action: () => pick(n) }
  })

/** A native menu's rows, each item carrying what it does. */
export type ActionNode = Action

/** Opens the instance's Files window, or brings it forward; `title` is what the instance is called. */
export const openFiles = (instance: string, title: string | null): Promise<void> => tauri().core.invoke<void>("files_open", { instance, title })

/**
 * Whether guest folders can be shown in Finder: the guest's C:\ and home folder
 * are mounted on the Mac (Windows' own file sharing, through a forwarded port;
 * `winvm files`).
 */
export const GUEST_FOLDERS_IN_FINDER = true

/** The shares `winvm files` mounts: the home folder, and the whole of C:\. */
export type GuestShare = "home" | "c"

const filesOpen = async (instance: string, ...what: string[]): Promise<void> => {
  const out = await winvm("files", "open", "-i", instance, ...what)
  if (out.code !== 0) throw new Error(outputText(out) || `winvm files open exited ${String(out.code)}`)
}

/**
 * Opens one of the guest's shares in Finder, mounting it on ~/winvm/<instance>
 * first if it is not. The first time also sets Windows up to share, which takes
 * a few seconds more.
 */
export const openShareInFinder = (instance: string, share: GuestShare): Promise<void> => filesOpen(instance, share)

/** Whether `path` is on a share Finder can show (anything on C:). */
export const inFinderReach = (path: string): boolean => /^[cC]:(\\|\/|$)/.test(path)

/** Shows a guest folder in Finder, through the share that holds it (see openShareInFinder). */
export const revealGuestPath = (instance: string, path: string): Promise<void> => filesOpen(instance, "--path", path)

/** Puts text on the Mac's clipboard. */
export const copyText = (text: string): Promise<void> => tauri().core.invoke<void>("copy_text", { text })

/** One guest file or folder a drag carries out of the window. */
export interface DragOutItem {
  readonly path: string
  readonly name: string
  readonly dir: boolean
}

/**
 * Hands a drag that left the window to macOS, as file promises: Finder (or
 * whatever takes the drop) asks for each item only once it is dropped.
 */
export const dragOut = (instance: string, items: readonly DragOutItem[]): Promise<void> =>
  tauri().core.invoke<void>("files_drag_out", { instance, items })

/** A promised file being written where Finder asked. */
export interface PromiseEvent {
  readonly state: "start" | "done" | "failed"
  readonly name: string
  readonly dest?: string | null
  readonly error?: string | null
}

export const onPromise = (cb: (e: PromiseEvent) => void): Unlisten => listen<PromiseEvent>("files-promise", cb)

/** A drag handed to macOS has ended: dropped somewhere that took it ("copy"), or not. */
export const onDragOutEnd = (cb: (e: { readonly operation: "copy" | "none" }) => void): Unlisten =>
  listen<{ operation: "copy" | "none" }>("files-drag-end", cb)

/** Files dragged over the window from the Mac, with where the pointer is in CSS pixels. */
export type HostDrag =
  | { readonly type: "enter"; readonly paths: readonly string[]; readonly at: { x: number; y: number } | null }
  | { readonly type: "over"; readonly at: { x: number; y: number } | null }
  | { readonly type: "drop"; readonly paths: readonly string[]; readonly at: { x: number; y: number } | null }
  | { readonly type: "leave" }

export function onHostDrag(cb: (e: HostDrag) => void): Unlisten {
  let unlisten: Unlisten | null = null
  let gone = false
  const css = (p: { x: number; y: number } | undefined): { x: number; y: number } | null =>
    p === undefined ? null : { x: p.x / window.devicePixelRatio, y: p.y / window.devicePixelRatio }
  try {
    void tauri()
      .webview.getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload
        if (p.type === "leave") cb({ type: "leave" })
        else if (p.type === "over") cb({ type: "over", at: css(p.position) })
        else cb({ type: p.type, paths: p.paths ?? [], at: css(p.position) })
      })
      .then((u) => {
        if (gone) u()
        else unlisten = u
      })
  } catch {
    // not in the app
  }
  return () => {
    gone = true
    unlisten?.()
  }
}

/** Shows a native menu at the pointer; `pick` gets the item chosen, if any. */
export async function popupMenu(nodes: readonly MenuNode[], pick: (node: Extract<MenuNode, { kind: "item" }>) => void): Promise<void> {
  const menu = await tauri().menu.Menu.new({ items: menuItems(nodes, pick) })
  await menu.popup()
}

export function setWindowTitle(title: string): void {
  try {
    void tauri().window.getCurrentWindow().setTitle(title)
  } catch {
    // not in the app
  }
  document.title = title
}

export function closeWindow(): void {
  try {
    void tauri().window.getCurrentWindow().close()
  } catch {
    // not in the app
  }
}

/** Files dropped on the window, and whether something is being dragged over it. */
export function onFileDrop(drop: (paths: readonly string[]) => void, hovering: (over: boolean) => void): Unlisten {
  let unlisten: Unlisten | null = null
  let gone = false
  try {
    void tauri()
      .webview.getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "drop") {
          hovering(false)
          drop(e.payload.paths ?? [])
        } else hovering(e.payload.type !== "leave")
      })
      .then((u) => {
        if (gone) u()
        else unlisten = u
      })
  } catch {
    // not in the app
  }
  return () => {
    gone = true
    unlisten?.()
  }
}

/** The window opens hidden and is shown once the first frame is drawn. */
export function showWindow(): void {
  try {
    void tauri().window.getCurrentWindow().show()
  } catch {
    // not in the app
  }
}

/** What a command said, for its output or a failure's details. */
export const outputText = (o: Output): string => [o.stdout, o.stderr].filter((s) => s.trim() !== "").join("\n").trim()
