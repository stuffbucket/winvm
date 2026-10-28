/**
 * The terminal's colours and type, from the app's design tokens. The ground,
 * text, cursor and selection are the window's own (`theme.ts`); the sixteen
 * ANSI colours are the vendored renderer's light and dark palettes, lifted to
 * 4.5:1 against that ground where they fall short.
 */
import { useEffect, useState } from "react"

import {
  DEFAULT_TERMINAL_PALETTE_SETTINGS,
  resolveTerminalAppearance,
  type TerminalTheme,
  type TerminalTypography,
} from "@winvm/terminal"

import { fontStacks, text, themes } from "../../styles/theme"

export function terminalTheme(dark: boolean): TerminalTheme {
  const c = dark ? themes.dark : themes.light
  const mode = dark ? "dark" : "light"
  const settings = {
    ...DEFAULT_TERMINAL_PALETTE_SETTINGS,
    [mode]: {
      ...DEFAULT_TERMINAL_PALETTE_SETTINGS[mode],
      background: c.surfaceBase,
      foreground: c.textBaseColor,
      cursor: c.link,
      selectionBackground: c.terminalSelection,
    },
  }
  return { ...resolveTerminalAppearance(settings, dark, c.surfaceBase).theme, cursorAccent: c.surfaceBase }
}

const PX_PER_REM = 16
const PT_PER_PX = 72 / 96

/** The mono stack at the small text size (`--text-sm`), which the panel's command output uses too. */
export const terminalTypography: TerminalTypography = {
  fontFamily: fontStacks.mono,
  fontSize: Number.parseFloat(text.sm) * PX_PER_REM * PT_PER_PX,
  fontWeight: 400,
  fontVariations: {},
  cellHeight: 10,
  tracking: 0,
  baseline: 0,
  thicken: false,
  thickenStrength: 0,
  ligatures: false,
}

const LIGHT = "(prefers-color-scheme: light)"

/** Whether the window is dark: tokens.css is dark unless the OS says light. Follows changes. */
export function useDark(): boolean {
  const [dark, setDark] = useState(() => typeof matchMedia !== "function" || !matchMedia(LIGHT).matches)
  useEffect(() => {
    if (typeof matchMedia !== "function") return
    const query = matchMedia(LIGHT)
    const change = (): void => setDark(!query.matches)
    query.addEventListener("change", change)
    return () => query.removeEventListener("change", change)
  }, [])
  return dark
}
