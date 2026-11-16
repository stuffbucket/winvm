import { readFileSync, rmSync } from "node:fs"
import { connect } from "node:net"

export async function hmp(
  sockPath: string,
  command: string,
  timeoutMs = 180_000,
): Promise<string> {
  return await withSocket(sockPath, async (send, request) => {
    const reply = await request(
      {
        execute: "human-monitor-command",
        arguments: { "command-line": command },
      },
      timeoutMs,
    )
    const error = reply.error
    if (error !== undefined)
      throw new Error(`qmp rejected "${command}": ${JSON.stringify(error)}`)
    const text = typeof reply.return === "string" ? reply.return.trim() : ""
    if (/^Error/i.test(text))
      throw new Error(`${command}: ${text.replace(/\r/g, "")}`)
    void send
    return text
  })
}

export async function execute(
  sockPath: string,
  command: string,
  args?: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<unknown> {
  return await withSocket(sockPath, async (_send, request) => {
    const reply = await request(
      args === undefined
        ? { execute: command }
        : { execute: command, arguments: args },
      timeoutMs,
    )
    if (reply.error !== undefined)
      throw new Error(`qmp ${command}: ${JSON.stringify(reply.error)}`)
    return reply.return
  })
}

export async function status(sockPath: string): Promise<string> {
  const r = (await execute(sockPath, "query-status")) as
    | { status?: string }
    | undefined
  return r?.status ?? "unknown"
}

async function withSocket<T>(
  sockPath: string,
  fn: (
    send: (o: object) => Promise<void>,
    request: (
      o: object,
      timeoutMs?: number,
    ) => Promise<Record<string, unknown>>,
  ) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + 30_000
  let sock: ReturnType<typeof connect> | null = null
  for (;;) {
    try {
      const candidate = connect(sockPath)
      await new Promise<void>((res, rej) => {
        candidate.on("connect", () => {
          res()
        })
        candidate.on("error", rej)
      })
      sock = candidate
      break
    } catch (error) {
      if (Date.now() > deadline)
        throw error instanceof Error ? error : new Error(String(error))
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  const waiting: ((r: Record<string, unknown>) => void)[] = []
  let buf = ""
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8")
    for (;;) {
      const nl = buf.indexOf("\n")
      if (nl < 0) break
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim() === "") continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if ("event" in parsed || "QMP" in parsed) continue
      waiting.shift()?.(parsed)
    }
  })
  const request = async (
    o: object,
    timeoutMs = 20_000,
  ): Promise<Record<string, unknown>> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<Record<string, unknown>>((res) =>
      waiting.push(res),
    )
    const expiry = new Promise<Record<string, unknown>>((res) => {
      timer = setTimeout(() => {
        res({ error: { desc: "qmp timed out" } })
      }, timeoutMs)
    })
    sock.write(`${JSON.stringify(o)}\n`)
    const out = await Promise.race([reply, expiry])
    clearTimeout(timer)
    return out
  }
  const send = async (o: object): Promise<void> => {
    sock.write(`${JSON.stringify(o)}\n`)
    await new Promise((r) => setTimeout(r, 30))
  }
  try {
    await request({ execute: "qmp_capabilities" })
    return await fn(send, request)
  } finally {
    sock.destroy()
  }
}

export type BootFrame = "prompt" | "console" | "blank" | "graphical"

export function classifyBootFrame(ppm: Buffer): {
  kind: BootFrame
  lit: number
} {
  const m = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(
    ppm.subarray(0, 64).toString("latin1"),
  )
  if (m === null) return { kind: "blank", lit: 0 }
  const width = Number(m[1])
  const height = Number(m[2])
  const data = ppm.subarray(m[0].length)
  if (width * height === 0 || data.length < width * height * 3)
    return { kind: "blank", lit: 0 }
  let lit = 0
  let lowest = -1
  for (let i = 0; i < width * height * 3; i += 3) {
    if (Math.max(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0) > 80) {
      lit += 1
      lowest = Math.floor(i / 3 / width)
    }
  }
  if (lit === 0) return { kind: "blank", lit }
  if (lit / (width * height) > 0.3) return { kind: "graphical", lit }
  return { kind: lowest < height / 16 ? "prompt" : "console", lit }
}

export async function answerBootPrompt(
  sockPath: string,
  frameFile: string,
  {
    maxKeys = 6,
    withinMs = 60_000,
  }: { maxKeys?: number; withinMs?: number } = {},
): Promise<{ keys: number; answered: boolean }> {
  const FROZEN_MS = 1500
  const SETTLE_MS = 300
  const deadline = Date.now() + withinMs
  return await withSocket(sockPath, async (_send, request) => {
    const frame = async (): Promise<{ kind: BootFrame; lit: number }> => {
      const r = await request({
        execute: "screendump",
        arguments: { filename: frameFile },
      })
      if (r.error !== undefined)
        throw new Error(`screendump rejected: ${JSON.stringify(r.error)}`)
      return classifyBootFrame(readFileSync(frameFile))
    }
    let keys = 0
    let sentAt = 0
    let litAtKey = -1
    let changedAt = 0
    try {
      while (Date.now() < deadline) {
        const f = await frame()
        const now = Date.now()
        if (f.kind === "graphical") return { keys, answered: keys > 0 }
        if (f.kind !== "prompt") {
          litAtKey = -1
        } else if (
          litAtKey >= 0 &&
          f.lit !== litAtKey &&
          now - sentAt <= SETTLE_MS
        ) {
          litAtKey = f.lit
          changedAt = now
        } else if (litAtKey < 0 || f.lit !== litAtKey) {
          if (keys >= maxKeys) return { keys, answered: false }
          const r = await request({
            execute: "human-monitor-command",
            arguments: { "command-line": "sendkey ret" },
          })
          if (r.error !== undefined)
            throw new Error(`sendkey rejected: ${JSON.stringify(r.error)}`)
          keys += 1
          sentAt = Date.now()
          changedAt = sentAt
          litAtKey = f.lit
        } else if (f.lit === litAtKey && now - changedAt > FROZEN_MS) {
          return { keys, answered: true }
        }
        await new Promise((res) => setTimeout(res, 150))
      }
      return { keys, answered: false }
    } finally {
      rmSync(frameFile, { force: true })
    }
  })
}
