/**
 * QMP client — QEMU's own control socket, as opposed to the guest agent.
 *
 * Used for the one thing the guest cannot do for itself: press a key before any
 * OS is running.
 */
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

/**
 * Hold Enter down through the firmware phase of an install.
 *
 * WHY THIS EXISTS, AND WHY IT IS SHAPED LIKE THIS.
 *
 * Windows install media boots `cdboot.efi`, which prints "Press any key to boot
 * from CD or DVD" and returns EFI_TIMEOUT if nothing does. Unanswered, EDK2
 * then walks every remaining boot option — other USB devices, the disk, PXE
 * v4/v6, HTTP v4/v6, each with its own timeout — and lands in a UEFI shell
 * having installed nothing.
 *
 * `sendkey` is an **HMP** command, not a QMP one. Issuing it as
 * `{"execute":"sendkey"}` returns `CommandNotFound` — and if the caller ignores
 * the response, as an earlier version of this code did, the failure is
 * completely silent: hundreds of keystrokes are "sent", none arrive, and the
 * symptom looks exactly like a storage or firmware fault. That misdiagnosis
 * cost hours. It must be wrapped in `human-monitor-command`, and the result
 * must be checked.
 */
export async function pressEnterUntil(sockPath: string, deadlineMs: number, shouldStop: () => boolean): Promise<void> {
  await withSocket(sockPath, async (send, request) => {
    // The FIRST keystroke is sent as a checked request, so a wrapper that does
    // not work is reported now rather than as an install that silently stalls at
    // firmware. The rest are fire-and-forget: hundreds of them go out, and
    // waiting for each reply would halve the rate.
    const first = await request({ execute: "human-monitor-command", arguments: { "command-line": "sendkey ret" } })
    if (first["error"] !== undefined) throw new Error(`sendkey rejected: ${JSON.stringify(first["error"])}`)

    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline && !shouldStop()) {
      await send({ execute: "human-monitor-command", arguments: { "command-line": "sendkey ret" } })
      await new Promise((r) => setTimeout(r, 400))
    }
  })
}
