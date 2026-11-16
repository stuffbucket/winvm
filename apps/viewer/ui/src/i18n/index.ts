import { IntlMessageFormat } from "intl-messageformat"

import { osKind } from "../platform"
import en from "./en.json"

type Catalog = Record<string, string>

const CATALOGS: Record<string, Catalog> = { en }

const LOCALE_OVERRIDE_KEY = "winvm.locale"

const availableLocales = (): string[] => Object.keys(CATALOGS)

function readOverride(): string | null {
  try {
    return globalThis.localStorage.getItem(LOCALE_OVERRIDE_KEY) ?? null
  } catch {
    return null
  }
}

const languageOf = (tag: string): string => tag.split("-", 1)[0] ?? tag

function bestFitFromNavigator(available: string[]): string | null {
  const exact = new Set(available)
  const byLanguage = new Map<string, string>()
  for (const tag of available) if (!byLanguage.has(languageOf(tag))) byLanguage.set(languageOf(tag), tag)
  const preferred = typeof navigator === "undefined" ? [] : ((navigator as { languages?: readonly string[] }).languages ?? [])
  for (const raw of preferred) {
    if (exact.has(raw)) return raw
    const match = byLanguage.get(languageOf(raw))
    if (match !== undefined) return match
  }
  return null
}

function resolveLocale(): string {
  const available = availableLocales()
  const override = readOverride()
  if (override !== null && available.includes(override)) return override
  return bestFitFromNavigator(available) ?? "en"
}

const lookup = (key: string, locale: string): string | undefined =>
  CATALOGS[locale]?.[key] ?? CATALOGS[languageOf(locale)]?.[key] ?? CATALOGS["en"]?.[key]

export function t(key: string, values: Record<string, string | number> = {}): string {
  const locale = resolveLocale()
  const message = lookup(key, locale)
  if (message === undefined) return key
  return String(new IntlMessageFormat(message, locale).format({ os: osKind(), ...values }))
}
