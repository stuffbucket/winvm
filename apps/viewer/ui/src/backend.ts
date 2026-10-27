/**
 * The one place the UI reaches the app: Tauri commands that run winvm's own
 * CLI (the bundled sidecar) and return what it printed, plus the few things
 * only the app can do (menus, file picking and dropping, a long-running
 * `cua serve`).
 */
export interface Output {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

type Unlisten = () => void

interface DragDrop {
  readonly payload: { readonly type: "enter" | "over" | "drop" | "leave"; readonly paths?: readonly string[] }
}

interface TauriGlobal {
  readonly core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> }
  readonly window: { getCurrentWindow(): { show(): Promise<void> } }
  readonly event: { listen<T>(name: string, cb: (e: { payload: T }) => void): Promise<Unlisten> }
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

/** App menu items the window acts on: "install-cli" and "reference". */
export function onMenu(cb: (id: string) => void): Unlisten {
  let unlisten: Unlisten | null = null
  let gone = false
  try {
    void tauri()
      .event.listen<string>("menu", (e) => cb(e.payload))
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
