import { IntlMessageFormat } from "intl-messageformat"

import en from "../ui/src/i18n/en.json"

export function copy(key: string, values: Record<string, string | number> = {}): string {
  const message = (en as Record<string, string>)[key]
  if (message === undefined) return `<${key} missing from the catalog>`
  return String(new IntlMessageFormat(message, "en").format({ os: "macos", ...values }))
}
