import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { showWindow } from "./backend"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { FilesWindow } from "./features/files/FilesWindow"
import { t } from "./i18n"
import { osKind } from "./platform"

document.documentElement.dataset["os"] = osKind()

const query = new URLSearchParams(window.location.search)
const instance = query.get("instance") ?? ""
const title = query.get("title")
const root = document.getElementById("root")
if (root === null) throw new Error("files.html has no #root")
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary title={t("error.crash")}>
      <FilesWindow instance={instance} initialTitle={title === "" ? null : title} />
    </ErrorBoundary>
  </StrictMode>,
)
// Shown even if the window never commits, so a failure is visible rather than a missing window.
setTimeout(showWindow, 1000)
