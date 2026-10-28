import type { TerminalTheme } from './emulator.js';
import type { TerminalPane } from './pane.js';

/**
 * What a terminal needs from its host, as a contract rather than an import.
 *
 * The shell's own terminal talks to a pty in the main process over IPC. A
 * consumer of this package has a different main process, a different channel
 * set, and possibly no Electron at all, so the component takes the transport
 * as a value instead of reaching for one.
 *
 * Every method is asynchronous because the shell that backs it is in another
 * process. `subscribe` returns its own unsubscribe, so a caller never has to
 * pair two calls.
 */

/** What to open, and where. */
export interface TerminalDescriptor {
  /**
   * Identifies the session for its whole lifetime, and is distinct from any
   * tab or project id. Reusing one for a second session is what lets a late
   * exit event delete a live shell.
   */
  id: string;
  /** Absolute. Immutable for one session; a new directory is a new session. */
  cwd?: string;
  /** Defaults to the host's own choice when absent. */
  shell?: string;
  /** Names the terminal for assistive technology. */
  ariaLabel?: string;
}

/** Output, or the end of it. */
export type TerminalEvent =
  | { type: 'data'; data: string; sequence?: number }
  | { type: 'exit'; exitCode: number }
  | { type: 'size'; cols: number; rows: number };

/**
 * What unmounting a view does to its session.
 *
 * `terminate` is the default, and is what every caller got before there was a
 * choice. `detach` leaves the shell running, which is what a long build needs
 * and what `tmux detach` means. `preserve` is for a parent that still owns
 * termination while it reshapes child views; it does not make the session
 * user-detached.
 */
export type TerminalDisposition = 'terminate' | 'detach' | 'preserve';

/** A live session, whether or not a view is showing it. */
export interface TerminalSession {
  id: string;
  cwd: string;
  shell: string;
  /** Milliseconds since the epoch. */
  startedAt: number;
  /** Optional host-owned restoration metadata. */
  title?: string;
  canRunInBackground?: boolean;
  pane?: TerminalPane;
  revision?: number;
}

export interface TerminalTransport {
  /**
   * Open a session, or attach to the one `id` already names.
   *
   * A host that supports detach replays what the session has printed, so
   * attaching is how a view returns to a shell it left running.
   */
  spawn(descriptor: TerminalDescriptor & { cols: number; rows: number }): Promise<void>;
  /** Optional focus lease for backends with independently controlled views. */
  focus?(id: string, cols: number, rows: number): Promise<void>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  terminate(id: string): Promise<void>;
  /** Optional cumulative output acknowledgement capability. */
  ack?(id: string, sequence: number): Promise<void>;
  /** Only this session's events. Returns its own unsubscribe. */
  subscribe(id: string, listener: (event: TerminalEvent) => void): () => void;
}

/**
 * A transport whose sessions can be found again.
 *
 * `TerminalView` demands this to accept `disposition="detach"`. A session that
 * outlives its view and that nothing can enumerate is a process the user cannot
 * see and cannot stop, which is a leak rather than a feature, so the type
 * refuses the half of the pair that leaks.
 */
export interface DetachableTerminalTransport extends TerminalTransport {
  /** Every live session, including ones no view is showing. */
  list(): Promise<TerminalSession[]>;
}

/**
 * What a host calls each terminal channel.
 *
 * No defaults. A name this package picked would be one every consumer with an
 * IPC contract of their own has to work around, which is the rule
 * `docs/embedding.md` states for `exposeBridge`'s namespace and issue #22 asks
 * for. `spawn` through `list` are requests the renderer makes; `data` and
 * `exit` are events the host pushes.
 *
 * The two parameters let a caller pin the names to its own contract:
 * `TerminalChannels<IpcChannel, IpcEvent>` makes a channel this shell does not
 * declare a compile error rather than a silent no-op.
 */
export interface TerminalChannels<
  C extends string = string,
  E extends string = string,
> {
  spawn: C;
  write: C;
  resize: C;
  terminate: C;
  list: C;
  /** Optional: enables bounded cumulative output acknowledgements. */
  ack?: C;
  data: E;
  exit: E;
  /**
   * Optional: the authoritative size a shared session settled on. Only a host
   * that can mirror one session into several views (this application's "Copy
   * into New Window") sends this; a host with one viewer per session has
   * nothing to reconcile and can leave it undeclared.
   */
  size?: E;
}

/** What a host sends on the `data` channel. */
export interface TerminalDataMessage {
  id: string;
  data: string;
  sequence?: number;
}

/** What a host sends on the `exit` channel. */
export interface TerminalExitMessage {
  id: string;
  exitCode: number;
}

/** What a host sends on the `size` channel. */
export interface TerminalSizeMessage {
  id: string;
  cols: number;
  rows: number;
}

export interface TerminalTransportOptions<
  C extends string = string,
  E extends string = string,
> {
  /** The caller's own request call. Its contract types the request; this does not. */
  invoke: (channel: C, request?: unknown) => Promise<unknown>;
  /** The caller's own subscription. It returns its own unsubscribe. */
  on: (event: E, listener: (payload: unknown) => void) => () => void;
  channels: TerminalChannels<C, E>;
}

/**
 * A transport over a caller's own IPC, given the names it uses.
 *
 * `TerminalView` takes a transport as a value, and writing one is five
 * one-line calls plus the id filtering, which every consumer would write the
 * same way and one of them would get wrong. This is that wiring, with nothing
 * of this repository's contract in it.
 *
 * The two events are per host, not per session, so a host that owns several
 * sessions sends every view every event and each subscription filters by id.
 *
 * Each payload is asserted rather than parsed. The caller's contract already
 * types what its own channels carry, and a validator here would be a second
 * shape to keep in step with the first.
 */
export function createTerminalTransport<C extends string, E extends string>({
  invoke,
  on,
  channels,
}: TerminalTransportOptions<C, E>): DetachableTerminalTransport {
  return {
    async spawn({ id, cwd, shell, cols, rows }) {
      await invoke(channels.spawn, { id, cols, rows, shell, cwd });
    },

    async write(id, data) {
      await invoke(channels.write, { id, data });
    },

    async resize(id, cols, rows) {
      await invoke(channels.resize, { id, cols, rows });
    },

    async terminate(id) {
      await invoke(channels.terminate, { id });
    },

    ack: channels.ack
      ? async function ack(id: string, sequence: number): Promise<void> {
          await invoke(channels.ack!, { id, sequence });
        }
      : undefined,

    async list() {
      return (await invoke(channels.list)) as TerminalSession[];
    },

    subscribe(id, listener) {
      const onData = on(channels.data, (payload) => {
        const message = payload as TerminalDataMessage;
        if (message.id === id) {
          listener({ type: 'data', data: message.data, sequence: message.sequence });
        }
      });

      const onExit = on(channels.exit, (payload) => {
        const message = payload as TerminalExitMessage;
        if (message.id === id) {
          listener({ type: 'exit', exitCode: message.exitCode });
        }
      });

      const onSize = channels.size
        ? on(channels.size, (payload) => {
            const message = payload as TerminalSizeMessage;
            if (message.id === id) {
              listener({ type: 'size', cols: message.cols, rows: message.rows });
            }
          })
        : undefined;

      return () => {
        onData();
        onExit();
        onSize?.();
      };
    },
  };
}

/**
 * The colours the emulator needs, resolved from custom properties.
 *
 * The emulator renders its own cells, so it takes literal colour strings.
 * `read` returns a property's current value; taking it as a
 * parameter keeps this pure and lets a consumer resolve its own namespace.
 *
 * A property that does not resolve is left out rather than passed through
 * empty. Omitting the key keeps the emulator's legible default.
 */
export function readTerminalTheme(
  read: (property: string) => string,
  properties: { background: string; foreground: string; cursor: string },
): TerminalTheme {
  const theme: TerminalTheme = {};

  const background = read(properties.background).trim();
  if (background) theme.background = background;

  const foreground = read(properties.foreground).trim();
  if (foreground) theme.foreground = foreground;

  const cursor = read(properties.cursor).trim();
  if (cursor) theme.cursor = cursor;

  return theme;
}

/**
 * The properties a consumer of this package supplies.
 *
 * Three, not a palette. The sixteen ANSI colours stay at the emulator's own
 * default, because a shell's own colours are not the host application's to
 * restyle. Defining more `--shell-terminal-*` names changes nothing.
 */
export const SHELL_TERMINAL_PROPERTIES = {
  background: '--shell-terminal-background',
  foreground: '--shell-terminal-foreground',
  cursor: '--shell-terminal-cursor',
} as const;
