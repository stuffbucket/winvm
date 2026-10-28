/**
 * Change notices for the shared folder: Lima's mountInotify trick, for Windows.
 *
 * virtio-fs carries what Windows asks for, but nothing tells Windows when a
 * file changes on the Mac side: FileSystemWatchers (editors, dev servers,
 * Explorer) never fire for those changes (measured). So the host watches the
 * folder (FSEvents through `fs.watch(recursive)`), collects what changed for a
 * moment, and asks the guest's agent to touch those paths in the shared drive
 * (POST /fs/touch: each gets its own times back). That write goes through
 * WinFsp, which reports it, and the watchers fire. A path that is gone touches
 * its folder instead.
 *
 * THE ECHO. A touch writes the times back through virtiofsd, which FSEvents
 * reports as a change of its own. So a path is sent only when its (mtime,
 * size) differs from what was last sent for it; the touch writes back the
 * same mtime, and the echo stops there.
 *
 * Not for a read-only share: virtiofsd refuses the touch (EROFS), so the
 * service does not start one there.
 *
 * Owned by the control service (service.ts), which runs it for as long as a
 * guest with a shared folder runs and its agent answers.
 */
import { type FSWatcher, statSync, watch as fsWatch } from "node:fs"
import { resolve, sep } from "node:path"

import { TOUCH_LIMIT } from "./guestagent"

export interface NoticeOptions {
  /** The Mac folder being served. */
  readonly root: string
  /** Hand changed paths (relative, with /) to the guest. "." means the whole drive. */
  readonly send: (paths: readonly string[]) => Promise<void>
  /** Quiet time before a batch goes. */
  readonly debounceMs?: number
  /** The most paths in one batch; more becomes one touch of the root. */
  readonly maxPaths?: number
  /** For tests: the watcher, and how a path's state is read. */
  readonly watch?: (root: string, onChange: (rel: string) => void) => { close(): void }
  readonly state?: (abs: string) => string
}

/** A path's (mtime, size), or "gone". Whole milliseconds: Windows' times round away the rest. */
export function pathState(abs: string): string {
  try {
    const st = statSync(abs)
    return `${String(Math.floor(st.mtimeMs))}:${String(st.isDirectory() ? 0 : st.size)}`
  } catch {
    return "gone"
  }
}

const fsEvents = (root: string, onChange: (rel: string) => void): { close(): void } => {
  const w: FSWatcher = fsWatch(root, { recursive: true }, (_event, filename) => {
    if (filename !== null) onChange(filename.toString())
  })
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

  /** A path under the root changed (relative, either separator). */
  changed(rel: string): void {
    const clean = rel.split(sep).join("/").replace(/^\.\/+/, "")
    if (clean === "" || clean.startsWith("..")) return
    this.pending.add(clean)
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.sending = this.sending.then(async () => await this.flush())
    }, this.o.debounceMs ?? 300)
  }

  /** The paths whose state differs from what was last sent, recorded as sent. */
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
    // Bounded: a folder with churn should not grow this forever.
    if (this.sent.size > 50_000) this.sent.clear()
    return out
  }

  async flush(): Promise<void> {
    const paths = this.batch()
    if (paths.length === 0) return
    const max = this.o.maxPaths ?? TOUCH_LIMIT
    try {
      await this.o.send(paths.length > max ? ["."] : paths)
    } catch {
      // The guest may be busy, restarting or without the agent: the next change tries again.
    }
  }

  /** Stop watching; waits for a batch in flight. */
  async stop(): Promise<void> {
    this.watcher?.close()
    this.watcher = null
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    await this.sending
  }
}
