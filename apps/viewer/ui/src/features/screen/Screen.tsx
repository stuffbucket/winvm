import RFB from "novnc/core/rfb.js"
import * as KeyboardUtil from "novnc/core/input/util.js"
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react"

import { type Size, drawSize, guestSizeFor, sameSize, scaleFor } from "@winvm/displayfit"

import { onLiveResize, trace } from "../../backend"
import { t } from "../../i18n"
import type { Connection } from "../../model"
import { GuestKeyboardRouter, sendCtrlAltDelete, sendWindowsKey } from "./keyboard"
import { LiveResize, type ResizePhase } from "./resize"

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
}

export interface ScreenHandle {
  sendWindowsKey(): void
  sendCtrlAltDelete(): void
}

type View = "connecting" | "connected" | "lost" | "refused"

/** A new size's first frame is the old picture redrawn; the second is the guest's. Without one, this long. */
const FRAME_WAIT_MS = 150

const dpr = (): number => window.devicePixelRatio || 1

/**
 * The guest's screen through QEMU's VNC websocket, interactive.
 *
 * WHILE A RESIZABLE GUEST IS RESIZED (resize.ts decides when): the last
 * picture is copied to a canvas laid over the screen and stretched to fill the
 * view, so the window's edge never shows a blank, a corner or a jump. The live
 * screen underneath carries on (sizes the guest passes through, the redraw of a
 * new size), out of sight, and the copy goes once the guest's picture is drawn
 * in full at the size asked for, one guest pixel per device pixel.
 */
export const Screen = forwardRef<ScreenHandle, ScreenProps>(function Screen(
  { connection, keyboardCaptured, onKeyboardCaptured, resizable, onGuestSize },
  ref,
): JSX.Element {
  const area = useRef<HTMLDivElement | null>(null)
  const target = useRef<HTMLDivElement | null>(null)
  const still = useRef<HTMLCanvasElement | null>(null)
  const rfb = useRef<RFB | null>(null)
  const keyboard = useRef<GuestKeyboardRouter | null>(null)
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
  const captured = useRef(keyboardCaptured)
  captured.current = keyboardCaptured
  const captureChanged = useRef(onKeyboardCaptured)
  captureChanged.current = onKeyboardCaptured

  useImperativeHandle(
    ref,
    () => ({
      sendWindowsKey: () => {
        const conn = rfb.current
        if (conn !== null) sendWindowsKey((keysym, code, down) => conn.sendKey(keysym, code, down))
      },
      sendCtrlAltDelete: () => {
        const conn = rfb.current
        if (conn !== null) sendCtrlAltDelete((keysym, code, down) => conn.sendKey(keysym, code, down))
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
    setView("connecting")
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
    const onKeyDown = (event: KeyboardEvent): void => router.keyDown(event)
    const onKeyUp = (event: KeyboardEvent): void => router.keyUp(event)
    const onBlur = (): void => router.lostFocus()
    const onVisibility = (): void => {
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
    conn.focusOnClick = true

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
            RFB.messages.setDesktopSize(conn._sock, size.width, size.height, conn._screenID ?? 0, conn._screenFlags ?? 0)
            try {
              await guestSize.current?.(size, scaleFor(dpr()))
            } catch (error) {
              console.warn("resizing the guest failed", error)
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
    const unlisten = onLiveResize((live) => (live ? resize?.liveStart() : resize?.liveEnd()))

    // Moving the window to a display with another pixel ratio.
    let media: MediaQueryList | null = null
    const onRatio = (): void => {
      watchRatio()
      onArea()
    }
    const watchRatio = (): void => {
      media?.removeEventListener("change", onRatio)
      media = window.matchMedia(`(resolution: ${String(dpr())}dppx)`)
      media.addEventListener("change", onRatio)
    }
    watchRatio()

    conn.addEventListener("connect", () => {
      connected = true
      setView("connected")
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
      connected = false
      if (closing) return
      setView((v) => (v === "refused" ? v : "lost"))
      retry = setTimeout(() => setAttempt((a) => a + 1), 2000)
    })
    return () => {
      closing = true
      resize?.cancel()
      clearTimeout(frameWait)
      observer.disconnect()
      unlisten()
      media?.removeEventListener("change", onRatio)
      if (retry !== undefined) clearTimeout(retry)
      el.removeEventListener("keydown", onKeyDown, true)
      el.removeEventListener("keyup", onKeyUp, true)
      window.removeEventListener("blur", onBlur, true)
      document.removeEventListener("visibilitychange", onVisibility)
      router.lostFocus()
      conn.disconnect()
      keyboard.current = null
      rfb.current = null
      setHeld(false)
      setPhase("settled")
    }
  }, [websocketPort, password, attempt, resizable])

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
  return (
    <div ref={area} className="screen">
      <div
        ref={target}
        className={exact === undefined ? "screen__canvas" : scaled ? "screen__canvas screen__canvas--exact screen__canvas--scaled" : "screen__canvas screen__canvas--exact"}
        style={exact}
      />
      <canvas ref={still} className="screen__still" hidden={!holding} aria-hidden="true" />
      {message !== null && (
        <div className="screen__message" role="status">
          <p>{message}</p>
        </div>
      )}
    </div>
  )
})
