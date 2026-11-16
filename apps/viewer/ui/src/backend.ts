import {
  connectArgs,
  type Endpoint,
  failureText,
  type Installed,
  type MenuNode,
  type OpenRequest,
  parseEndpoint,
  parseInstalled,
  type Shell,
  shellsArgs,
} from "./features/terminal/shells"
import { t } from "./i18n"

type SidecarFailureKind = "missing" | "launch" | "timeout" | "exit"

export interface SidecarFailure {
  readonly kind: SidecarFailureKind
  readonly operation: string
  readonly message: string
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
  readonly signal: number | null
  readonly timeoutMs: number | null
  readonly detail: string | null
}

export interface Output {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly failure?: SidecarFailure
}

const KINDS: readonly string[] = [
  "missing",
  "launch",
  "timeout",
  "exit",
] satisfies readonly SidecarFailureKind[]
const isKind = (k: unknown): k is SidecarFailureKind =>
  typeof k === "string" && KINDS.includes(k)
const text = (v: unknown): string => (typeof v === "string" ? v : "")
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null
const NOT_FOUND = /No such file or directory|os error 2\b|ENOENT/i

function described(raw: unknown): string {
  try {
    const json: unknown = JSON.stringify(raw)
    return typeof json === "string" ? json : String(raw)
  } catch {
    return String(raw)
  }
}

export function normalizeSidecarFailure(
  raw: unknown,
  operation = "winvm",
): SidecarFailure {
  const none = {
    operation,
    stdout: "",
    stderr: "",
    code: null,
    signal: null,
    timeoutMs: null,
  } as const
  if (typeof raw === "string")
    return {
      ...none,
      kind: NOT_FOUND.test(raw) ? "missing" : "launch",
      message: raw,
      detail: raw,
    }
  if (raw instanceof Error)
    return {
      ...none,
      kind: "launch",
      message: raw.message,
      detail: raw.message,
    }
  if (typeof raw === "object" && raw !== null) {
    const o = raw as Record<string, unknown>
    return {
      kind: isKind(o.kind) ? o.kind : "launch",
      operation: text(o.operation) || operation,
      message: text(o.message) || described(raw),
      stdout: text(o.stdout),
      stderr: text(o.stderr),
      code: count(o.code),
      signal: count(o.signal),
      timeoutMs: count(o.timeoutMs),
      detail: typeof o.detail === "string" ? o.detail : null,
    }
  }
  return { ...none, kind: "launch", message: String(raw), detail: null }
}

function sidecarCopy(f: SidecarFailure): string {
  switch (f.kind) {
    case "missing":
      return t("sidecar.missing")
    case "launch":
      return t("sidecar.launch", {
        operation: f.operation,
        detail: f.detail ?? f.message,
      })
    case "timeout":
      return t("sidecar.timeout", {
        operation: f.operation,
        seconds: (f.timeoutMs ?? 0) / 1000,
      })
    case "exit":
      return failureText(f.stdout, f.stderr) || f.message
  }
}

export class SidecarError extends Error {
  readonly failure: SidecarFailure
  constructor(failure: SidecarFailure) {
    super(sidecarCopy(failure))
    this.failure = failure
  }
}

export const isSidecarError = (e: unknown): e is SidecarError =>
  e instanceof SidecarError

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  return sidecarCopy(normalizeSidecarFailure(e))
}

async function sidecar(
  cmd: string,
  payload: Record<string, unknown>,
  operation: string,
): Promise<Output> {
  const core = tauri().core
  try {
    return await core.invoke<Output>(cmd, payload)
  } catch (raw) {
    const failure = normalizeSidecarFailure(raw, operation)
    if (failure.kind === "exit")
      return {
        code: failure.code ?? -1,
        stdout: failure.stdout,
        stderr: failure.stderr,
        failure,
      }
    throw new SidecarError(failure)
  }
}

type Unlisten = () => void

interface DragDrop {
  readonly payload: {
    readonly type: "enter" | "over" | "drop" | "leave"
    readonly paths?: readonly string[]
    readonly position?: { readonly x: number; readonly y: number }
  }
}

interface NativeMenu {
  popup(): Promise<void>
}

interface TauriGlobal {
  readonly core: {
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
  }
  readonly window: {
    getCurrentWindow(): {
      show(): Promise<void>
      setTitle(title: string): Promise<void>
      close(): Promise<void>
    }
  }
  readonly menu: {
    readonly Menu: { "new"(options: { items: unknown[] }): Promise<NativeMenu> }
  }
  readonly event: {
    listen(
      name: string,
      cb: (e: { payload: unknown }) => void,
    ): Promise<Unlisten>
    emit(name: string, payload?: unknown): Promise<void>
  }
  readonly webview: {
    getCurrentWebview(): {
      onDragDropEvent(cb: (e: DragDrop) => void): Promise<Unlisten>
    }
  }
}

function tauri(): TauriGlobal {
  const g = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
  if (g === undefined) throw new Error("this page runs inside the winvm app")
  return g
}

export const winvm = (...args: string[]): Promise<Output> =>
  sidecar("winvm", { args }, args[0] ?? "winvm")

export const installCli = (): Promise<string> =>
  tauri().core.invoke<string>("install_cli")

export const downloadsDir = (): Promise<string> =>
  tauri().core.invoke<string>("downloads_dir")

export const shareStart = (instance: string): Promise<Output> =>
  sidecar("share_start", { instance }, "cua serve")

export const shareStop = (): Promise<void> =>
  tauri().core.invoke<void>("share_stop")

export async function pickFiles(title: string): Promise<string[]> {
  const got = await tauri().core.invoke<string[] | string | null>(
    "plugin:dialog|open",
    { options: { multiple: true, directory: false, title } },
  )
  if (got === null) return []
  return Array.isArray(got) ? got : [got]
}

export async function pickFolder(
  title: string,
  defaultPath?: string,
): Promise<string | null> {
  const got = await tauri().core.invoke<string[] | string | null>(
    "plugin:dialog|open",
    {
      options: {
        multiple: false,
        directory: true,
        canCreateDirectories: true,
        title,
        ...(defaultPath === undefined ? {} : { defaultPath }),
      },
    },
  )
  return Array.isArray(got) ? (got[0] ?? null) : got
}

export const pickSavePath = (
  title: string,
  defaultPath: string,
): Promise<string | null> =>
  tauri().core.invoke<string | null>("plugin:dialog|save", {
    options: { title, defaultPath, canCreateDirectories: true },
  })

export const unusedPath = (
  dir: string,
  name: string,
  folder: boolean,
): Promise<string> =>
  tauri().core.invoke<string>("unused_path", { dir, name, folder })

export const revealInFinder = (path: string): Promise<void> =>
  tauri().core.invoke<void>("reveal", { path })

export interface AgentReply {
  readonly status: number
  readonly body: unknown
}

export const agentFetch = (
  instance: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<AgentReply> =>
  tauri().core.invoke<AgentReply>("agent_fetch", {
    instance,
    method,
    path,
    body: body ?? null,
    timeoutMs: timeoutMs ?? null,
  })

function listen(
  name: string,
  cb: (payload: unknown) => void,
  ready?: () => void,
): Unlisten {
  let unlisten: Unlisten | null = null
  let gone = false
  try {
    void tauri()
      .event.listen(name, (e) => {
        cb(e.payload)
      })
      .then(
        (u) => {
          if (gone) u()
          else unlisten = u
          ready?.()
        },
        () => ready?.(),
      )
  } catch {}
  return () => {
    gone = true
    unlisten?.()
  }
}

export const onMenu = (cb: (id: string) => void): Unlisten =>
  listen("menu", (id) => {
    cb(id as string)
  })

export const onViewerCloseRequested = (
  cb: () => void,
  listening?: () => void,
): Unlisten =>
  listen(
    "viewer-close-requested",
    () => {
      cb()
    },
    listening,
  )

export const closePending = (): Promise<boolean> =>
  tauri().core.invoke<boolean>("close_pending")

export const closeStart = (): Promise<void> =>
  tauri().core.invoke<void>("close_start")

export const closeCancel = (): Promise<void> =>
  tauri().core.invoke<void>("close_cancel")

export const closeComplete = (): Promise<void> =>
  tauri().core.invoke<void>("close_complete")

export const setSystemKeyboardCapture = (captured: boolean): Promise<void> =>
  tauri().core.invoke<void>("set_system_keyboard_capture", { captured })

export const onLiveResize = (cb: (live: boolean) => void): Unlisten =>
  listen("live-resize", (live) => {
    cb(live as boolean)
  })

export const instanceUsage = (
  pid: number,
  instance: string | null,
): Promise<unknown> =>
  tauri().core.invoke<unknown>("instance_usage", { pid, instance })

export function trace(line: string): void {
  try {
    void tauri().core.invoke("trace", { line })
  } catch {}
}

export async function installedShells(
  instance: string,
): Promise<Installed | null> {
  const out = await winvm(...shellsArgs(instance))
  return out.code === 0 ? parseInstalled(out.stdout) : null
}

export async function terminalEndpoint(
  request: OpenRequest,
): Promise<Endpoint> {
  const out = await winvm(...connectArgs(request))
  const endpoint = out.code === 0 ? parseEndpoint(out.stdout) : null
  if (endpoint === null)
    throw new Error(
      failureText(out.stdout, out.stderr) ||
        "winvm terminal didn't say where to connect",
    )
  return endpoint
}

export interface TerminalRequest extends OpenRequest {
  readonly installed: readonly Shell[] | null
  readonly title: string | null
}

export const openTerminal = (request: TerminalRequest): Promise<void> =>
  tauri().core.invoke<void>("terminal_open", { request })

export const takeTerminalRequests = (): Promise<TerminalRequest[]> =>
  tauri().core.invoke<TerminalRequest[]>("terminal_take")

export const onTerminalOpen = (cb: () => void): Unlisten =>
  listen("terminal-open", () => {
    cb()
  })

export type TerminalMenuId = "new-tab" | "close-tab" | "rename-tab"

export const onTerminalMenu = (cb: (id: TerminalMenuId) => void): Unlisten =>
  listen("terminal-menu", (id) => {
    cb(id as TerminalMenuId)
  })

export interface InstanceTitle {
  readonly instance: string
  readonly title: string | null
}

export function announceTitle(t: InstanceTitle): void {
  try {
    void tauri().event.emit("instance-title", t)
  } catch {}
}

export const onInstanceTitle = (cb: (t: InstanceTitle) => void): Unlisten =>
  listen("instance-title", (t) => {
    cb(t as InstanceTitle)
  })

export type Action =
  | {
      readonly kind: "action"
      readonly label: string
      readonly enabled?: boolean
      readonly checked?: boolean
      readonly accelerator?: string
      run(): void
    }
  | { readonly kind: "separator" }

export async function popupActions(actions: readonly Action[]): Promise<void> {
  const items = actions.map((a) => {
    if (a.kind === "separator") return { item: "Separator" }
    const base = {
      text: a.label,
      enabled: a.enabled ?? true,
      action: () => {
        a.run()
      },
      ...(a.accelerator === undefined ? {} : { accelerator: a.accelerator }),
    }
    return a.checked === undefined ? base : { ...base, checked: a.checked }
  })
  const menu = await tauri().menu.Menu.new({ items })
  await menu.popup()
}

const menuItems = (
  nodes: readonly MenuNode[],
  pick: (node: Extract<MenuNode, { kind: "item" }>) => void,
): unknown[] =>
  nodes.map((n) => {
    if (n.kind === "separator") return { item: "Separator" }
    if (n.kind === "submenu")
      return { text: n.label, items: menuItems(n.items, pick) }
    return {
      text: n.label,
      enabled: n.enabled,
      action: () => {
        pick(n)
      },
    }
  })

export const openFiles = (
  instance: string,
  title: string | null,
): Promise<void> => tauri().core.invoke<void>("files_open", { instance, title })

export const GUEST_FOLDERS_IN_FINDER: boolean = true

export type GuestShare = "home" | "c"

const filesOpen = async (
  instance: string,
  ...what: string[]
): Promise<void> => {
  const out = await winvm("files", "open", "-i", instance, ...what)
  if (out.code !== 0)
    throw new Error(
      outputText(out) || `winvm files open exited ${String(out.code)}`,
    )
}

export const openShareInFinder = (
  instance: string,
  share: GuestShare,
): Promise<void> => filesOpen(instance, share)

export const inFinderReach = (path: string): boolean =>
  /^[cC]:(\\|\/|$)/.test(path)

export const revealGuestPath = (
  instance: string,
  path: string,
): Promise<void> => filesOpen(instance, "--path", path)

export const checkpointImage = (path: string): Promise<ArrayBuffer> =>
  tauri().core.invoke<ArrayBuffer>("checkpoint_image", { path })

export async function readSettings(section: string): Promise<unknown> {
  try {
    const out = await winvm("settings", "--section", section)
    return out.code === 0 ? (JSON.parse(out.stdout) as unknown) : null
  } catch {
    return null
  }
}

export async function writeSettings(
  section: string,
  value: unknown,
): Promise<void> {
  try {
    await winvm(
      "settings",
      "--section",
      section,
      `--set=${JSON.stringify(value)}`,
    )
  } catch {}
}

export const copyText = (text: string): Promise<void> =>
  tauri().core.invoke<void>("copy_text", { text })

export const readText = (): Promise<string> =>
  tauri().core.invoke<string>("read_text")

export const homeDir = (): Promise<string> =>
  tauri().core.invoke<string>("home_dir")

export interface DragOutItem {
  readonly path: string
  readonly name: string
  readonly dir: boolean
}

export const dragOut = (
  instance: string,
  items: readonly DragOutItem[],
): Promise<void> =>
  tauri().core.invoke<void>("files_drag_out", { instance, items })

export interface PromiseEvent {
  readonly state: "start" | "done" | "failed"
  readonly name: string
  readonly dest?: string | null
  readonly error?: string | null
}

export const onPromise = (cb: (e: PromiseEvent) => void): Unlisten =>
  listen("files-promise", (e) => {
    cb(e as PromiseEvent)
  })

export const onDragOutEnd = (
  cb: (e: { readonly operation: "copy" | "none" }) => void,
): Unlisten =>
  listen("files-drag-end", (e) => {
    cb(e as { operation: "copy" | "none" })
  })

export type HostDrag =
  | {
      readonly type: "enter"
      readonly paths: readonly string[]
      readonly at: { x: number; y: number } | null
    }
  | { readonly type: "over"; readonly at: { x: number; y: number } | null }
  | {
      readonly type: "drop"
      readonly paths: readonly string[]
      readonly at: { x: number; y: number } | null
    }
  | { readonly type: "leave" }

export function onHostDrag(cb: (e: HostDrag) => void): Unlisten {
  let unlisten: Unlisten | null = null
  let gone = false
  const css = (
    p: { x: number; y: number } | undefined,
  ): { x: number; y: number } | null =>
    p === undefined
      ? null
      : { x: p.x / window.devicePixelRatio, y: p.y / window.devicePixelRatio }
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
  } catch {}
  return () => {
    gone = true
    unlisten?.()
  }
}

export async function popupMenu(
  nodes: readonly MenuNode[],
  pick: (node: Extract<MenuNode, { kind: "item" }>) => void,
): Promise<void> {
  const menu = await tauri().menu.Menu.new({ items: menuItems(nodes, pick) })
  await menu.popup()
}

export function setWindowTitle(title: string): void {
  try {
    void tauri().window.getCurrentWindow().setTitle(title)
  } catch {}
  document.title = title
}

export function closeWindow(): void {
  try {
    void tauri().window.getCurrentWindow().close()
  } catch {}
}

export function onFileDrop(
  drop: (paths: readonly string[]) => void,
  hovering: (over: boolean) => void,
): Unlisten {
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
  } catch {}
  return () => {
    gone = true
    unlisten?.()
  }
}

export function showWindow(): void {
  try {
    void tauri().window.getCurrentWindow().show()
  } catch {}
}

export const outputText = (o: Output): string =>
  [o.stdout, o.stderr]
    .filter((s) => s.trim() !== "")
    .join("\n")
    .trim()
