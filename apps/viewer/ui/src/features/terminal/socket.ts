/**
 * A TerminalTransport over the guest's terminal WebSocket.
 *
 * `connect` resolves a session's endpoint (the app runs `winvm terminal …
 * --connect --json`); the socket is then opened from the webview as
 * `new WebSocket(url + "&cols=N&rows=M", protocols)`. On it:
 *
 *   binary frames   raw terminal bytes, both ways
 *   text frames     JSON control: we send {"type":"resize","cols","rows"};
 *                   the guest sends {"type":"exit","code"} (then closes) and
 *                   {"type":"error","message"}
 *
 * Output reaches the view as `data` events (decoded as UTF-8, a frame split
 * mid-character is held for the next) and the shell's end as an `exit` event.
 * An error the guest reports is written into the terminal, in red, as well.
 * Everything else that happens to a session, opening, errors, a connection
 * lost without an exit, is reported through `onStatus`.
 */
import type { TerminalDescriptor, TerminalEvent, TerminalTransport } from "@winvm/terminal"

import type { Endpoint } from "./shells"

export type SessionStatus =
  | { readonly kind: "open" }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "lost"; readonly message: string | null }

/** The parts of the WebSocket constructor this uses; tests pass their own. */
export type SocketConstructor = new (url: string, protocols: string[]) => WebSocket

export interface SocketTransportOptions {
  connect(descriptor: TerminalDescriptor): Promise<Endpoint>
  onStatus?(id: string, status: SessionStatus): void
  WebSocket?: SocketConstructor
}

interface Session {
  readonly listeners: Set<(event: TerminalEvent) => void>
  readonly decoder: TextDecoder
  socket: WebSocket | null
  size: { cols: number; rows: number } | null
  /** The size the guest was last told, so a repeat is not sent. */
  sent: { cols: number; rows: number } | null
  lastError: string | null
  exited: boolean
  ended: boolean
}

const OPEN = 1

/** The endpoint with the terminal's first size, which the guest starts the shell at. */
export function sizedUrl(url: string, cols: number, rows: number): string {
  const u = new URL(url)
  u.searchParams.set("cols", String(cols))
  u.searchParams.set("rows", String(rows))
  return u.toString()
}

type Control = { type: "exit"; code: number } | { type: "error"; message: string }

function control(text: string): Control | null {
  try {
    const m = JSON.parse(text) as { type?: unknown; code?: unknown; message?: unknown }
    if (m.type === "exit" && typeof m.code === "number") return { type: "exit", code: m.code }
    if (m.type === "error" && typeof m.message === "string") return { type: "error", message: m.message }
  } catch {
    // not JSON: ignored, as an unknown control message is
  }
  return null
}

export function createSocketTransport(options: SocketTransportOptions): TerminalTransport {
  const Socket = options.WebSocket ?? (globalThis.WebSocket as SocketConstructor)
  const sessions = new Map<string, Session>()
  const encoder = new TextEncoder()

  const session = (id: string): Session => {
    let s = sessions.get(id)
    if (s === undefined) {
      s = {
        listeners: new Set(),
        decoder: new TextDecoder(),
        socket: null,
        size: null,
        sent: null,
        lastError: null,
        exited: false,
        ended: false,
      }
      sessions.set(id, s)
    }
    return s
  }

  const emit = (s: Session, event: TerminalEvent): void => {
    for (const listener of s.listeners) listener(event)
  }

  const sendSize = (s: Session): void => {
    const size = s.size
    if (size === null || s.socket?.readyState !== OPEN) return
    if (s.sent !== null && s.sent.cols === size.cols && s.sent.rows === size.rows) return
    s.socket.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }))
    s.sent = size
  }

  return {
    async spawn(descriptor) {
      const { id, cols, rows } = descriptor
      const s = session(id)
      s.socket?.close()
      s.socket = null
      s.ended = false
      s.exited = false
      s.lastError = null
      s.size = { cols, rows }
      const endpoint = await options.connect(descriptor)
      if (s.ended) return

      const socket = new Socket(sizedUrl(endpoint.url, cols, rows), endpoint.protocols)
      socket.binaryType = "arraybuffer"
      s.socket = socket
      s.sent = { cols, rows }

      await new Promise<void>((resolve, reject) => {
        let opened = false
        socket.onopen = () => {
          opened = true
          options.onStatus?.(id, { kind: "open" })
          sendSize(s)
          resolve()
        }
        socket.onmessage = (e: MessageEvent) => {
          if (s.socket !== socket) return
          if (typeof e.data === "string") {
            const m = control(e.data)
            if (m?.type === "exit") {
              s.exited = true
              emit(s, { type: "exit", exitCode: m.code })
              options.onStatus?.(id, { kind: "exit", code: m.code })
            } else if (m?.type === "error") {
              s.lastError = m.message
              emit(s, { type: "data", data: `\r\n\x1b[31m${m.message}\x1b[0m\r\n` })
              options.onStatus?.(id, { kind: "error", message: m.message })
            }
            return
          }
          const text = s.decoder.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true })
          if (text !== "") emit(s, { type: "data", data: text })
        }
        socket.onclose = (e: CloseEvent) => {
          const reason = s.lastError ?? (e.reason === "" ? null : e.reason)
          if (!opened) reject(new Error(reason ?? "the terminal connection closed before it opened"))
          if (s.socket !== socket) return
          s.socket = null
          const tail = s.decoder.decode()
          if (tail !== "") emit(s, { type: "data", data: tail })
          if (opened && !s.exited && !s.ended) options.onStatus?.(id, { kind: "lost", message: reason })
        }
      })
    },

    async write(id, data) {
      const socket = sessions.get(id)?.socket
      if (socket?.readyState === OPEN) socket.send(encoder.encode(data))
    },

    async resize(id, cols, rows) {
      const s = sessions.get(id)
      if (s === undefined) return
      s.size = { cols, rows }
      sendSize(s)
    },

    async terminate(id) {
      const s = sessions.get(id)
      if (s === undefined) return
      s.ended = true
      sessions.delete(id)
      const socket = s.socket
      s.socket = null
      socket?.close(1000)
    },

    subscribe(id, listener) {
      const s = session(id)
      s.listeners.add(listener)
      return () => {
        s.listeners.delete(listener)
      }
    },
  }
}
