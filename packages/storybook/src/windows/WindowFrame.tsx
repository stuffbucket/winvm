import { type JSX, useEffect, useRef } from "react"

import { applyTheme } from "../theme"

export type Page = "index" | "help" | "files" | "terminal"

const SIZES = {
  index: { width: 1024, height: 816 },
  help: { width: 1024, height: 816 },
  files: { width: 920, height: 560 },
  terminal: { width: 820, height: 520 },
} as const satisfies Record<Page, { width: number; height: number }>

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
