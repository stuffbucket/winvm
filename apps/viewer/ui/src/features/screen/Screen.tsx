import RFB from "novnc/core/rfb.js"
import { useEffect, useRef, useState } from "react"

import { t } from "../../i18n"
import type { Connection } from "../../model"

interface ScreenProps {
  readonly connection: Connection
  readonly fit: boolean
}

type View = "connecting" | "connected" | "lost" | "refused"

/** The guest's screen through QEMU's VNC websocket, interactive, scaled to fit or at 1:1. */
export function Screen({ connection, fit }: ScreenProps): JSX.Element {
  const target = useRef<HTMLDivElement | null>(null)
  const rfb = useRef<RFB | null>(null)
  const [view, setView] = useState<View>("connecting")
  const [attempt, setAttempt] = useState(0)
  const { websocketPort, password } = connection

  useEffect(() => {
    const el = target.current
    if (el === null) return
    let closing = false
    let retry: ReturnType<typeof setTimeout> | undefined
    setView("connecting")
    const conn = new RFB(el, `ws://127.0.0.1:${String(websocketPort)}`, {
      credentials: { password: password ?? "" },
      wsProtocols: ["binary"],
    })
    conn.background = "transparent"
    conn.focusOnClick = true
    conn.addEventListener("connect", () => setView("connected"))
    conn.addEventListener("credentialsrequired", () => conn.sendCredentials({ password: password ?? "" }))
    conn.addEventListener("securityfailure", () => setView("refused"))
    conn.addEventListener("disconnect", () => {
      if (closing) return
      setView((v) => (v === "refused" ? v : "lost"))
      retry = setTimeout(() => setAttempt((a) => a + 1), 2000)
    })
    rfb.current = conn
    return () => {
      closing = true
      if (retry !== undefined) clearTimeout(retry)
      rfb.current = null
      conn.disconnect()
    }
  }, [websocketPort, password, attempt])

  useEffect(() => {
    if (rfb.current === null) return
    rfb.current.scaleViewport = fit
    rfb.current.clipViewport = !fit
  }, [fit, attempt, view])

  const message = view === "connected" ? null : t(`screen.${view}`)
  return (
    <div className="screen">
      <div ref={target} className="screen__canvas" />
      {message !== null && (
        <div className="screen__message" role="status">
          <p>{message}</p>
        </div>
      )}
    </div>
  )
}
