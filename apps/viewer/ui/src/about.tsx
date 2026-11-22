import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { showWindow } from "./backend"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { SHOW_WINDOW_DELAY_MS } from "./constants"
import { About } from "./features/about/About"
import { t } from "./i18n"
import { osKind } from "./platform"

document.documentElement.dataset.os = osKind()

const root = document.getElementById("root")
if (root === null) throw new Error("about.html has no #root")
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary title={t("error.crash")}>
      <About
        version={new URLSearchParams(location.search).get("version") ?? ""}
      />
    </ErrorBoundary>
  </StrictMode>,
)
setTimeout(showWindow, SHOW_WINDOW_DELAY_MS)
