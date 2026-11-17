import { z } from "zod"

import { winvm } from "../../backend"

const Note = z.object({ text: z.string() }).nullable()

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

export async function readMachineNote(
  instance: string,
): Promise<string | null> {
  try {
    const out = await winvm("note", "-i", instance, "--json")
    return out.code === 0 ? parseMachineNote(out.stdout) : null
  } catch {
    return null
  }
}

export async function writeMachineNote(
  instance: string,
  text: string,
): Promise<boolean> {
  try {
    return (await winvm("note", "-i", instance, `--text=${text}`)).code === 0
  } catch {
    return false
  }
}

export const SAVE_DELAY_MS = 800

export interface NoteSaver {
  change(text: string): void
  flush(): Promise<void>
}

export function createNoteSaver(
  write: (text: string) => Promise<boolean>,
  onResult: (ok: boolean) => void,
  delay = SAVE_DELAY_MS,
): NoteSaver {
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
