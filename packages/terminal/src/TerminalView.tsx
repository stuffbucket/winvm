import { useEffect, useRef, useState } from 'react';

import type { TerminalSplitDirection } from './pane.js';

import {
  createTerminalEmulator,
  type GhosttyWindowAdjustment,
  type TerminalTypography,
  type TerminalEmulator,
  type TerminalEmulatorKind,
  type TerminalTheme,
} from './emulator.js';
import type {
  DetachableTerminalTransport,
  TerminalDescriptor,
  TerminalTransport,
} from './transport.js';
import {
  animationFrameScheduler,
  TerminalAcknowledgements,
  TerminalResizes,
} from './ack.js';

/**
 * A real terminal, driven by an injected transport.
 *
 * Theme and window effects update through the emulator adapter without
 * replacing terminal state or scrollback.
 *
 * **Unmounting terminates the session, unless the caller says otherwise.** See
 * `disposition`.
 */

/** The host element carries the terminal instance, for end-to-end tests. */
export type TerminalHost = HTMLDivElement & { __terminal?: TerminalEmulator };

interface TerminalViewCommonProps extends TerminalDescriptor {
  /** Terminal engine. The default is `xterm`. */
  emulator?: TerminalEmulatorKind;
  /** Window geometry and background effects applied only by the Ghostty adapter. */
  ghosttyWindow?: GhosttyWindowAdjustment;
  typography?: TerminalTypography;
  /** Literal colours. Resolve with `readTerminalTheme`. */
  theme?: TerminalTheme;
  testId?: string;
  /** Increasing token for explicit split-navigation focus requests. */
  focusRequest?: number;
  /** Parent-owned focus identity when this view is one leaf of a split. */
  focused?: boolean;
  focusIndicator?: boolean;
  /** User pointer activation, distinct from emulator-driven focus changes. */
  onActivate?: () => void;
  onFocus?: () => void;
  onSplit?: (direction: TerminalSplitDirection) => void;
  onNavigateSplit?: (direction: 'previous' | 'next') => void;
  onExit?: (exitCode: number) => void;
  onError?: (error: unknown) => void;
  onTitleChange?: (title: string) => void;
  /** winvm: the start-failure notice's words, for a caller with its own catalog. */
  labels?: { startFailed: string; retry: string };
}

/**
 * The view's own lifetime, and the session's, as two decisions.
 *
 * `detach` needs a transport that can list its sessions, because a shell that
 * outlives every view and that nothing can enumerate is a process the user
 * cannot see and cannot stop. Requiring `list` here is what stops half the
 * feature shipping.
 */
export type TerminalViewProps = TerminalViewCommonProps &
  (
    | { disposition?: 'terminate'; transport: TerminalTransport }
    | { disposition: 'detach'; transport: DetachableTerminalTransport }
    | { disposition: 'preserve'; transport: TerminalTransport }
  );

/**
 * One terminal, drawn by the configured emulator.
 *
 * It takes a transport rather than reaching for a bridge, which is what keeps
 * this package free of any particular IPC contract: build one with
 * `createTerminalTransport` and name your own channels. The emulator inherits
 * nothing from CSS, so `theme` carries literal colours — `readTerminalTheme`
 * with `SHELL_TERMINAL_PROPERTIES` resolves them from the shell contract.
 */
export function TerminalView({
  id,
  cwd,
  shell,
  ariaLabel = 'Terminal',
  transport,
  disposition = 'terminate',
  emulator = 'xterm',
  ghosttyWindow,
  typography,
  theme,
  testId = 'terminal',
  focusRequest = 0,
  focused,
  focusIndicator = false,
  onActivate,
  onFocus,
  onSplit,
  onNavigateSplit,
  onExit,
  onError,
  onTitleChange,
  labels = { startFailed: 'Terminal could not start.', retry: 'Retry' },
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<TerminalEmulator | undefined>(undefined);
  const lifecycle = useRef({ id, generation: 0 });
  const callbacks = useRef({ onSplit, onNavigateSplit, onExit, onError, onTitleChange });
  const pendingFocusRequest = useRef(focusRequest);
  const requestedFocus = useRef(focused);
  const [nativeFocused, setNativeFocused] = useState(() => document.hasFocus());
  const nativeWindowFocused = useRef(nativeFocused);
  const programmaticFocus = useRef(false);
  const handledFocusRequest = useRef(0);
  const [startFailed, setStartFailed] = useState(false);
  const [startAttempt, setStartAttempt] = useState(0);
  const [hasFocus, setHasFocus] = useState(false);
  callbacks.current = { onSplit, onNavigateSplit, onExit, onError, onTitleChange };
  pendingFocusRequest.current = focusRequest;
  requestedFocus.current = focused;

  useEffect(() => {
    if (typography) terminal.current?.setTypography(typography);
  }, [typography]);

  useEffect(() => {
    terminal.current?.setAppearance(theme, ghosttyWindow);
  }, [ghosttyWindow, theme]);

  // The disposition is read at cleanup rather than at mount, so a caller that
  // changes it while a session runs gets the current answer.
  const onUnmount = useRef(disposition);
  onUnmount.current = disposition;
  const focusTransport = (): void => {
    const term = terminal.current;
    if (!term) return;
    const focusedTransport = transport.focus?.(id, term.cols, term.rows);
    if (focusedTransport) void focusedTransport.catch((error) => callbacks.current.onError?.(error));
  };
  const focusEmulator = (renewLease: boolean): void => {
    if (!terminal.current || !nativeWindowFocused.current) return;
    programmaticFocus.current = true;
    try {
      terminal.current.focus();
    } finally {
      programmaticFocus.current = false;
    }
    if (renewLease) focusTransport();
  };

  // `id` identifies the session for this view's lifetime. Re-running this
  // effect would orphan a shell, so the descriptor fields read at spawn time
  // are deliberately not dependencies.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const generation = lifecycle.current.generation + 1;
    lifecycle.current = { id, generation };

    let disposed = false;
    let failed = false;
    let spawnAttempted = false;
    let term: TerminalEmulator | undefined;
    let unsubscribe: (() => void) | undefined;
    let cleanupObserver: (() => void) | undefined;
    // Set right before a `pty:size` event clamps the local grid, and cleared
    // once consumed. `TerminalResizes` coalesces every `onResize`, including
    // the one that clamp causes, so this tells that callback the resize was
    // an echo of a size the host already knows about rather than a fresh
    // measurement to send back.
    let clampedRemoteSize: { cols: number; rows: number } | undefined;
    const reportFailure = (error?: unknown): void => {
      if (disposed || failed) return;
      failed = true;
      callbacks.current.onError?.(error);
      cleanupObserver?.();
      cleanupObserver = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      if (terminal.current === term) terminal.current = undefined;
      term?.dispose();
      term = undefined;
      setStartFailed(true);
      if (spawnAttempted) void transport.terminate(id).catch(() => undefined);
    };
    const acknowledgements = new TerminalAcknowledgements(
      (sequence) => {
        if (disposed || failed) return;
        const acknowledgement = transport.ack?.(id, sequence);
        if (acknowledgement) void acknowledgement.catch(reportFailure);
      },
      animationFrameScheduler,
    );
    const resizes = new TerminalResizes(
      (cols, rows) => {
        if (disposed || failed) return;
        if (
          !nativeWindowFocused.current
          || requestedFocus.current === false
          || (
            requestedFocus.current === undefined
            && !host.current?.contains(document.activeElement)
          )
        ) return;
        if (clampedRemoteSize && clampedRemoteSize.cols === cols && clampedRemoteSize.rows === rows) {
          clampedRemoteSize = undefined;
          return;
        }
        void transport.resize(id, cols, rows).catch(reportFailure);
      },
      animationFrameScheduler,
    );

    void Promise.resolve().then(async () => {
      if (disposed || !host.current) return;

      term = await createTerminalEmulator(
        emulator,
        theme,
        ghosttyWindow,
        typography,
      );
      if (disposed || !host.current) {
        term.dispose();
        return;
      }
      await term.open(host.current);
      if (disposed || !host.current) {
        term.dispose();
        return;
      }
      term.fit();
      terminal.current = term;
      const windowFocused = document.hasFocus();
      nativeWindowFocused.current = windowFocused;
      setNativeFocused(windowFocused);
      if (!nativeWindowFocused.current || requestedFocus.current === false) {
        term.blur();
      } else if (
        requestedFocus.current === true
        || pendingFocusRequest.current > handledFocusRequest.current
      ) {
        handledFocusRequest.current = pendingFocusRequest.current;
        focusEmulator(requestedFocus.current === true);
      }

      // The buffer is the stable assertion surface across canvas and DOM renderers.
      (host.current as TerminalHost).__terminal = term;

      term.onData((data) => {
        if (!disposed && !failed) {
          void transport.write(id, data).catch(reportFailure);
        }
      });

      term.onResize(({ cols, rows }) => {
        resizes.update(cols, rows);
      });

      term.onKeyEvent((event) => {
        if (event.type !== 'keydown' || !event.metaKey) return false;
        const key = event.key.toLowerCase();
        if (key === 'd' && callbacks.current.onSplit) {
          event.preventDefault();
          event.stopPropagation();
          callbacks.current.onSplit(event.shiftKey ? 'down' : 'right');
          return true;
        }
        if ((key === '[' || key === ']') && callbacks.current.onNavigateSplit) {
          callbacks.current.onNavigateSplit(key === '[' ? 'previous' : 'next');
          return true;
        }
        if (key === 'k') {
          term?.clear();
          return true;
        }
        if (key === 'a') {
          term?.selectAll();
          return true;
        }
        if (event.key === 'Home') {
          term?.scrollToTop();
          return true;
        }
        if (event.key === 'End') {
          term?.scrollToBottom();
          return true;
        }
        return false;
      });

      term.onTitleChange((title) => {
        callbacks.current.onTitleChange?.(title);
      });

      unsubscribe = transport.subscribe(id, (event) => {
        if (failed) return;
        if (event.type === 'data') {
          term?.write(event.data, () => {
            if (event.sequence !== undefined) acknowledgements.consume(event.sequence);
          });
        }
        else if (event.type === 'size') {
          // The host resized the real PTY to the smallest live viewer of a
          // shared session. Clamping the local grid to match keeps this view
          // from rendering a byte stream that now assumes different
          // dimensions than the ones its own container fit to.
          if (term && (term.cols !== event.cols || term.rows !== event.rows)) {
            clampedRemoteSize = { cols: event.cols, rows: event.rows };
            term.resize(event.cols, event.rows);
          }
        }
        else if (callbacks.current.onExit) {
          callbacks.current.onExit(event.exitCode);
        }
        else {
          term?.write(
            `\r\n\x1b[2m[process exited with ${String(event.exitCode)}]\x1b[0m\r\n`,
          );
        }
      });

      spawnAttempted = true;
      await transport.spawn({ id, cwd, shell, cols: term.cols, rows: term.rows });

      // The panel group resizes the host without a window resize, so a
      // ResizeObserver is the only reliable trigger.
      const observer = new ResizeObserver(() => {
        if (!disposed) term?.fit();
      });
      observer.observe(element);
      cleanupObserver = () => observer.disconnect();
    }).catch(reportFailure);

    return () => {
      disposed = true;
      acknowledgements.dispose();
      resizes.dispose();
      cleanupObserver?.();
      unsubscribe?.();
      const disposition = onUnmount.current;
      queueMicrotask(() => {
        const current = lifecycle.current;
        const remountedSameSession = current.generation !== generation && current.id === id;
        if (!remountedSameSession && disposition === 'terminate') {
          void transport.terminate(id).catch(() => undefined);
        }
      });
      if (terminal.current === term) terminal.current = undefined;
      term?.dispose();
    };
  }, [emulator, id, startAttempt]);

  useEffect(() => {
    if (!terminal.current) return;
    if (!nativeWindowFocused.current || focused === false) {
      terminal.current.blur();
      setHasFocus(false);
      return;
    }
    if (focused === true || focusRequest > handledFocusRequest.current) {
      handledFocusRequest.current = focusRequest;
      focusEmulator(focused === true);
    }
  }, [focusRequest, focused]);

  useEffect(() => {
    const restoreWindowFocus = () => {
      nativeWindowFocused.current = true;
      setNativeFocused(true);
      if (requestedFocus.current !== false) {
        focusEmulator(true);
      }
      setHasFocus(Boolean(host.current?.contains(document.activeElement)));
    };
    const relinquishWindowFocus = () => {
      nativeWindowFocused.current = false;
      setNativeFocused(false);
      terminal.current?.blur();
      setHasFocus(false);
    };
    window.addEventListener('focus', restoreWindowFocus);
    window.addEventListener('blur', relinquishWindowFocus);
    return () => {
      window.removeEventListener('focus', restoreWindowFocus);
      window.removeEventListener('blur', relinquishWindowFocus);
    };
  }, []);

  return (
    <div
      className="terminal"
      data-testid={testId}
      data-session-id={id}
      data-focused={(nativeFocused && (focused ?? hasFocus)) || undefined}
      data-focus-indicator={focusIndicator || undefined}
      role="group"
      aria-label={ariaLabel}
      ref={host}
      onFocus={() => {
        setHasFocus(nativeWindowFocused.current);
        if (
          nativeWindowFocused.current
          && focused === undefined
          && !programmaticFocus.current
        ) focusTransport();
        onFocus?.();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setHasFocus(false);
        }
      }}
      onPointerDownCapture={() => {
        focusEmulator(focused === true);
        onActivate?.();
      }}
    >
      {startFailed && (
        <div className="terminal__error" role="alert">
          <span>{labels.startFailed}</span>
          <button
            type="button"
            onClick={() => {
              setStartFailed(false);
              setStartAttempt((attempt) => attempt + 1);
            }}
          >
            {labels.retry}
          </button>
        </div>
      )}
    </div>
  );
}
