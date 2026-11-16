import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  animationFrameScheduler,
  TerminalAcknowledgements,
  TerminalResizes,
} from "./ack.js"

import {
  createTerminalEmulator,
  type GhosttyWindowAdjustment,
  type TerminalEmulator,
  type TerminalEmulatorKind,
  type TerminalTheme,
  type TerminalTypography,
} from "./emulator.js"
import type { TerminalSplitDirection } from "./pane.js"
import type {
  DetachableTerminalTransport,
  TerminalDescriptor,
  TerminalTransport,
} from "./transport.js"

export type TerminalHost = HTMLDivElement & { __terminal?: TerminalEmulator }

interface TerminalViewCommonProps extends TerminalDescriptor {
  emulator?: TerminalEmulatorKind
  ghosttyWindow?: GhosttyWindowAdjustment
  typography?: TerminalTypography
  theme?: TerminalTheme
  testId?: string
  focusRequest?: number
  focused?: boolean
  focusIndicator?: boolean
  onActivate?: () => void
  onFocus?: () => void
  onSplit?: (direction: TerminalSplitDirection) => void
  onNavigateSplit?: (direction: "previous" | "next") => void
  onExit?: (exitCode: number) => void
  onError?: (error: unknown) => void
  onTitleChange?: (title: string) => void
  labels?: { startFailed: string; retry: string }
}

interface FocusSession {
  readonly id: string
  readonly transport: TerminalTransport
}

const mounted = (ref: {
  readonly current: HTMLDivElement | null
}): HTMLDivElement | null => ref.current

export type TerminalViewProps = TerminalViewCommonProps &
  (
    | { disposition?: "terminate"; transport: TerminalTransport }
    | { disposition: "detach"; transport: DetachableTerminalTransport }
    | { disposition: "preserve"; transport: TerminalTransport }
  )

export function TerminalView({
  id,
  cwd,
  shell,
  ariaLabel = "Terminal",
  transport,
  disposition = "terminate",
  emulator = "xterm",
  ghosttyWindow,
  typography,
  theme,
  testId = "terminal",
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
  labels = { startFailed: "Terminal could not start.", retry: "Retry" },
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<TerminalEmulator | undefined>(undefined)
  const lifecycle = useRef({ id, generation: 0 })
  const callbacks = useRef({
    onSplit,
    onNavigateSplit,
    onExit,
    onError,
    onTitleChange,
  })
  const pendingFocusRequest = useRef(focusRequest)
  const requestedFocus = useRef(focused)
  const [nativeFocused, setNativeFocused] = useState(() => document.hasFocus())
  const nativeWindowFocused = useRef(nativeFocused)
  const programmaticFocus = useRef(false)
  const handledFocusRequest = useRef(0)
  const [startFailed, setStartFailed] = useState(false)
  const [startAttempt, setStartAttempt] = useState(0)
  const [hasFocus, setHasFocus] = useState(false)
  callbacks.current = {
    onSplit,
    onNavigateSplit,
    onExit,
    onError,
    onTitleChange,
  }
  pendingFocusRequest.current = focusRequest
  requestedFocus.current = focused

  useEffect(() => {
    if (typography) terminal.current?.setTypography(typography)
  }, [typography])

  useEffect(() => {
    terminal.current?.setAppearance(theme, ghosttyWindow)
  }, [ghosttyWindow, theme])

  const onUnmount = useRef(disposition)
  onUnmount.current = disposition
  const shownSession = useRef<FocusSession>({ id, transport })
  shownSession.current = { id, transport }
  const focusTransport = useCallback((session: FocusSession): void => {
    const term = terminal.current
    if (!term) return
    const focusedTransport = session.transport.focus?.(
      session.id,
      term.cols,
      term.rows,
    )
    if (focusedTransport)
      void focusedTransport.catch((error: unknown) =>
        callbacks.current.onError?.(error),
      )
  }, [])
  const focusEmulator = useCallback(
    (
      renewLease: boolean,
      session: FocusSession = shownSession.current,
    ): void => {
      if (!terminal.current || !nativeWindowFocused.current) return
      programmaticFocus.current = true
      try {
        terminal.current.focus()
      } finally {
        programmaticFocus.current = false
      }
      if (renewLease) focusTransport(session)
    },
    [focusTransport],
  )
  const startValues = {
    cwd,
    shell,
    transport,
    theme,
    ghosttyWindow,
    typography,
  }
  const startWith = useRef(startValues)
  startWith.current = startValues
  const start = useMemo(
    () => ({ emulator, id, attempt: startAttempt }),
    [emulator, id, startAttempt],
  )

  useEffect(() => {
    const element = host.current
    if (!element) return
    const { emulator, id } = start
    const { cwd, shell, transport, theme, ghosttyWindow, typography } =
      startWith.current
    const generation = lifecycle.current.generation + 1
    lifecycle.current = { id, generation }

    let disposed = false
    const isDisposed = (): boolean => disposed
    let failed = false
    let spawnAttempted = false
    let term: TerminalEmulator | undefined
    let unsubscribe: (() => void) | undefined
    let cleanupObserver: (() => void) | undefined
    let clampedRemoteSize: { cols: number; rows: number } | undefined
    const reportFailure = (error?: unknown): void => {
      if (disposed || failed) return
      failed = true
      callbacks.current.onError?.(error)
      cleanupObserver?.()
      cleanupObserver = undefined
      unsubscribe?.()
      unsubscribe = undefined
      if (terminal.current === term) terminal.current = undefined
      term?.dispose()
      term = undefined
      setStartFailed(true)
      if (spawnAttempted) void transport.terminate(id).catch(() => undefined)
    }
    const acknowledgements = new TerminalAcknowledgements((sequence) => {
      if (disposed || failed) return
      const acknowledgement = transport.ack?.(id, sequence)
      if (acknowledgement) void acknowledgement.catch(reportFailure)
    }, animationFrameScheduler)
    const resizes = new TerminalResizes((cols, rows) => {
      if (disposed || failed) return
      if (
        !nativeWindowFocused.current ||
        requestedFocus.current === false ||
        (requestedFocus.current === undefined &&
          !host.current?.contains(document.activeElement))
      )
        return
      if (
        clampedRemoteSize &&
        clampedRemoteSize.cols === cols &&
        clampedRemoteSize.rows === rows
      ) {
        clampedRemoteSize = undefined
        return
      }
      void transport.resize(id, cols, rows).catch(reportFailure)
    }, animationFrameScheduler)

    void Promise.resolve()
      .then(async () => {
        if (disposed || mounted(host) === null) return

        term = await createTerminalEmulator(
          emulator,
          theme,
          ghosttyWindow,
          typography,
        )
        const opening = mounted(host)
        if (isDisposed() || opening === null) {
          term.dispose()
          return
        }
        await term.open(opening)
        if (isDisposed() || mounted(host) === null) {
          term.dispose()
          return
        }
        term.fit()
        terminal.current = term
        const windowFocused = document.hasFocus()
        nativeWindowFocused.current = windowFocused
        setNativeFocused(windowFocused)
        if (!nativeWindowFocused.current || requestedFocus.current === false) {
          term.blur()
        } else if (
          requestedFocus.current === true ||
          pendingFocusRequest.current > handledFocusRequest.current
        ) {
          handledFocusRequest.current = pendingFocusRequest.current
          focusEmulator(requestedFocus.current === true, { id, transport })
        }

        ;(host.current as TerminalHost).__terminal = term

        term.onData((data) => {
          if (!disposed && !failed) {
            void transport.write(id, data).catch(reportFailure)
          }
        })

        term.onResize(({ cols, rows }) => {
          resizes.update(cols, rows)
        })

        term.onKeyEvent((event) => {
          if (event.type !== "keydown" || !event.metaKey) return false
          const key = event.key.toLowerCase()
          if (key === "d" && callbacks.current.onSplit) {
            event.preventDefault()
            event.stopPropagation()
            callbacks.current.onSplit(event.shiftKey ? "down" : "right")
            return true
          }
          if (
            (key === "[" || key === "]") &&
            callbacks.current.onNavigateSplit
          ) {
            callbacks.current.onNavigateSplit(key === "[" ? "previous" : "next")
            return true
          }
          if (key === "k") {
            term?.clear()
            return true
          }
          if (key === "a") {
            term?.selectAll()
            return true
          }
          if (event.key === "Home") {
            term?.scrollToTop()
            return true
          }
          if (event.key === "End") {
            term?.scrollToBottom()
            return true
          }
          return false
        })

        term.onTitleChange((title) => {
          callbacks.current.onTitleChange?.(title)
        })

        unsubscribe = transport.subscribe(id, (event) => {
          if (failed) return
          if (event.type === "data") {
            term?.write(event.data, () => {
              if (event.sequence !== undefined)
                acknowledgements.consume(event.sequence)
            })
          } else if (event.type === "size") {
            if (
              term &&
              (term.cols !== event.cols || term.rows !== event.rows)
            ) {
              clampedRemoteSize = { cols: event.cols, rows: event.rows }
              term.resize(event.cols, event.rows)
            }
          } else if (callbacks.current.onExit) {
            callbacks.current.onExit(event.exitCode)
          } else {
            term?.write(
              `\r\n\x1b[2m[process exited with ${String(event.exitCode)}]\x1b[0m\r\n`,
            )
          }
        })

        spawnAttempted = true
        await transport.spawn({
          id,
          cwd,
          shell,
          cols: term.cols,
          rows: term.rows,
        })

        const observer = new ResizeObserver(() => {
          if (!disposed) term?.fit()
        })
        observer.observe(element)
        cleanupObserver = () => {
          observer.disconnect()
        }
      })
      .catch(reportFailure)

    return () => {
      disposed = true
      acknowledgements.dispose()
      resizes.dispose()
      cleanupObserver?.()
      unsubscribe?.()
      const disposition = onUnmount.current
      queueMicrotask(() => {
        const current = lifecycle.current
        const remountedSameSession =
          current.generation !== generation && current.id === id
        if (!remountedSameSession && disposition === "terminate") {
          void transport.terminate(id).catch(() => undefined)
        }
      })
      if (terminal.current === term) terminal.current = undefined
      term?.dispose()
    }
  }, [start, focusEmulator])

  useEffect(() => {
    if (!terminal.current) return
    if (!nativeWindowFocused.current || focused === false) {
      terminal.current.blur()
      setHasFocus(false)
      return
    }
    if (focused === true || focusRequest > handledFocusRequest.current) {
      handledFocusRequest.current = focusRequest
      focusEmulator(focused === true)
    }
  }, [focusRequest, focused, focusEmulator])

  useEffect(() => {
    const restoreWindowFocus = () => {
      nativeWindowFocused.current = true
      setNativeFocused(true)
      if (requestedFocus.current !== false) {
        focusEmulator(true)
      }
      setHasFocus(Boolean(host.current?.contains(document.activeElement)))
    }
    const relinquishWindowFocus = () => {
      nativeWindowFocused.current = false
      setNativeFocused(false)
      terminal.current?.blur()
      setHasFocus(false)
    }
    window.addEventListener("focus", restoreWindowFocus)
    window.addEventListener("blur", relinquishWindowFocus)
    return () => {
      window.removeEventListener("focus", restoreWindowFocus)
      window.removeEventListener("blur", relinquishWindowFocus)
    }
  }, [focusEmulator])

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
        setHasFocus(nativeWindowFocused.current)
        if (
          nativeWindowFocused.current &&
          focused === undefined &&
          !programmaticFocus.current
        )
          focusTransport(shownSession.current)
        onFocus?.()
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setHasFocus(false)
        }
      }}
      onPointerDownCapture={() => {
        focusEmulator(focused === true)
        onActivate?.()
      }}
    >
      {startFailed && (
        <div className="terminal__error" role="alert">
          <span>{labels.startFailed}</span>
          <button
            type="button"
            onClick={() => {
              setStartFailed(false)
              setStartAttempt((attempt) => attempt + 1)
            }}
          >
            {labels.retry}
          </button>
        </div>
      )}
    </div>
  )
}
