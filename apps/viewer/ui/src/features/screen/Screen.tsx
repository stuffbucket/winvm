import {
  drawSize,
  guestSizeFor,
  type Size,
  sameSize,
  scaleFor,
} from "@winvm/displayfit"
import * as KeyboardUtil from "@winvm/novnc/core/input/util.js"
import RFB from "@winvm/novnc/core/rfb.js"
import { clientToElement } from "@winvm/novnc/core/util/element.js"
import { releaseCapture } from "@winvm/novnc/core/util/events.js"
import {
  forwardRef,
  type JSX,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { copyText, onLiveResize, readText, trace } from "../../backend"
import { cx } from "../../components/cx"
import { Icon } from "../../components/Icon"
import { pixelRatio, watchPixelRatio } from "../../dpr"
import { t } from "../../i18n"
import type { Connection } from "../../model"
import { ClipboardSync } from "./clipboard"
import { HeldSizes, keyVerdict } from "./held"
import { GuestPointerRouter, releaseNoVncPointer } from "./input"
import {
  GuestKeyboardRouter,
  sendCtrlAltDelete,
  sendWindowsKey,
} from "./keyboard"
import { LiveResize, type ResizePhase } from "./resize"
import { keepRefreshing, type WakeSock } from "./wake"

interface ScreenProps {
  readonly connection: Connection
  readonly keyboardCaptured: boolean
  onKeyboardCaptured: (captured: boolean) => void
  readonly resizable: boolean
  readonly onGuestSize?: (size: Size, scale: number) => Promise<void>
  readonly forwardInput: boolean
  readonly frozen?: boolean
  readonly ready?: boolean
  readonly asleep?: boolean
  readonly waking?: boolean
  onWake?: () => void
  readonly overlay?: boolean
}

export interface ScreenHandle {
  sendWindowsKey(): void
  sendCtrlAltDelete(): void
}

type View = "connecting" | "connected" | "lost" | "refused"

const FRAME_WAIT_MS = 150

const CLIPBOARD_CAPS_MS = 2000
const CLIPBOARD_TEXT = 1

const dpr = pixelRatio

export const Screen = forwardRef<ScreenHandle, ScreenProps>(function Screen(
  {
    connection,
    keyboardCaptured,
    onKeyboardCaptured,
    forwardInput,
    resizable,
    onGuestSize,
    frozen = false,
    ready = true,
    asleep = false,
    waking = false,
    onWake,
    overlay = true,
  },
  ref,
): JSX.Element {
  const area = useRef<HTMLDivElement | null>(null)
  const target = useRef<HTMLDivElement | null>(null)
  const still = useRef<HTMLCanvasElement | null>(null)
  const rfb = useRef<RFB | null>(null)
  const keyboard = useRef<GuestKeyboardRouter | null>(null)
  const pointerInput = useRef<GuestPointerRouter | null>(null)
  const [view, setView] = useState<View>("connecting")
  const [attempt, setAttempt] = useState(0)
  const [fb, setFb] = useState<Size | null>(null)
  const [box, setBox] = useState<Size | null>(null)
  const [ratio, setRatio] = useState(dpr)
  const [phase, setPhase] = useState<ResizePhase>("settled")
  const [held, setHeld] = useState(false)
  const { websocketPort, password } = connection
  const session = useMemo(
    () => ({ websocketPort, password, attempt }),
    [websocketPort, password, attempt],
  )
  const guestSize = useRef(onGuestSize)
  guestSize.current = onGuestSize
  const live = useRef<LiveResize | null>(null)
  const askAgain = (): void => {
    const resize = live.current
    const outer = area.current
    if (resize === null || outer === null) return
    const r = outer.getBoundingClientRect()
    resize.reset()
    resize.want(guestSizeFor({ width: r.width, height: r.height }, dpr()))
    resize.flush()
  }
  const askAgainRef = useRef(askAgain)
  askAgainRef.current = askAgain
  const heldSizes = useRef<HeldSizes | null>(null)
  heldSizes.current ??= new HeldSizes(frozen || !ready, {
    onRetry: () => {
      askAgainRef.current()
    },
  })
  const keys = useRef({ frozen, asleep, waking, onWake, forward: forwardInput })
  keys.current.forward = forwardInput
  keys.current.frozen = frozen
  keys.current.asleep = asleep
  keys.current.waking = waking
  keys.current.onWake = onWake
  const captured = useRef(keyboardCaptured)
  captured.current = keyboardCaptured
  const captureChanged = useRef(onKeyboardCaptured)
  captureChanged.current = onKeyboardCaptured
  const clipboardSync = useRef<ClipboardSync | null>(null)

  useImperativeHandle(
    ref,
    () => ({
      sendWindowsKey: () => {
        const conn = rfb.current
        if (conn !== null && keys.current.forward)
          sendWindowsKey((keysym, code, down) => {
            conn.sendKey(keysym, code, down)
          })
      },
      sendCtrlAltDelete: () => {
        const conn = rfb.current
        if (conn !== null && keys.current.forward)
          sendCtrlAltDelete((keysym, code, down) => {
            conn.sendKey(keysym, code, down)
          })
      },
    }),
    [],
  )

  useEffect(
    () => keyboard.current?.setCaptured(keyboardCaptured),
    [keyboardCaptured],
  )

  useEffect(() => {
    const el = target.current
    const outer = area.current
    if (el === null || outer === null) return
    let closing = false
    let connected = false
    let conn: RFB | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopWake: (() => void) | null = null
    setView("connecting")
    const pointer = new GuestPointerRouter((point) => {
      if (conn === null) return
      const canvas = el.querySelector("canvas")
      const pos =
        point !== null && canvas !== null
          ? clientToElement(point.x, point.y, canvas)
          : { x: 0, y: 0 }
      releaseNoVncPointer(conn, pos, releaseCapture)
    })
    pointer.setEnabled(keys.current.forward)
    pointer.setFocused(document.hasFocus())
    const onPointer = (event: MouseEvent): void => {
      pointer.setEnabled(keys.current.forward && el.closest("[inert]") === null)
      pointer.handle(event)
    }
    const onScreenBlur = (event: FocusEvent): void => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !el.contains(event.relatedTarget)
      )
        pointer.releaseAll()
    }
    const pointerEvents = [
      "mousedown",
      "mouseup",
      "mousemove",
      "wheel",
    ] as const
    for (const name of pointerEvents) el.addEventListener(name, onPointer, true)
    el.addEventListener("focusout", onScreenBlur)
    pointerInput.current = pointer
    const router = new GuestKeyboardRouter({
      send: (keysym, code, down) => conn?.sendKey(keysym, code, down),
      translate: (event) => {
        const keyboardEvent = event as KeyboardEvent
        const keysym = KeyboardUtil.getKeysym(keyboardEvent)
        return keysym === null
          ? null
          : { keysym, code: KeyboardUtil.getKeycode(keyboardEvent) }
      },
      releaseNoVnc: () => conn?._keyboard._allKeysUp(),
      onCaptured: (next) => {
        captureChanged.current(next)
      },
    })
    router.setCaptured(captured.current)
    router.setEnabled(keys.current.forward)
    const onKeyDown = (event: KeyboardEvent): void => {
      router.keyDown(event)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      router.keyUp(event)
    }
    const onBlur = (event: FocusEvent): void => {
      if (event.target === window) pointer.setFocused(false)
      router.lostFocus()
    }
    const onVisibility = (): void => {
      pointer.setFocused(
        document.visibilityState !== "hidden" && document.hasFocus(),
      )
      if (document.visibilityState === "hidden") router.lostFocus()
    }
    el.addEventListener("keydown", onKeyDown, true)
    el.addEventListener("keyup", onKeyUp, true)
    window.addEventListener("blur", onBlur, true)
    document.addEventListener("visibilitychange", onVisibility)
    keyboard.current = router

    conn = new RFB(el, `ws://127.0.0.1:${String(session.websocketPort)}`, {
      credentials: { password: session.password ?? "" },
      wsProtocols: ["binary"],
    })
    rfb.current = conn
    conn.background = "transparent"
    conn.scaleViewport = true
    conn.resizeSession = false
    conn.qualityLevel = 9
    conn.focusOnClick = keys.current.forward || keys.current.asleep
    conn.viewOnly = !keys.current.forward

    const measure = (): Size => {
      const r = outer.getBoundingClientRect()
      return { width: r.width, height: r.height }
    }

    const hold = (): void => {
      const from = el.querySelector("canvas")
      const to = still.current
      if (from === null || to === null || from.width === 0 || from.height === 0)
        return
      to.width = from.width
      to.height = from.height
      to.getContext("2d")?.drawImage(from, 0, 0)
      setHeld(true)
    }

    const resize = resizable
      ? new LiveResize({
          request: async (size) => {
            if (!connected || closing) return
            const sizes = heldSizes.current
            if (sizes === null || !sizes.offer(size)) return
            RFB.messages.setDesktopSize(
              conn._sock,
              size.width,
              size.height,
              conn._screenID ?? 0,
              conn._screenFlags ?? 0,
            )
            try {
              await guestSize.current?.(size, scaleFor(dpr()))
              sizes.took()
            } catch (error) {
              console.warn("resizing the guest failed; asking again", error)
              sizes.missed(size)
            }
          },
          onPhase: (next, settled) => {
            if (next === "resizing") hold()
            else {
              setBox(measure())
              setRatio(dpr())
              if (
                settled !== null &&
                settled.ms !== null &&
                settled.size !== null
              ) {
                const { width, height } = settled.size
                const line = `resize: ${String(width)}x${String(height)} drawn 1:1 ${String(Math.round(settled.ms))} ms after the resize ended${settled.timedOut ? " (gave up waiting for the size asked for)" : ""}`
                console.info(line)
                trace(line)
              }
            }
            setPhase(next)
          },
        })
      : null
    live.current = resize

    const onKey = (e: KeyboardEvent): void => {
      const k = keys.current
      const verdict = keyVerdict(k, e)
      if (verdict === "pass") return
      e.preventDefault()
      e.stopPropagation()
      if (verdict === "wake") k.onWake?.()
    }
    outer.addEventListener("keydown", onKey, true)

    const display = conn._display
    const flip = display.flip.bind(display)
    let flipped: Size | null = null
    let flips = 0
    let frameWait: ReturnType<typeof setTimeout> | undefined
    const drawnAt = (size: Size): void => {
      clearTimeout(frameWait)
      setFb((cur) => (sameSize(cur, size) ? cur : size))
      if (resize === null) return
      if (resize.resizing) hold()
      resize.drawnAt(size)
    }
    display.flip = (fromQueue?: boolean): void => {
      const deferred = fromQueue !== true && display._renderQ.length !== 0
      flip(fromQueue)
      if (deferred) return
      const size = { width: display._fbWidth, height: display._fbHeight }
      if (size.width === 0 || size.height === 0) return
      if (!sameSize(size, flipped)) {
        flipped = size
        flips = 1
        clearTimeout(frameWait)
        frameWait = setTimeout(() => {
          drawnAt(size)
        }, FRAME_WAIT_MS)
      } else if (++flips === 2) drawnAt(size)
    }

    const onArea = (): void => {
      if (resize === null) {
        setBox(measure())
        setRatio(dpr())
        return
      }
      resize.want(guestSizeFor(measure(), dpr()))
      if (!resize.resizing) {
        setBox(measure())
        setRatio(dpr())
      }
    }
    const observer = new ResizeObserver(onArea)
    observer.observe(outer)
    const unlisten = onLiveResize((live) => {
      pointer.setResizing(live)
      if (live) resize?.liveStart()
      else resize?.liveEnd()
    })

    const stopRatio = watchPixelRatio(onArea)

    const clipboard = new ClipboardSync({
      readMac: readText,
      writeMac: copyText,
      toGuest: (text) => {
        conn.clipboardPasteFrom(text)
      },
      focused: () => document.hasFocus(),
      canSend: () => keys.current.forward,
    })
    clipboardSync.current = clipboard
    let clipboardReady = false
    let clipboardWait: ReturnType<typeof setTimeout> | undefined
    conn.addEventListener("clipboard", (e) => {
      const text: unknown = (e as CustomEvent<{ text?: unknown } | null>).detail
        ?.text
      if (typeof text === "string") clipboard.fromGuest(text)
    })
    const onFocus = (): void => {
      pointer.setFocused(document.visibilityState !== "hidden")
      if (clipboardReady && connected && !closing) void clipboard.fromMac()
    }
    window.addEventListener("focus", onFocus)
    const startClipboard = (since: number): void => {
      if (closing || !connected) return
      if (
        conn._clipboardServerCapabilitiesFormats?.[CLIPBOARD_TEXT] !== true &&
        performance.now() - since < CLIPBOARD_CAPS_MS
      ) {
        clipboardWait = setTimeout(() => {
          startClipboard(since)
        }, 100)
        return
      }
      clipboardReady = true
      void clipboard.start()
    }

    conn.addEventListener("connect", () => {
      connected = true
      setView("connected")
      stopWake ??= keepRefreshing(
        conn._sock as WakeSock,
        () => connected && !closing && document.visibilityState === "visible",
      )
      startClipboard(performance.now())
      if (resize !== null) {
        resize.reset()
        resize.want(guestSizeFor(measure(), dpr()))
        resize.flush()
      }
    })
    conn.addEventListener("credentialsrequired", () => {
      conn.sendCredentials({ password: session.password ?? "" })
    })
    conn.addEventListener("securityfailure", () => {
      setView("refused")
    })
    conn.addEventListener("disconnect", () => {
      pointer.releaseAll()
      connected = false
      stopWake?.()
      stopWake = null
      if (closing) return
      setView((v) => (v === "refused" ? v : "lost"))
      retry = setTimeout(() => {
        setAttempt((a) => a + 1)
      }, 2000)
    })
    return () => {
      closing = true
      clipboard.stop()
      live.current = null
      clipboardSync.current = null
      outer.removeEventListener("keydown", onKey, true)
      stopWake?.()
      resize?.cancel()
      heldSizes.current?.cancel()
      clearTimeout(frameWait)
      clearTimeout(clipboardWait)
      window.removeEventListener("focus", onFocus)
      observer.disconnect()
      unlisten()
      stopRatio()
      if (retry !== undefined) clearTimeout(retry)
      el.removeEventListener("keydown", onKeyDown, true)
      el.removeEventListener("keyup", onKeyUp, true)
      window.removeEventListener("blur", onBlur, true)
      document.removeEventListener("visibilitychange", onVisibility)
      router.lostFocus()
      pointer.releaseAll()
      for (const name of pointerEvents)
        el.removeEventListener(name, onPointer, true)
      el.removeEventListener("focusout", onScreenBlur)
      conn.disconnect()
      pointerInput.current = null
      keyboard.current = null
      rfb.current = null
      setHeld(false)
      setPhase("settled")
    }
  }, [session, resizable])

  useEffect(() => {
    keyboard.current?.setEnabled(forwardInput)
    pointerInput.current?.setEnabled(forwardInput)
    const conn = rfb.current
    if (conn === null) return
    conn.viewOnly = !forwardInput
    conn.focusOnClick = forwardInput || asleep
    if (forwardInput) void clipboardSync.current?.fromMac()
  }, [forwardInput, asleep])
  useEffect(() => {
    const kept = heldSizes.current?.setFrozen(frozen || !ready) ?? null
    if (kept !== null) askAgainRef.current()
  }, [frozen, ready])

  const fits =
    resizable &&
    fb !== null &&
    box !== null &&
    sameSize(fb, guestSizeFor(box, ratio))
  const drawn = fits ? drawSize(fb, box, ratio) : null
  const exact =
    drawn === null
      ? undefined
      : {
          width: `${String(drawn.width)}px`,
          height: `${String(drawn.height)}px`,
        }
  const scaled =
    drawn !== null && fb !== null && drawn.width > fb.width / ratio + 0.5
  const holding = resizable && phase === "resizing" && held

  const exactSize =
    exact === undefined ? null : `${exact.width} ${exact.height}`
  useLayoutEffect(() => {
    const conn = rfb.current
    if (conn !== null && exactSize !== null) conn.scaleViewport = true
  }, [exactSize])

  const message = view === "connected" ? null : t(`screen.${view}`)
  const inert = !forwardInput || view !== "connected"
  return (
    <div
      ref={area}
      className={cx("screen", inert && "screen--inert")}
      tabIndex={asleep ? -1 : undefined}
      onPointerDown={
        asleep
          ? (e) => {
              e.currentTarget.focus({ preventScroll: true })
            }
          : undefined
      }
    >
      <div
        ref={target}
        className={
          exact === undefined
            ? "screen__canvas"
            : scaled
              ? "screen__canvas screen__canvas--exact screen__canvas--scaled"
              : "screen__canvas screen__canvas--exact"
        }
        style={exact}
      />
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas without tabIndex is not focusable; this one only holds the last frame while the guest resizes */}
      <canvas
        ref={still}
        className="screen__still"
        hidden={!holding}
        aria-hidden="true"
      />
      <div
        className={cx("screen__held", frozen && overlay && "screen__held--on")}
        aria-hidden="true"
      >
        <div className="screen__held-mark">
          <Icon name={asleep ? "moon" : "pause"} />
        </div>
        {asleep && (
          <p className="screen__held-hint">{t("screen.asleepHint")}</p>
        )}
      </div>
      {message !== null && (
        <div className="screen__message" role="status">
          <p>{message}</p>
        </div>
      )}
    </div>
  )
})
