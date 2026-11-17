import { resolve } from "node:path"

const HOLDER = resolve(import.meta.dir, "holder.ts")
const holders = new Set<ReturnType<typeof Bun.spawn>>()

export interface LockedPidfile {
  readonly pid: number
  readonly proc: ReturnType<typeof Bun.spawn>
}

export async function lockPidfile(
  pidfile: string,
  ...argv: string[]
): Promise<LockedPidfile> {
  const proc = Bun.spawn(
    [process.execPath, HOLDER, ...argv, "--lock", pidfile],
    { stdout: "pipe", stderr: "ignore" },
  )
  holders.add(proc)
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const first = await reader.read()
  reader.releaseLock()
  if (!new TextDecoder().decode(first.value).includes("ready"))
    throw new Error(`the holder could not lock ${pidfile}`)
  return { pid: proc.pid, proc }
}

export async function releasePidfiles(): Promise<void> {
  const ending = [...holders]
  holders.clear()
  for (const proc of ending) proc.kill("SIGKILL")
  await Promise.all(ending.map(async (proc) => await proc.exited))
}
