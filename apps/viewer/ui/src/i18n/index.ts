/**
 * The viewer's i18n runtime: ICU MessageFormat rendered by intl-messageformat,
 * from maximal v0.4.48's shell/src/i18n/index.ts.
 *
 * `en` is the base catalog and the source of every key. Other locales, when
 * added, are override catalogs holding only the keys they translate, looked up
 * region → language → en. A key missing everywhere renders as the key itself.
 * Terms are passed as arguments (`{command}`), never concatenated, so word
 * order stays translatable.
 */
import { IntlMessageFormat } from "intl-messageformat"

import { osKind } from "../platform"
import en from "./en.json"

type Catalog = Record<string, string>

const CATALOGS: Record<string, Catalog> = { en }

const LOCALE_OVERRIDE_KEY = "winvm.locale"

export const availableLocales = (): string[] => Object.keys(CATALOGS)

function readOverride(): string | null {
  try {
    return globalThis.localStorage?.getItem(LOCALE_OVERRIDE_KEY) ?? null
  } catch {
    return null
  }
}

const languageOf = (tag: string): string => tag.split("-", 1)[0] ?? tag

function bestFitFromNavigator(available: string[]): string | null {
  const exact = new Set(available)
  const byLanguage = new Map<string, string>()
  for (const tag of available) if (!byLanguage.has(languageOf(tag))) byLanguage.set(languageOf(tag), tag)
  const preferred = typeof navigator === "undefined" ? [] : navigator.languages
  for (const raw of preferred) {
    if (exact.has(raw)) return raw
    const match = byLanguage.get(languageOf(raw))
    if (match !== undefined) return match
  }
  return null
}

/** An explicit override if it is shipped, else the best fit of the browser's languages, else en. */
export function resolveLocale(): string {
  const available = availableLocales()
  const override = readOverride()
  if (override !== null && available.includes(override)) return override
  return bestFitFromNavigator(available) ?? "en"
}

const lookup = (key: string, locale: string): string | undefined =>
  CATALOGS[locale]?.[key] ?? CATALOGS[languageOf(locale)]?.[key] ?? CATALOGS["en"]?.[key]

/** A localized UI string. The current `os` is passed to every message. */
export function t(key: string, values: Record<string, string | number> = {}): string {
  const locale = resolveLocale()
  const message = lookup(key, locale)
  if (message === undefined) return key
  return String(new IntlMessageFormat(message, locale).format({ os: osKind(), ...values }))
}
