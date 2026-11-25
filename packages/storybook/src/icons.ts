const UNION = /export type IconName =\s*((?:\|\s*"[A-Za-z]+"\s*)+)/

export function iconNames(source: string): string[] {
  const union = UNION.exec(source)?.[1]
  const names = [...(union ?? "").matchAll(/"([A-Za-z]+)"/g)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined)
  if (names.length === 0) throw new Error("found no IconName union in Icon.tsx")
  return names
}
