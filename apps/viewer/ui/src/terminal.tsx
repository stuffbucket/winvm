import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { showWindow } from "./backend"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { TerminalWindow } from "./features/terminal/TerminalWindow"
import { t } from "./i18n"
import { osKind } from "./platform"

document.documentElement.dataset["os"] = osKind()

const root = document.getElementById("root")
if (root === null) throw new Error("terminal.html has no #root")
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary title={t("error.crash")}>
      <TerminalWindow />
    </ErrorBoundary>
  </StrictMode>,
)
// Shown even if the window never commits, so a failure is visible rather than a missing window.
setTimeout(showWindow, 1000)
