import type { TerminalTheme } from "./emulator.js"
import type { TerminalPane } from "./pane.js"

export interface TerminalDescriptor {
  id: string
  cwd?: string | undefined
  shell?: string | undefined
  ariaLabel?: string
}

export type TerminalEvent =
  | { type: "data"; data: string; sequence?: number | undefined }
  | { type: "exit"; exitCode: number }
  | { type: "size"; cols: number; rows: number }

export type TerminalDisposition = "terminate" | "detach" | "preserve"

export interface TerminalSession {
  id: string
  cwd: string
  shell: string
  startedAt: number
  title?: string
  canRunInBackground?: boolean
  pane?: TerminalPane
  revision?: number
}

export interface TerminalTransport {
  spawn(
    descriptor: TerminalDescriptor & { cols: number; rows: number },
  ): Promise<void>
  focus?(id: string, cols: number, rows: number): Promise<void>
  write(id: string, data: string): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  terminate(id: string): Promise<void>
  ack?: ((id: string, sequence: number) => Promise<void>) | undefined
  subscribe(id: string, listener: (event: TerminalEvent) => void): () => void
}

export interface DetachableTerminalTransport extends TerminalTransport {
  list(): Promise<TerminalSession[]>
}

export interface TerminalChannels<
  C extends string = string,
  E extends string = string,
> {
  spawn: C
  write: C
  resize: C
  terminate: C
  list: C
  ack?: C
  data: E
  exit: E
  size?: E
}

export interface TerminalDataMessage {
  id: string
  data: string
  sequence?: number
}

export interface TerminalExitMessage {
  id: string
  exitCode: number
}

export interface TerminalSizeMessage {
  id: string
  cols: number
  rows: number
}

export interface TerminalTransportOptions<
  C extends string = string,
  E extends string = string,
> {
  invoke: (channel: C, request?: unknown) => Promise<unknown>
  on: (event: E, listener: (payload: unknown) => void) => () => void
  channels: TerminalChannels<C, E>
}

export function createTerminalTransport<C extends string, E extends string>({
  invoke,
  on,
  channels,
}: TerminalTransportOptions<C, E>): DetachableTerminalTransport {
  return {
    async spawn({ id, cwd, shell, cols, rows }) {
      await invoke(channels.spawn, { id, cols, rows, shell, cwd })
    },

    async write(id, data) {
      await invoke(channels.write, { id, data })
    },

    async resize(id, cols, rows) {
      await invoke(channels.resize, { id, cols, rows })
    },

    async terminate(id) {
      await invoke(channels.terminate, { id })
    },

    ack: channels.ack
      ? async function ack(id: string, sequence: number): Promise<void> {
          await invoke(channels.ack!, { id, sequence })
        }
      : undefined,

    async list() {
      return (await invoke(channels.list)) as TerminalSession[]
    },

    subscribe(id, listener) {
      const onData = on(channels.data, (payload) => {
        const message = payload as TerminalDataMessage
        if (message.id === id) {
          listener({
            type: "data",
            data: message.data,
            sequence: message.sequence,
          })
        }
      })

      const onExit = on(channels.exit, (payload) => {
        const message = payload as TerminalExitMessage
        if (message.id === id) {
          listener({ type: "exit", exitCode: message.exitCode })
        }
      })

      const onSize = channels.size
        ? on(channels.size, (payload) => {
            const message = payload as TerminalSizeMessage
            if (message.id === id) {
              listener({ type: "size", cols: message.cols, rows: message.rows })
            }
          })
        : undefined

      return () => {
        onData()
        onExit()
        onSize?.()
      }
    },
  }
}

export function readTerminalTheme(
  read: (property: string) => string,
  properties: { background: string; foreground: string; cursor: string },
): TerminalTheme {
  const theme: TerminalTheme = {}

  const background = read(properties.background).trim()
  if (background) theme.background = background

  const foreground = read(properties.foreground).trim()
  if (foreground) theme.foreground = foreground

  const cursor = read(properties.cursor).trim()
  if (cursor) theme.cursor = cursor

  return theme
}

export const SHELL_TERMINAL_PROPERTIES = {
  background: "--shell-terminal-background",
  foreground: "--shell-terminal-foreground",
  cursor: "--shell-terminal-cursor",
} as const
