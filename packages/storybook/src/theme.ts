export const THEMES = ["system", "dark", "light"] as const

const isPinned = (value: unknown): value is "dark" | "light" =>
  value === "dark" || value === "light"

export function applyTheme(document: Document, theme: unknown): void {
  const root = document.documentElement
  if (isPinned(theme)) root.dataset.theme = theme
  else delete root.dataset.theme
}
