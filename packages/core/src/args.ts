export interface Args {
  readonly flags: ReadonlyMap<string, string>
  readonly positional: readonly string[]
  readonly rest: readonly string[]
}

export function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>()
  const positional: string[] = []
  const rest: string[] = []
  let afterDoubleDash = false

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === undefined) continue
    if (afterDoubleDash) {
      rest.push(a)
      continue
    }
    if (a === "--") {
      afterDoubleDash = true
      continue
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq > 2) {
        flags.set(a.slice(2, eq), a.slice(eq + 1))
        continue
      }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && (next === "-" || !next.startsWith("-"))) {
        flags.set(key, next)
        i += 1
      } else {
        flags.set(key, "true")
      }
      continue
    }
    if (a === "-i") {
      const next = argv[i + 1]
      if (next !== undefined) {
        flags.set("instance", next)
        i += 1
      }
      continue
    }
    positional.push(a)
  }
  return { flags, positional, rest }
}

export function instanceName(args: Args): string {
  return (
    args.flags.get("instance") ?? process.env["WINVM_INSTANCE"] ?? "default"
  )
}

export function commandInstance(afterVerb: string): string | null {
  const words = afterVerb.trim().split(/\s+/)
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? ""
    if (w === "-i" || w === "--instance") return words[i + 1] ?? null
    if (w.startsWith("--instance=")) return w.slice("--instance=".length)
  }
  return null
}

export function winvmCommandAfter(
  command: string,
  verb: string,
): string | null {
  const target =
    "[A-Za-z0-9_]+-[A-Za-z0-9_]+-[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)?"
  const escapedVerb = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(
    `(?:^|[\\s/])winvm(?:\\.ts|-${target})?\\s+${escapedVerb}(\\s.*)?$`,
  ).exec(command.trim())
  return match === null ? null : (match[1] ?? "")
}

export function imageName(args: Args): string {
  return args.flags.get("image") ?? process.env["WINVM_IMAGE"] ?? "win11-arm64"
}

export function isValidImageName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

export function isValidInstanceName(name: string): boolean {
  return isValidImageName(name)
}
