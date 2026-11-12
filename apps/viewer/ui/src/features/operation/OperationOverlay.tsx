import { t } from "../../i18n"
import type { ActiveOperation } from "../winvm/useWinvm"

/**
 * What covers the display while the machine is busy with a command, whoever runs it: the one
 * polite status, and a blocker for the pointer. App puts it last in `.display`, over whichever of
 * the screen or the Overview is under it, so a transition (a stow, a stop) never uncovers anything
 * to click or type into. Its words are `operation.<name>`, one catalog entry per shared operation.
 */
export function OperationOverlay({ operation }: { readonly operation: ActiveOperation | null }): JSX.Element | null {
  if (operation === null) return null
  return (
    <div className="display__operation" role="status" aria-live="polite" data-source={operation.source}>
      <p className="display__operation-text">{t(`operation.${operation.operation}`)}</p>
    </div>
  )
}
