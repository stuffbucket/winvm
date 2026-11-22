import { accent, brand, themes } from "../../../apps/viewer/ui/src/styles/theme"

export type Theme = keyof typeof themes

type Role = "text" | "non-text" | "on-fill"

export interface Check {
  readonly theme: Theme
  readonly fg: string
  readonly bg: string
  readonly role: Role
  readonly why: string
  readonly ratio: number
  readonly min: number
}

export const THEME_NAMES = Object.keys(themes) as Theme[]

const TEXT_MIN = 4.5
const NON_TEXT_MIN = 3
const HEX_DIGITS = 16
const CHANNEL_MAX = 255
const SRGB_KNEE = 0.03928
const SRGB_SLOPE = 12.92
const SRGB_OFFSET = 0.055
const SRGB_SCALE = 1.055
const SRGB_GAMMA = 2.4
const LUMA = [0.2126, 0.7152, 0.0722] as const
const FLARE = 0.05

function channel(hex: string, at: number): number {
  const c = Number.parseInt(hex.slice(at, at + 2), HEX_DIGITS) / CHANNEL_MAX
  return c <= SRGB_KNEE
    ? c / SRGB_SLOPE
    : ((c + SRGB_OFFSET) / SRGB_SCALE) ** SRGB_GAMMA
}

function luminance(color: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(color))
    throw new Error(`not a #rrggbb color: ${color}`)
  const hex = color.slice(1)
  return LUMA.reduce((sum, weight, i) => sum + weight * channel(hex, i * 2), 0)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + FLARE) / ((lo ?? 0) + FLARE)
}

const kebab = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()

export function value(theme: Theme, token: string): string {
  const all: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(themes[theme]).map(([k, v]) => [kebab(k), v]),
    ),
    brand: brand.color,
    "accent-fg": accent.fg,
    "accent-destructive": accent.destructive,
    "accent-destructive-foreground": accent.destructiveFg,
  }
  const found = all[token]
  if (found === undefined) throw new Error(`unknown token --${token}`)
  return found
}

const SURFACES = ["surface-base", "surface-card", "surface-control"]

const ROLES: readonly (readonly [string, "text" | "non-text", string])[] = [
  ["text-strong", "text", "headings, primary text"],
  ["text-base-color", "text", "body text"],
  ["text-muted", "text", "captions, helpers"],
  ["link", "text", "links and all teal text"],
  ["link-hover", "text", "hovered links"],
  ["status-error", "text", "error text"],
  ["status-success", "text", "success text"],
  ["status-warning", "text", "warning text"],
  ["status-info", "text", "info figures"],
  ["accent", "non-text", "switch on, checkbox fill, focus ring, busy bar"],
  ["brand", "non-text", "brand mark, requirement icon"],
  ["border-strong", "non-text", "input and checkbox borders"],
  ["status-error", "non-text", "error stripes and icons"],
  ["status-warning", "non-text", "warning icons"],
]

const ON_FILL: readonly (readonly [string, string, string])[] = [
  ["accent-fg", "accent", "primary button label"],
  [
    "accent-destructive-foreground",
    "accent-destructive",
    "destructive button label",
  ],
  ["text-strong", "terminal-selection", "selected terminal text"],
  ["text-base-color", "terminal-selection", "selected terminal text"],
]

const minimum = (role: Role): number =>
  role === "non-text" ? NON_TEXT_MIN : TEXT_MIN

function check(
  theme: Theme,
  fg: string,
  bg: string,
  role: Role,
  why: string,
): Check {
  const ratio = contrast(value(theme, fg), value(theme, bg))
  return { theme, fg, bg, role, why, ratio, min: minimum(role) }
}

export function matrix(): Check[] {
  return THEME_NAMES.flatMap((theme) => [
    ...ROLES.flatMap(([token, role, why]) =>
      SURFACES.map((surface) => check(theme, token, surface, role, why)),
    ),
    ...ON_FILL.map(([fg, bg, why]) => check(theme, fg, bg, "on-fill", why)),
  ])
}

export const passes = (c: Check): boolean => c.ratio >= c.min
