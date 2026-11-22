import { type JSX, useEffect, useRef } from "react"
import windowsRs from "../../../../apps/viewer/src-tauri/src/windows.rs?raw"
import tauriConfig from "../../../../apps/viewer/src-tauri/tauri.conf.json"
import { applyTheme } from "../theme"
import { mainSize, type Size, specSize } from "./sizes"

export type Page = "index" | "help" | "files" | "terminal"

const MAIN = mainSize(tauriConfig)

const SIZES: Record<Page, Size> = {
  index: MAIN,
  help: MAIN,
  files: specSize(windowsRs, "FILES"),
  terminal: specSize(windowsRs, "TERMINAL"),
}

export interface WindowFrameProps {
  readonly page: Page
  readonly query?: Readonly<Record<string, string>>
  readonly theme: unknown
  readonly title: string
}

export function WindowFrame({
  page,
  query = {},
  theme,
  title,
}: WindowFrameProps): JSX.Element {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const src = `ui/${page}.html?${new URLSearchParams(query).toString()}`
  const size = SIZES[page]

  useEffect(() => {
    const doc = frame.current?.contentDocument
    if (doc !== null && doc !== undefined) applyTheme(doc, theme)
  }, [theme])

  return (
    <iframe
      key={src}
      ref={frame}
      className="sb-window"
      src={src}
      title={title}
      width={size.width}
      height={size.height}
      onLoad={(e) => {
        const doc = e.currentTarget.contentDocument
        if (doc !== null) applyTheme(doc, theme)
      }}
    />
  )
}
