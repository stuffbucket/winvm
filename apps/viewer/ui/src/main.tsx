import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { showWindow } from "./backend"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { t } from "./i18n"
import { osKind } from "./platform"

document.documentElement.dataset["os"] = osKind()

const root = document.getElementById("root")
if (root === null) throw new Error("index.html has no #root")
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary title={t("error.crash")}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
setTimeout(showWindow, 1000)
