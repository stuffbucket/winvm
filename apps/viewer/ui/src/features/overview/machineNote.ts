/**
 * The note on a machine, as the suspended screen keeps it: read when the
 * machine is shown, written as it is typed.
 *
 * Writes are debounced (a pause in typing saves; there is no Save button),
 * flushed at once by `flush()` (blur, Escape, leaving the screen, switching
 * machine), and run one after another so an older text never lands after a
 * newer one. A failed write is reported once and the text stays pending, so the
 * next change or flush tries again.
 *
 * The store is `winvm note` (packages/core machinenote.ts): the text is at
 * `$XDG_DATA_HOME/winvm/machine-notes/<instance>.json`.
 */
import { z } from "zod"

import { winvm } from "../../backend"

const Note = z.object({ text: z.string() }).nullable()

/** `winvm note --json`: the text, or "" when the machine has no note; null when it could not be read. */
export function parseMachineNote(stdout: string): string | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  const r = Note.safeParse(raw)
  return r.success ? (r.data?.text ?? "") : null
}

/** The note on a machine ("" for none), or null when it could not be read. */
export async function readMachineNote(instance: string): Promise<string | null> {
  try {
    const out = await winvm("note", "-i", instance, "--json")
    return out.code === 0 ? parseMachineNote(out.stdout) : null
  } catch {
    return null
  }
}

/** Replaces the note; true when it was written. `--text=`: the one-word form carries any text (args.ts). */
export async function writeMachineNote(instance: string, text: string): Promise<boolean> {
  try {
    return (await winvm("note", "-i", instance, `--text=${text}`)).code === 0
  } catch {
    return false
  }
}

export const SAVE_DELAY_MS = 800

export interface NoteSaver {
  /** The text changed: save it after a pause in typing. */
  change(text: string): void
  /** Save what is pending now; resolves when everything asked for has been written. */
  flush(): Promise<void>
}

export function createNoteSaver(write: (text: string) => Promise<boolean>, onResult: (ok: boolean) => void, delay = SAVE_DELAY_MS): NoteSaver {
  let pending: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()

  const run = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (pending === null) return
    const text = pending
    pending = null
    chain = chain.then(async () => {
      const ok = await write(text)
      // Kept for the next try, unless something newer has come in since.
      if (!ok && pending === null) pending = text
      onResult(ok)
    })
  }

  return {
    change(text) {
      pending = text
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(run, delay)
    },
    flush() {
      run()
      return chain
    },
  }
}
