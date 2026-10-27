import RFB from "novnc/core/rfb.js"
import { useEffect, useRef, useState } from "react"

import { t } from "../../i18n"
import type { Connection } from "../../model"

interface ScreenProps {
  readonly connection: Connection
}

type View = "connecting" | "connected" | "lost" | "refused"

/** The guest's screen through QEMU's VNC websocket, interactive, scaled to its frame (which sets the size). */
export function Screen({ connection }: ScreenProps): JSX.Element {
  const target = useRef<HTMLDivElement | null>(null)
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
    conn.scaleViewport = true
    conn.focusOnClick = true
    conn.addEventListener("connect", () => setView("connected"))
    conn.addEventListener("credentialsrequired", () => conn.sendCredentials({ password: password ?? "" }))
    conn.addEventListener("securityfailure", () => setView("refused"))
    conn.addEventListener("disconnect", () => {
      if (closing) return
      setView((v) => (v === "refused" ? v : "lost"))
      retry = setTimeout(() => setAttempt((a) => a + 1), 2000)
    })
    return () => {
      closing = true
      if (retry !== undefined) clearTimeout(retry)
      conn.disconnect()
    }
  }, [websocketPort, password, attempt])

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
