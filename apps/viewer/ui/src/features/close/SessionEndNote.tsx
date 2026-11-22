import { type JSX, useEffect, useState } from "react"

import type { CloseSession } from "../../backend"
import { t } from "../../i18n"

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [ticking])
  return now
}

export function SessionEndNote({
  session,
}: {
  readonly session: CloseSession | null
}): JSX.Element | null {
  const now = useNow(session?.kind === "waiting")
  if (session === null) return null
  if (session.kind === "missed")
    return (
      <p className="close-dialog__session" role="status">
        {t("close.sessionMissed")}
      </p>
    )
  const seconds = Math.max(0, Math.ceil((session.deadline - now) / 1000))
  return (
    <p className="close-dialog__session" role="timer">
      {t("close.sessionEnd", { seconds })}
    </p>
  )
}
