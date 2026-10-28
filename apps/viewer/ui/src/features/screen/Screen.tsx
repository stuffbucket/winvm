import RFB from "novnc/core/rfb.js"
import { useEffect, useRef, useState } from "react"

import { type Size, SizeDebouncer, drawSize, guestSizeFor, sameSize, scaleFor } from "@winvm/displayfit"

import { t } from "../../i18n"
import type { Connection } from "../../model"

interface ScreenProps {
  readonly connection: Connection
  /**
   * The guest's screen can follow the view (virtio-gpu). Then the viewer asks
   * QEMU for the view's size in device pixels and `onGuestSize` has the guest
   * switch to it (`winvm display WxH --no-request`), and the picture is drawn
   * one guest pixel per device pixel.
   */
  readonly resizable: boolean
  readonly onGuestSize?: (size: Size, scale: number) => Promise<void>
}

type View = "connecting" | "connected" | "lost" | "refused"

/** Window drags settle for this long before the guest is resized. */
const RESIZE_DEBOUNCE_MS = 300

const dpr = (): number => window.devicePixelRatio || 1

/** The guest's screen through QEMU's VNC websocket, interactive. */
export function Screen({ connection, resizable, onGuestSize }: ScreenProps): JSX.Element {
  const area = useRef<HTMLDivElement | null>(null)
  const target = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<View>("connecting")
  const [attempt, setAttempt] = useState(0)
  // The framebuffer's size, and the view's in CSS pixels, for the 1:1 box.
  const [fb, setFb] = useState<Size | null>(null)
  const [box, setBox] = useState<Size | null>(null)
  const [ratio, setRatio] = useState(dpr)
  const { websocketPort, password } = connection
  const guestSize = useRef(onGuestSize)
  guestSize.current = onGuestSize

  useEffect(() => {
    const el = target.current
    const outer = area.current
    if (el === null || outer === null) return
    let closing = false
    let connected = false
    let retry: ReturnType<typeof setTimeout> | undefined
    setView("connecting")
    const conn = new RFB(el, `ws://127.0.0.1:${String(websocketPort)}`, {
      credentials: { password: password ?? "" },
      wsProtocols: ["binary"],
    })
    conn.background = "transparent"
    conn.scaleViewport = true
    // We send SetDesktopSize ourselves: noVNC asks in CSS pixels, and treats
    // QEMU's immediate "forwarded" reply as done, dropping later sizes.
    conn.resizeSession = false
    conn.focusOnClick = true

    // One guest resize at a time; the latest size wins.
    let busy = false
    let queued: Size | null = null
    const applyInGuest = async (size: Size): Promise<void> => {
      if (busy) {
        queued = size
        return
      }
      busy = true
      try {
        await guestSize.current?.(size, scaleFor(dpr()))
      } catch (error) {
        console.warn("resizing the guest failed", error)
      } finally {
        busy = false
      }
      const next = queued
      queued = null
      if (next !== null && !sameSize(next, size)) await applyInGuest(next)
    }
    const debouncer = new SizeDebouncer((size) => {
      if (!connected || closing) return
      RFB.messages.setDesktopSize(conn._sock, size.width, size.height, conn._screenID ?? 0, conn._screenFlags ?? 0)
      void applyInGuest(size)
    }, RESIZE_DEBOUNCE_MS)

    const measure = (): Size => {
      const r = outer.getBoundingClientRect()
      return { width: r.width, height: r.height }
    }
    const wanted = (): Size => guestSizeFor(measure(), dpr())
    const onArea = (): void => {
      setBox(measure())
      setRatio(dpr())
      if (resizable) debouncer.push(wanted())
    }
    const observer = new ResizeObserver(onArea)
    observer.observe(outer)

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

    // The canvas' backing store is the framebuffer (scaleViewport, no clipping).
    const canvasSize = new MutationObserver(() => {
      const c = el.querySelector("canvas")
      if (c === null || c.width === 0 || c.height === 0) return
      setFb((cur) => (cur?.width === c.width && cur.height === c.height ? cur : { width: c.width, height: c.height }))
    })
    canvasSize.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["width", "height"] })

    conn.addEventListener("connect", () => {
      connected = true
      setView("connected")
      // A new connection may be a different guest state (a save loaded, a restart): ask again.
      if (resizable) {
        debouncer.reset()
        debouncer.push(wanted())
        debouncer.flush()
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
      debouncer.cancel()
      observer.disconnect()
      canvasSize.disconnect()
      media?.removeEventListener("change", onRatio)
      if (retry !== undefined) clearTimeout(retry)
      conn.disconnect()
    }
  }, [websocketPort, password, attempt, resizable])

  // One guest pixel per device pixel while the guest can match the view: the
  // box noVNC scales into is the framebuffer's size in CSS pixels, so its
  // scale comes out at exactly 1/devicePixelRatio. Past the limits the box is
  // the view, up to 5K, and noVNC scales the capped guest up to fill it.
  const drawn = resizable && fb !== null && box !== null ? drawSize(fb, box, ratio) : null
  const exact = drawn === null ? undefined : { width: `${String(drawn.width)}px`, height: `${String(drawn.height)}px` }
  const scaled = drawn !== null && fb !== null && drawn.width > fb.width / ratio + 0.5

  const message = view === "connected" ? null : t(`screen.${view}`)
  return (
    <div ref={area} className="screen">
      <div
        ref={target}
        className={exact === undefined ? "screen__canvas" : scaled ? "screen__canvas screen__canvas--exact screen__canvas--scaled" : "screen__canvas screen__canvas--exact"}
        style={exact}
      />
      {message !== null && (
        <div className="screen__message" role="status">
          <p>{message}</p>
        </div>
      )}
    </div>
  )
}
