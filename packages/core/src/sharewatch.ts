import { type FSWatcher, watch as fsWatch, statSync } from "node:fs"
import { resolve, sep } from "node:path"

import { TOUCH_LIMIT } from "./guestagent"

export interface NoticeOptions {
  readonly root: string
  readonly send: (paths: readonly string[]) => Promise<void>
  readonly debounceMs?: number
  readonly maxPaths?: number
  readonly watch?: (
    root: string,
    onChange: (rel: string) => void,
  ) => { close(): void }
  readonly state?: (abs: string) => string
}

export function pathState(abs: string): string {
  try {
    const st = statSync(abs)
    return `${String(Math.floor(st.mtimeMs))}:${String(st.isDirectory() ? 0 : st.size)}`
  } catch {
    return "gone"
  }
}

const fsEvents = (
  root: string,
  onChange: (rel: string) => void,
): { close(): void } => {
  const w: FSWatcher = fsWatch(
    root,
    { recursive: true },
    (_event, filename) => {
      if (filename !== null) onChange(filename)
    },
  )
  w.on("error", () => undefined)
  return w
}

export class ChangeNotices {
  private readonly o: NoticeOptions
  private readonly sent = new Map<string, string>()
  private pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private watcher: { close(): void } | null = null
  private sending: Promise<void> = Promise.resolve()

  constructor(o: NoticeOptions) {
    this.o = o
  }

  start(): void {
    if (this.watcher !== null) return
    this.watcher = (this.o.watch ?? fsEvents)(this.o.root, (rel) => {
      this.changed(rel)
    })
  }

  changed(rel: string): void {
    const clean = rel
      .split(sep)
      .join("/")
      .replace(/^\.\/+/, "")
    if (clean === "" || clean.startsWith("..")) return
    this.pending.add(clean)
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.sending = this.sending.then(async () => {
        await this.flush()
      })
    }, this.o.debounceMs ?? 300)
  }

  batch(): readonly string[] {
    const state = this.o.state ?? pathState
    const out: string[] = []
    for (const rel of this.pending) {
      const now = state(resolve(this.o.root, rel))
      if (this.sent.get(rel) === now) continue
      this.sent.set(rel, now)
      out.push(rel)
    }
    this.pending = new Set()
    if (this.sent.size > 50_000) this.sent.clear()
    return out
  }

  async flush(): Promise<void> {
    const paths = this.batch()
    if (paths.length === 0) return
    const max = this.o.maxPaths ?? TOUCH_LIMIT
    try {
      await this.o.send(paths.length > max ? ["."] : paths)
    } catch {}
  }

  async stop(): Promise<void> {
    this.watcher?.close()
    this.watcher = null
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    await this.sending
  }
}
