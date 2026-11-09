import RFB from "novnc/core/rfb.js"
import * as KeyboardUtil from "novnc/core/input/util.js"
import { clientToElement } from "novnc/core/util/element.js"
import { releaseCapture } from "novnc/core/util/events.js"
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react"

import { type Size, drawSize, guestSizeFor, sameSize, scaleFor } from "@winvm/displayfit"

import { copyText, onLiveResize, readText, trace } from "../../backend"
import { Icon } from "../../components/Icon"
import { cx } from "../../components/cx"
import { t } from "../../i18n"
import { pixelRatio, watchPixelRatio } from "../../dpr"
import type { Connection } from "../../model"
import { ClipboardSync } from "./clipboard"
import { HeldSizes, keyVerdict } from "./held"
import { GuestPointerRouter, releaseNoVncPointer } from "./input"
import { GuestKeyboardRouter, sendCtrlAltDelete, sendWindowsKey } from "./keyboard"
import { LiveResize, type ResizePhase } from "./resize"
import { type WakeSock, keepRefreshing } from "./wake"

interface ScreenProps {
  readonly connection: Connection
  readonly keyboardCaptured: boolean
  onKeyboardCaptured(captured: boolean): void
  /**
   * The guest's screen can follow the view (virtio-gpu). Then the viewer asks
   * QEMU for the view's size in device pixels and `onGuestSize` has the guest
   * switch to it (through its agent), and the picture is drawn one guest pixel
   * per device pixel.
   */
  readonly resizable: boolean
  readonly onGuestSize?: (size: Size, scale: number) => Promise<void>
  /**
   * The guest takes input (input.ts: Windows runs, answers, no verb under way).
   * Otherwise the frame is a picture: no mouse, wheel or key reaches the guest
   * (it would queue in QEMU and land on resume), the Mac's arrow shows over it,
   * capture is released and nothing is swallowed. Held input is let go first.
   */
  readonly forwardInput: boolean
  /** The machine is held (paused or asleep): sizes wait until it runs (held.ts), and the overlay shows. */
  readonly frozen?: boolean
  /**
   * Windows can take a size now (the app's guestReady: it runs, its agent
   * answers, no verb under way). Until then sizes wait, as while frozen, and
   * the window's size is asked for, both steps, once it can.
   */
  readonly ready?: boolean
  /** Asleep: the first key pressed in the screen wakes it (`onWake`), and isn't typed. */
  readonly asleep?: boolean
  /** A wake is under way: keys are dropped until the machine runs. */
  readonly waking?: boolean
  onWake?(): void
  /** Dim the held screen and mark it with a glyph (the "Show Pause Overlay" setting). */
  readonly overlay?: boolean
}

export interface ScreenHandle {
  sendWindowsKey(): void
  sendCtrlAltDelete(): void
}

type View = "connecting" | "connected" | "lost" | "refused"

/** A new size's first frame is the old picture redrawn; the second is the guest's. Without one, this long. */
const FRAME_WAIT_MS = 150

/** How long after connecting to wait for the server to say its clipboard takes UTF-8 before pasting anyway (as Latin-1). */
const CLIPBOARD_CAPS_MS = 2000
/** noVNC's extended-clipboard text format. */
const CLIPBOARD_TEXT = 1

const dpr = pixelRatio

/**
 * The guest's screen through QEMU's VNC websocket, interactive.
 *
 * WHILE A RESIZABLE GUEST IS RESIZED (resize.ts decides when): the last
 * picture is copied to a canvas laid over the screen and stretched to fill the
 * view, so the window's edge never shows a blank, a corner or a jump. The live
 * screen underneath carries on (sizes the guest passes through, the redraw of a
 * new size), out of sight, and the copy goes once the guest's picture is drawn
 * in full at the size asked for, one guest pixel per device pixel.
 *
 * THE CLIPBOARD (clipboard.ts), text only, while the window is in front: what
 * Windows copies goes on the Mac's clipboard; the Mac's goes to Windows when
 * the window comes forward, and once on connecting.
 */
export const Screen = forwardRef<ScreenHandle, ScreenProps>(function Screen(
  { connection, keyboardCaptured, onKeyboardCaptured, forwardInput, resizable, onGuestSize, frozen = false, ready = true, asleep = false, waking = false, onWake, overlay = true },
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
  // The framebuffer drawn, and the view's size in CSS pixels, for the 1:1 box.
  const [fb, setFb] = useState<Size | null>(null)
  const [box, setBox] = useState<Size | null>(null)
  const [ratio, setRatio] = useState(dpr)
  const [phase, setPhase] = useState<ResizePhase>("settled")
  const [held, setHeld] = useState(false)
  const { websocketPort, password } = connection
  const guestSize = useRef(onGuestSize)
  guestSize.current = onGuestSize
  const live = useRef<LiveResize | null>(null)
  // Ask again for the size the window wants now, both steps: after a hold, or a size the guest missed.
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
  heldSizes.current ??= new HeldSizes(frozen || !ready, { onRetry: () => askAgainRef.current() })
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
        if (conn !== null && keys.current.forward) sendWindowsKey((keysym, code, down) => conn.sendKey(keysym, code, down))
      },
      sendCtrlAltDelete: () => {
        const conn = rfb.current
        if (conn !== null && keys.current.forward) sendCtrlAltDelete((keysym, code, down) => conn.sendKey(keysym, code, down))
      },
    }),
    [],
  )

  useEffect(() => keyboard.current?.setCaptured(keyboardCaptured), [keyboardCaptured])

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
      const pos = point !== null && canvas !== null ? clientToElement(point.x, point.y, canvas) : { x: 0, y: 0 }
      releaseNoVncPointer(conn, pos, releaseCapture)
    })
    pointer.setEnabled(keys.current.forward)
    pointer.setFocused(document.hasFocus())
    const onPointer = (event: MouseEvent): void => {
      // A modal makes the viewer inert. Also reject noVNC's synthetic captured
      // events, which can still be dispatched into an inert subtree.
      pointer.setEnabled(keys.current.forward && el.closest("[inert]") === null)
      pointer.handle(event)
    }
    const onScreenBlur = (event: FocusEvent): void => {
      if (!(event.relatedTarget instanceof Node) || !el.contains(event.relatedTarget)) pointer.releaseAll()
    }
    const pointerEvents = ["mousedown", "mouseup", "mousemove", "wheel"] as const
    for (const name of pointerEvents) el.addEventListener(name, onPointer, true)
    el.addEventListener("focusout", onScreenBlur)
    pointerInput.current = pointer
    const router = new GuestKeyboardRouter({
      send: (keysym, code, down) => conn?.sendKey(keysym, code, down),
      translate: (event) => {
        const keyboardEvent = event as KeyboardEvent
        const keysym = KeyboardUtil.getKeysym(keyboardEvent)
        return keysym === null ? null : { keysym, code: KeyboardUtil.getKeycode(keyboardEvent) }
      },
      releaseNoVnc: () => conn?._keyboard._allKeysUp(),
      onCaptured: (next) => captureChanged.current(next),
    })
    router.setCaptured(captured.current)
    router.setEnabled(keys.current.forward)
    const onKeyDown = (event: KeyboardEvent): void => router.keyDown(event)
    const onKeyUp = (event: KeyboardEvent): void => router.keyUp(event)
    const onBlur = (event: FocusEvent): void => {
      // This capture listener also sees a canvas blur to an app control; that
      // releases its drag via focusout, but the host window is still active.
      if (event.target === window) pointer.setFocused(false)
      router.lostFocus()
    }
    const onVisibility = (): void => {
      pointer.setFocused(document.visibilityState !== "hidden" && document.hasFocus())
      if (document.visibilityState === "hidden") router.lostFocus()
    }
    el.addEventListener("keydown", onKeyDown, true)
    el.addEventListener("keyup", onKeyUp, true)
    window.addEventListener("blur", onBlur, true)
    document.addEventListener("visibilitychange", onVisibility)
    keyboard.current = router

    conn = new RFB(el, `ws://127.0.0.1:${String(websocketPort)}`, {
      credentials: { password: password ?? "" },
      wsProtocols: ["binary"],
    })
    rfb.current = conn
    conn.background = "transparent"
    conn.scaleViewport = true
    // We send SetDesktopSize ourselves: noVNC asks in CSS pixels, and treats
    // QEMU's immediate "forwarded" reply as done, dropping later sizes.
    conn.resizeSession = false
    // New QEMU processes forbid JPEG (vnc.ts). For one already running with
    // lossy=on, request its best quality until the next restart. Still lossy:
    // quality 9 cannot replace the server's lossless policy.
    conn.qualityLevel = 9
    conn.focusOnClick = keys.current.forward || keys.current.asleep
    conn.viewOnly = !keys.current.forward

    const measure = (): Size => {
      const r = outer.getBoundingClientRect()
      return { width: r.width, height: r.height }
    }

    // The picture as it is, held over the screen while the guest changes size.
    const hold = (): void => {
      const from = el.querySelector("canvas")
      const to = still.current
      if (from === null || to === null || from.width === 0 || from.height === 0) return
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
            // Held, or Windows not ready: kept, and asked for once it can take it.
            if (sizes === null || !sizes.offer(size)) return
            RFB.messages.setDesktopSize(conn._sock, size.width, size.height, conn._screenID ?? 0, conn._screenFlags ?? 0)
            try {
              await guestSize.current?.(size, scaleFor(dpr()))
              sizes.took()
            } catch (error) {
              // Not taken (its display driver or agent not up yet, a restart begun):
              // kept, and asked for again, both steps, never dropped.
              console.warn("resizing the guest failed; asking again", error)
              sizes.missed(size)
            }
          },
          onPhase: (next, settled) => {
            if (next === "resizing") hold()
            else {
              setBox(measure())
              setRatio(dpr())
              if (settled !== null && settled.ms !== null && settled.size !== null) {
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

    // Asleep: the first key in the screen wakes the machine and goes no further
    // (capture, so it is caught before noVNC's own handler takes it).
    const onKey = (e: KeyboardEvent): void => {
      const k = keys.current
      const verdict = keyVerdict(k, e)
      if (verdict === "pass") return
      e.preventDefault()
      e.stopPropagation()
      if (verdict === "wake") k.onWake?.()
    }
    outer.addEventListener("keydown", onKey, true)

    // Each update ends in a flip. After a new size, the first is the old
    // picture redrawn at it; the second is the guest's own.
    const display = conn._display
    const flip = display.flip.bind(display)
    let flipped: Size | null = null
    let flips = 0
    let frameWait: ReturnType<typeof setTimeout> | undefined
    const drawnAt = (size: Size): void => {
      clearTimeout(frameWait)
      setFb((cur) => (sameSize(cur, size) ? cur : size))
      if (resize === null) return
      // Mid-drag, the held picture becomes the newest one the guest has drawn.
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
        frameWait = setTimeout(() => drawnAt(size), FRAME_WAIT_MS)
      } else if (++flips === 2) drawnAt(size)
    }

    const onArea = (): void => {
      if (resize === null) {
        setBox(measure())
        setRatio(dpr())
        return
      }
      resize.want(guestSizeFor(measure(), dpr()))
      // Still settled: the guest keeps its size (a change under a device pixel); follow the view.
      if (!resize.resizing) {
        setBox(measure())
        setRatio(dpr())
      }
    }
    const observer = new ResizeObserver(onArea)
    observer.observe(outer)
    const unlisten = onLiveResize((live) => {
      // AppKit owns this drag, even if its edge passes across the guest view.
      // Do not wait for the guest's framebuffer/resize-settle phase to finish.
      pointer.setResizing(live)
      if (live) resize?.liveStart()
      else resize?.liveEnd()
    })

    // Moving the window to a display with another pixel ratio.
    const stopRatio = watchPixelRatio(onArea)

    const clipboard = new ClipboardSync({
      readMac: readText,
      writeMac: copyText,
      toGuest: (text) => conn.clipboardPasteFrom(text),
      focused: () => document.hasFocus(),
      canSend: () => keys.current.forward,
    })
    clipboardSync.current = clipboard
    let clipboardReady = false
    let clipboardWait: ReturnType<typeof setTimeout> | undefined
    conn.addEventListener("clipboard", (e) => {
      const text: unknown = (e as CustomEvent<{ text?: unknown } | null>).detail?.text
      if (typeof text === "string") clipboard.fromGuest(text)
    })
    const onFocus = (): void => {
      pointer.setFocused(document.visibilityState !== "hidden")
      if (clipboardReady && connected && !closing) void clipboard.fromMac()
    }
    window.addEventListener("focus", onFocus)
    // The server says what its clipboard takes just after the connection is up;
    // the first paste waits for that, so it goes as UTF-8.
    const startClipboard = (since: number): void => {
      if (closing || !connected) return
      if (conn._clipboardServerCapabilitiesFormats?.[CLIPBOARD_TEXT] !== true && performance.now() - since < CLIPBOARD_CAPS_MS) {
        clipboardWait = setTimeout(() => startClipboard(since), 100)
        return
      }
      clipboardReady = true
      void clipboard.start()
    }

    conn.addEventListener("connect", () => {
      connected = true
      setView("connected")
      // Keep QEMU checking for changes every 30 ms, not backing off (wake.ts).
      stopWake ??= keepRefreshing(conn._sock as WakeSock, () => connected && !closing && document.visibilityState === "visible")
      startClipboard(performance.now())
      // A new connection may be a different guest state (a save loaded, a restart): ask again.
      if (resize !== null) {
        resize.reset()
        resize.want(guestSizeFor(measure(), dpr()))
        resize.flush()
      }
    })
    conn.addEventListener("credentialsrequired", () => conn.sendCredentials({ password: password ?? "" }))
    conn.addEventListener("securityfailure", () => setView("refused"))
    conn.addEventListener("disconnect", () => {
      pointer.releaseAll()
      connected = false
      stopWake?.()
      stopWake = null
      if (closing) return
      setView((v) => (v === "refused" ? v : "lost"))
      retry = setTimeout(() => setAttempt((a) => a + 1), 2000)
    })
    return () => {
      closing = true
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
      for (const name of pointerEvents) el.removeEventListener(name, onPointer, true)
      el.removeEventListener("focusout", onScreenBlur)
      conn.disconnect()
      pointerInput.current = null
      keyboard.current = null
      rfb.current = null
      setHeld(false)
      setPhase("settled")
    }
  }, [websocketPort, password, attempt, resizable])

  // No input to the guest (input.ts): what is held is let go of first, while
  // noVNC can still send (a key-up queued in QEMU lands harmlessly on resume; a
  // key left down would not), then noVNC goes view-only. The Mac's clipboard,
  // kept back meanwhile, goes once the guest takes input again. Capture does not
  // come back by itself: it was released, and is asked for again.
  useEffect(() => {
    keyboard.current?.setEnabled(forwardInput)
    // Buttons too, while noVNC can still send: viewOnly would swallow the up.
    pointerInput.current?.setEnabled(forwardInput)
    const conn = rfb.current
    if (conn === null) return
    conn.viewOnly = !forwardInput
    conn.focusOnClick = forwardInput || asleep
    if (forwardInput) void clipboardSync.current?.fromMac()
  }, [forwardInput, asleep])
  // Held or not ready: sizes wait. Able to take one again: ask for the size the
  // window wants now, both steps, if one was kept.
  useEffect(() => {
    const kept = heldSizes.current?.setFrozen(frozen || !ready) ?? null
    if (kept !== null) askAgainRef.current()
  }, [frozen, ready])

  // One guest pixel per device pixel once the guest is the size this view
  // wants: the box noVNC scales into is the framebuffer's size in CSS pixels,
  // so its scale comes out at exactly 1/devicePixelRatio. Past the limits the
  // box is the view, up to 5K, and noVNC scales the capped guest up to fill it.
  // Any other size (the guest not there yet, or refusing) is scaled to fit,
  // never pinned to a corner.
  const fits = resizable && fb !== null && box !== null && sameSize(fb, guestSizeFor(box, ratio))
  const drawn = fits ? drawSize(fb, box, ratio) : null
  const exact = drawn === null ? undefined : { width: `${String(drawn.width)}px`, height: `${String(drawn.height)}px` }
  const scaled = drawn !== null && fb !== null && drawn.width > fb.width / ratio + 0.5
  const holding = resizable && phase === "resizing" && held

  // noVNC rescales into a new box by itself a frame later; do it before this
  // paint, so the held picture gives way to one already in place.
  useLayoutEffect(() => {
    const conn = rfb.current
    if (conn !== null && exact !== undefined) conn.scaleViewport = true
  }, [exact?.width, exact?.height])

  const message = view === "connected" ? null : t(`screen.${view}`)
  const inert = !forwardInput || view !== "connected"
  // Asleep, a click on the frame focuses it, so a key can wake the machine (the
  // canvas takes no clicks while the guest takes no input).
  return (
    <div
      ref={area}
      className={cx("screen", inert && "screen--inert")}
      tabIndex={asleep ? -1 : undefined}
      onPointerDown={asleep ? (e) => e.currentTarget.focus({ preventScroll: true }) : undefined}
    >
      <div
        ref={target}
        className={exact === undefined ? "screen__canvas" : scaled ? "screen__canvas screen__canvas--exact screen__canvas--scaled" : "screen__canvas screen__canvas--exact"}
        style={exact}
      />
      <canvas ref={still} className="screen__still" hidden={!holding} aria-hidden="true" />
      <div className={cx("screen__held", frozen && overlay && "screen__held--on")} aria-hidden="true">
        <div className="screen__held-mark">
          <Icon name={asleep ? "moon" : "pause"} />
        </div>
        {asleep && <p className="screen__held-hint">{t("screen.asleepHint")}</p>}
      </div>
      {message !== null && (
        <div className="screen__message" role="status">
          <p>{message}</p>
        </div>
      )}
    </div>
  )
})
