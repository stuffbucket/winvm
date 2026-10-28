/**
 * Writes ui/src/styles/tokens.css from ui/src/styles/theme.ts, the one
 * source of the viewer's design values. Adapted from maximal v0.4.48's
 * scripts/generate-css-tokens.ts, without its dashboard output.
 *
 *   bun scripts/generate-css-tokens.ts          write tokens.css
 *   bun scripts/generate-css-tokens.ts --check  fail if tokens.css is stale
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  accent,
  borderWidth,
  brand,
  elevation,
  focusRing,
  fontStacks,
  layout,
  leading,
  radii,
  scrim,
  size,
  spacing,
  text,
  themes,
  tracking,
  weight,
} from "../ui/src/styles/theme"

const OUT = resolve(import.meta.dir, "..", "ui", "src", "styles", "tokens.css")

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()

const group = (prefix: string, values: Record<string, string>): string[] =>
  Object.entries(values).map(([k, v]) => `  --${prefix}-${kebab(k)}: ${v};`)

type ThemeColors = Record<string, string>

const declarations = (colors: ThemeColors, indent: string): string[] =>
  Object.entries(colors).map(([k, v]) => `${indent}--${kebab(k)}: ${v};`)

function themeBlocks(dark: ThemeColors, light: ThemeColors): string[] {
  const darkKeys = Object.keys(dark).sort().join(",")
  const lightKeys = Object.keys(light).sort().join(",")
  if (darkKeys !== lightKeys) throw new Error(`themes.dark and themes.light must declare the same colors.\n  dark:  ${darkKeys}\n  light: ${lightKeys}`)
  return [
    "/* ---- Theme colors ----",
    "   Dark by default; follows the OS when its appearance is light; a",
    '   data-theme="dark" | "light" attribute on <html> pins either one. */',
    ":root {",
    "  color-scheme: dark;",
    ...declarations(dark, "  "),
    "}",
    "",
    "@media (prefers-color-scheme: light) {",
    '  :root:not([data-theme="dark"]) {',
    "    color-scheme: light;",
    ...declarations(light, "    "),
    "  }",
    "}",
    "",
    '[data-theme="light"] {',
    "  color-scheme: light;",
    ...declarations(light, "  "),
    "}",
  ]
}

export function tokensCss(): string {
  const { destructive, destructiveFg, ...accentBase } = accent
  return [
    "/* AUTO-GENERATED FROM ui/src/styles/theme.ts by scripts/generate-css-tokens.ts */",
    "",
    ":root {",
    "  /* ---- Font stacks ---- */",
    ...group("font", fontStacks),
    "",
    "  /* ---- Type ramp ---- */",
    ...group("text", text),
    ...group("weight", weight),
    ...group("leading", leading),
    ...group("tracking", tracking),
    "",
    "  /* ---- Spacing ---- */",
    ...group("space", spacing),
    "",
    "  /* ---- Radii ---- */",
    ...group("radius", radii),
    "",
    "  /* ---- Border widths ---- */",
    ...group("border-width", borderWidth),
    "",
    "  /* ---- Sizing ---- */",
    ...group("size", size),
    "",
    "  /* ---- Elevation ---- */",
    ...group("elevation", elevation),
    "",
    "  /* ---- Colors ---- */",
    `  --brand: ${brand.color};`,
    ...group("accent", accentBase),
    `  --accent-destructive: ${destructive};`,
    `  --accent-destructive-foreground: ${destructiveFg};`,
    `  --scrim: ${scrim.color};`,
    `  --scrim-paused: ${scrim.paused};`,
    "",
    "  /* ---- Focus ring ---- */",
    `  --focus-ring-width: ${focusRing.width};`,
    `  --focus-ring-offset: ${focusRing.offset};`,
    `  --focus-ring-color: ${focusRing.color};`,
    `  --focus-ring: ${focusRing.expr};`,
    "",
    "  /* ---- Layout constants ---- */",
    ...Object.entries(layout).map(([k, v]) => `  --${kebab(k)}: ${v};`),
    "}",
    "",
    ...themeBlocks(themes.dark, themes.light),
    "",
  ].join("\n")
}

if (import.meta.main) {
  const css = tokensCss()
  if (process.argv.includes("--check")) {
    if (readFileSync(OUT, "utf8") !== css) {
      console.error("::error::tokens.css is stale — run `bun scripts/generate-css-tokens.ts`")
      process.exit(1)
    }
  } else {
    writeFileSync(OUT, css)
  }
}
