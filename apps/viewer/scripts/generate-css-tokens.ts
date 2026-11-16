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

const kebab = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()

const WIDTH = 80

function topLevelItems(value: string): string[] {
  const items: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i)
    if (char === "(") depth += 1
    else if (char === ")") depth -= 1
    else if (char === "," && depth === 0) {
      items.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  items.push(value.slice(start).trim())
  return items
}

function declaration(indent: string, name: string, value: string): string[] {
  const line = `${indent}--${name}: ${value};`
  const items = topLevelItems(value)
  if (line.length <= WIDTH || items.length < 2) return [line]
  const inner = `${indent}  `
  const lines: string[] = []
  let current = inner
  items.forEach((item, index) => {
    const piece = `${item}${index === items.length - 1 ? ";" : ","}`
    const joined =
      current === inner ? `${inner}${piece}` : `${current} ${piece}`
    if (joined.length > WIDTH && current !== inner) {
      lines.push(current)
      current = `${inner}${piece}`
    } else {
      current = joined
    }
  })
  lines.push(current)
  return [`${indent}--${name}:`, ...lines]
}

const group = (prefix: string, values: Record<string, string>): string[] =>
  Object.entries(values).flatMap(([k, v]) =>
    declaration("  ", `${prefix}-${kebab(k)}`, v),
  )

type ThemeColors = Record<string, string>

const declarations = (colors: ThemeColors, indent: string): string[] =>
  Object.entries(colors).flatMap(([k, v]) => declaration(indent, kebab(k), v))

function themeBlocks(dark: ThemeColors, light: ThemeColors): string[] {
  const darkKeys = Object.keys(dark).sort().join(",")
  const lightKeys = Object.keys(light).sort().join(",")
  if (darkKeys !== lightKeys)
    throw new Error(
      `themes.dark and themes.light must declare the same colors.\n  dark:  ${darkKeys}\n  light: ${lightKeys}`,
    )
  return [
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
    ":root {",
    ...group("font", fontStacks),
    "",
    ...group("text", text),
    ...group("weight", weight),
    ...group("leading", leading),
    ...group("tracking", tracking),
    "",
    ...group("space", spacing),
    "",
    ...group("radius", radii),
    "",
    ...group("border-width", borderWidth),
    "",
    ...group("size", size),
    "",
    ...group("elevation", elevation),
    "",
    `  --brand: ${brand.color};`,
    ...group("accent", accentBase),
    `  --accent-destructive: ${destructive};`,
    `  --accent-destructive-foreground: ${destructiveFg};`,
    `  --scrim: ${scrim.color};`,
    `  --scrim-paused: ${scrim.paused};`,
    "",
    `  --focus-ring-width: ${focusRing.width};`,
    `  --focus-ring-offset: ${focusRing.offset};`,
    `  --focus-ring-color: ${focusRing.color};`,
    `  --focus-ring: ${focusRing.expr};`,
    "",
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
      console.error(
        "::error::tokens.css is stale — run `bun scripts/generate-css-tokens.ts`",
      )
      process.exit(1)
    }
  } else {
    writeFileSync(OUT, css)
  }
}
