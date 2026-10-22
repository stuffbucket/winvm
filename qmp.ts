/**
 * QMP client — QEMU's own control socket, as opposed to the guest agent.
 *
 * Used for the one thing the guest cannot do for itself: press a key before any
 * OS is running.
 */
import { readFileSync, rmSync } from "node:fs"
import { connect } from "node:net"

/**
 * Run one HMP command and return what it said.
 *
 * READING THE REPLY IS THE ENTIRE POINT. HMP commands wrapped in
 * `human-monitor-command` report failure as ordinary TEXT inside a SUCCESSFUL
 * QMP response — `{"return": "Error: Device 'pflash1' is writable but does not
 * support snapshots\r\n"}`. A caller that only checks for a QMP-level error sees
 * every one of those as success, which is how a snapshot that never happened
 * gets reported as taken, and a rewind that reverted nothing looks fine.
 */
export async function hmp(sockPath: string, command: string, timeoutMs = 180_000): Promise<string> {
  return await withSocket(sockPath, async (send, request) => {
    const reply = await request({ execute: "human-monitor-command", arguments: { "command-line": command } }, timeoutMs)
    const error = reply["error"]
    if (error !== undefined) throw new Error(`qmp rejected "${command}": ${JSON.stringify(error)}`)
    const text = typeof reply["return"] === "string" ? reply["return"].trim() : ""
    // HMP prefixes its failures with "Error:"; success is usually empty output.
    if (/^Error/i.test(text)) throw new Error(`${command}: ${text.replace(/\r/g, "")}`)
    void send
    return text
  })
}

/**
 * Run one QMP command and return its `return` value; a QMP-level error throws.
 * One connection per call: the monitor serves a single client at a time, so
 * holding it open would lock out every other `winvm` process.
 */
export async function execute(
  sockPath: string,
  command: string,
  args?: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<unknown> {
  return await withSocket(sockPath, async (_send, request) => {
    const reply = await request(args === undefined ? { execute: command } : { execute: command, arguments: args }, timeoutMs)
    if (reply["error"] !== undefined) throw new Error(`qmp ${command}: ${JSON.stringify(reply["error"])}`)
    return reply["return"]
  })
}

/** QEMU's run state: "running", "paused", "postmigrate", "inmigrate", ... */
export async function status(sockPath: string): Promise<string> {
  const r = (await execute(sockPath, "query-status")) as { status?: string } | undefined
  return r?.status ?? "unknown"
}

async function withSocket<T>(
  sockPath: string,
  fn: (
    send: (o: object) => Promise<void>,
    request: (o: object, timeoutMs?: number) => Promise<Record<string, unknown>>,
  ) => Promise<T>,
): Promise<T> {
  // QEMU creates the socket a moment AFTER the process starts, so a connect
  // attempt racing the launch fails with ENOENT. Retry rather than give up:
  // losing this race means the boot prompt goes unanswered and the install
  // silently stalls at firmware.
  const deadline = Date.now() + 30_000
  let sock: ReturnType<typeof connect> | null = null
  for (;;) {
    try {
      const candidate = connect(sockPath)
      await new Promise<void>((res, rej) => {
        candidate.on("connect", () => res())
        candidate.on("error", rej)
      })
      sock = candidate
      break
    } catch (error) {
      if (Date.now() > deadline) throw error instanceof Error ? error : new Error(String(error))
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  // Replies are matched to requests in order. QEMU answers a QMP monitor's
  // commands sequentially, so a queue is enough; asynchronous EVENTS are
  // interleaved with them and must not be mistaken for a reply.
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
  const request = async (o: object, timeoutMs = 20_000): Promise<Record<string, unknown>> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const reply = new Promise<Record<string, unknown>>((res) => waiting.push(res))
    const expiry = new Promise<Record<string, unknown>>((res) => {
      timer = setTimeout(() => res({ error: { desc: "qmp timed out" } }), timeoutMs)
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

/** What a build VM's screen shows, as far as answering the boot prompt cares. */
export type BootFrame = "prompt" | "console" | "blank" | "graphical"

/**
 * Classify a raw (P6) screendump, and count its lit pixels.
 *
 * Measured on the build VM (ramfb, 800x600):
 *
 *   - "prompt": cdboot CLEARS the screen and prints "Press any key to boot from
 *     CD or DVD", one line at the very top, adding a dot every half second.
 *     Nothing else is lit — ~600 pixels, all in the top line.
 *   - "console": the UEFI shell, text further down the screen (~5% lit).
 *   - "graphical": Windows Setup and its blue screens (~100% lit).
 *   - "blank": nothing lit at all.
 *
 * Positions and shares, not a font or a resolution, so a different display
 * size does not need new numbers.
 */
export function classifyBootFrame(ppm: Buffer): { kind: BootFrame; lit: number } {
  const m = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(ppm.subarray(0, 64).toString("latin1"))
  if (m === null) return { kind: "blank", lit: 0 }
  const width = Number(m[1])
  const height = Number(m[2])
  const data = ppm.subarray(m[0].length)
  if (width * height === 0 || data.length < width * height * 3) return { kind: "blank", lit: 0 }
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

/**
 * Answer the install media's boot prompt — pressing Enter ONLY WHILE THE PROMPT
 * IS ON SCREEN AND STILL WAITING.
 *
 * Windows install media boots `cdboot.efi`, which prints "Press any key to boot
 * from CD or DVD" and returns EFI_TIMEOUT if nothing does. Unanswered, EDK2
 * walks every remaining boot option — other USB devices, the disk, PXE v4/v6,
 * HTTP v4/v6, each with its own timeout — and lands in a UEFI shell having
 * installed nothing.
 *
 * A KEY THAT ARRIVES AFTER THE PROMPT IS ANSWERED IS WORSE THAN NONE. Once
 * bootmgr hands over to the Windows kernel nothing polls the keyboard, and
 * QEMU's usb-kbd QUEUES what it is sent — then hands the lot to Windows Setup's
 * GUI as soon as it starts, where Enter activates "Support" and Cancel and
 * opens "Are you sure you want to quit?". The guest reboots having partitioned
 * the disk and nothing else, and the build ends at "no bootable target found".
 *
 * Both earlier designs failed that way. Holding Enter until the disk grew sent
 * ~250 keys; five keys over ten seconds still failed ~2 builds in 3, because on
 * this host Setup is up ~8 s after the prompt is answered — inside the ten.
 *
 * So the screen decides, not a clock. The prompt is recognisable (one line of
 * text on an otherwise black screen) and so is its answer: while cdboot waits
 * it adds a dot every half second, and the moment it takes a key the dots stop
 * — the frame then stays frozen until Setup draws over it. One key per prompt;
 * another only if the dots are seen to move on well after it was sent; done
 * as soon as the prompt freezes or Setup appears. If cdboot times out anyway,
 * the shell tries the next copy and this answers that prompt too.
 *
 * Returns how many keys were sent and whether the prompt was seen to take one.
 *
 * `sendkey` is an **HMP** command, not a QMP one. Issuing it as
 * `{"execute":"sendkey"}` returns `CommandNotFound` — and a caller that ignores
 * the response sees keystrokes "sent" and none arrive, which looks exactly like
 * a storage or firmware fault. That misdiagnosis cost hours. Every key here is
 * a checked request.
 */
export async function answerBootPrompt(
  sockPath: string,
  frameFile: string,
  { maxKeys = 6, withinMs = 60_000 }: { maxKeys?: number; withinMs?: number } = {},
): Promise<{ keys: number; answered: boolean }> {
  // Dots come every 500 ms: three missed in a row is a prompt that took the key,
  // and a dot within 300 ms of the key may have been drawn before it arrived.
  const FROZEN_MS = 1500
  const SETTLE_MS = 300
  const deadline = Date.now() + withinMs
  return await withSocket(sockPath, async (_send, request) => {
    const frame = async (): Promise<{ kind: BootFrame; lit: number }> => {
      const r = await request({ execute: "screendump", arguments: { filename: frameFile } })
      if (r["error"] !== undefined) throw new Error(`screendump rejected: ${JSON.stringify(r["error"])}`)
      return classifyBootFrame(readFileSync(frameFile))
    }
    let keys = 0
    // The prompt's state when the last key went: when, and how many lit pixels.
    let sentAt = 0
    let litAtKey = -1
    let changedAt = 0
    try {
      while (Date.now() < deadline) {
        const f = await frame()
        const now = Date.now()
        if (f.kind === "graphical") return { keys, answered: keys > 0 }
        if (f.kind !== "prompt") {
          // Back at the shell (a timeout, and it is about to try another copy) or
          // between screens: the next prompt starts over.
          litAtKey = -1
        } else if (litAtKey >= 0 && f.lit !== litAtKey && now - sentAt <= SETTLE_MS) {
          // A dot drawn as the key went in: the key may yet land. Judge from here.
          litAtKey = f.lit
          changedAt = now
        } else if (litAtKey < 0 || f.lit !== litAtKey) {
          // A prompt not yet answered, or one whose dots moved on after the key.
          if (keys >= maxKeys) return { keys, answered: false }
          const r = await request({ execute: "human-monitor-command", arguments: { "command-line": "sendkey ret" } })
          if (r["error"] !== undefined) throw new Error(`sendkey rejected: ${JSON.stringify(r["error"])}`)
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
