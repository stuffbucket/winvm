import { connect } from "node:net"

import { fenced } from "./opcontext"

export class QmpError extends Error {}

export class QmpNotDelivered extends QmpError {}

export type QmpSend = (
  execute: string,
  args?: Record<string, unknown>,
) => Promise<unknown>

export async function withQmp<T>(
  sockPath: string,
  fn: (send: QmpSend) => Promise<T>,
  timeoutMs = 3000,
): Promise<T> {
  return await fenced(async () => await qmpSession(sockPath, fn, timeoutMs))
}

async function qmpSession<T>(
  sockPath: string,
  fn: (send: QmpSend) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const sock = connect(sockPath)
  let buf = ""
  let greeted: (() => void) | null = null
  let failed: ((e: Error) => void) | null = null
  const waiting: ((msg: Record<string, unknown>) => void)[] = []

  const greeting = new Promise<void>((res, rej) => {
    greeted = res
    failed = rej
  })
  let deadErr: Error | null = null
  sock.on("error", (error) => {
    deadErr = error
    failed?.(error)
    for (const w of waiting.splice(0))
      w({ error: { desc: error.message, local: true } })
  })
  sock.on("close", () => {
    deadErr ??= new QmpError("qmp connection closed")
    for (const w of waiting.splice(0))
      w({ error: { desc: "qmp connection closed", local: true } })
  })
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8")
    for (;;) {
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line === "") continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if ("event" in msg) continue
      if ("QMP" in msg) {
        greeted?.()
        continue
      }
      waiting.shift()?.(msg)
    }
  })

  const raw = async (o: object, label: string): Promise<unknown> => {
    if (deadErr !== null) throw deadErr
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<Record<string, unknown>>((res) =>
      waiting.push(res),
    )
    const expiry = new Promise<Record<string, unknown>>((res) => {
      timer = setTimeout(() => {
        res({
          error: {
            desc: `no answer in ${String(timeoutMs)} ms`,
            timeout: true,
            local: true,
          },
        })
      }, timeoutMs)
    })
    sock.write(`${JSON.stringify(o)}\n`)
    const msg = await Promise.race([reply, expiry])
    clearTimeout(timer)
    const error = msg.error as
      | { desc?: string; timeout?: boolean; local?: boolean }
      | undefined
    if (error !== undefined) {
      if (error.timeout === true) sock.destroy()
      const text = `qmp ${label}: ${error.desc ?? JSON.stringify(error)}`
      throw error.local === true
        ? new QmpError(text)
        : new QmpNotDelivered(text)
    }
    return msg.return
  }

  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      greeting,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          rej(
            new QmpError(
              `qmp: no greeting in ${String(timeoutMs)} ms (monitor busy?)`,
            ),
          )
        }, timeoutMs)
      }),
    ]).finally(() => {
      clearTimeout(timer)
    })
    await raw({ execute: "qmp_capabilities" }, "qmp_capabilities")
    return await fn(
      async (execute, args) =>
        await raw(
          args === undefined ? { execute } : { execute, arguments: args },
          execute,
        ),
    )
  } finally {
    sock.destroy()
  }
}

export async function qmpCommand(
  sockPath: string,
  execute: string,
  args?: Record<string, unknown>,
  timeoutMs = 3000,
): Promise<unknown> {
  const request = { asked: false }
  try {
    return await withQmp(
      sockPath,
      async (send) => {
        request.asked = true
        return await send(execute, args)
      },
      timeoutMs,
    )
  } catch (error) {
    if (request.asked || error instanceof QmpNotDelivered) throw error
    throw new QmpNotDelivered(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    )
  }
}
