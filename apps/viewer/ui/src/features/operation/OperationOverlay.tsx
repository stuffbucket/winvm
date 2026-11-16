import type { JSX } from "react"
import { t } from "../../i18n"
import type { ActiveOperation } from "../winvm/useWinvm"

export function OperationOverlay({
  operation,
}: {
  readonly operation: ActiveOperation | null
}): JSX.Element | null {
  if (operation === null) return null
  return (
    <div
      className="display__operation"
      role="status"
      aria-live="polite"
      data-source={operation.source}
    >
      <p className="display__operation-text">
        {t(`operation.${operation.operation}`)}
      </p>
    </div>
  )
}
