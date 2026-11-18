import {
  DEFAULT_TERMINAL_PALETTE_SETTINGS,
  resolveTerminalAppearance,
  type TerminalTheme,
  type TerminalTypography,
} from "@winvm/terminal"
import { useEffect, useState } from "react"

import { fontStacks, rem, text, themes, weight } from "../../styles/theme"

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
  return {
    ...resolveTerminalAppearance(settings, dark, c.surfaceBase).theme,
    cursorAccent: c.surfaceBase,
  }
}

const PT_PER_PX = 72 / 96

export const terminalTypography: TerminalTypography = {
  fontFamily: fontStacks.mono,
  fontSize: rem(text.sm) * PT_PER_PX,
  fontWeight: Number(weight.base),
  fontVariations: {},
  cellHeight: 10,
  tracking: 0,
  baseline: 0,
  thicken: false,
  thickenStrength: 0,
  ligatures: false,
}

const LIGHT = "(prefers-color-scheme: light)"

export function useDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof matchMedia !== "function" || !matchMedia(LIGHT).matches,
  )
  useEffect(() => {
    if (typeof matchMedia !== "function") return
    const query = matchMedia(LIGHT)
    const change = (): void => {
      setDark(!query.matches)
    }
    query.addEventListener("change", change)
    return () => {
      query.removeEventListener("change", change)
    }
  }, [])
  return dark
}
