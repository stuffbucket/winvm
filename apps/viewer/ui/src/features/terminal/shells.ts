import { z } from "zod"

export type Shell = "pwsh" | "powershell" | "cmd"

const SHELLS: readonly Shell[] = ["pwsh", "powershell", "cmd"]

export type Installed = Readonly<Record<Shell, boolean>>

export const defaultShell = (installed: Installed | null): Shell =>
  installed === null || installed.pwsh ? "pwsh" : "powershell"

export interface OpenRequest {
  readonly instance: string
  readonly shell: Shell
  readonly cwd: string | null
}

export type Launch = Omit<OpenRequest, "instance">

export const runnable = (
  launch: Launch,
  installed: Installed | null,
): Launch =>
  installed === null || installed[launch.shell]
    ? launch
    : { ...launch, shell: defaultShell(installed) }

export const shellsArgs = (instance: string): string[] => [
  "terminal",
  "-i",
  instance,
  "--shells",
  "--json",
]

const InstalledSchema = z.object({
  pwsh: z.boolean(),
  powershell: z.boolean(),
  cmd: z.boolean(),
})

export function parseInstalled(stdout: string): Installed | null {
  const line = stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .at(-1)
  if (line === undefined) return null
  try {
    return InstalledSchema.safeParse(JSON.parse(line)).data ?? null
  } catch {
    return null
  }
}

export const installedList = (installed: Installed | null): Shell[] | null =>
  installed === null ? null : SHELLS.filter((s) => installed[s])
export const fromList = (list: readonly string[]): Installed => ({
  pwsh: list.includes("pwsh"),
  powershell: list.includes("powershell"),
  cmd: list.includes("cmd"),
})

export interface ShellCache {
  get(instance: string): Promise<Installed | null>
  seed(instance: string, installed: Installed): void
  forget(instance: string): void
}

export function shellCache(
  ask: (instance: string) => Promise<Installed | null>,
): ShellCache {
  const known = new Map<string, Promise<Installed | null>>()
  return {
    get(instance) {
      const had = known.get(instance)
      if (had !== undefined) return had
      const asking = ask(instance).catch(() => null)
      known.set(instance, asking)
      void asking.then((installed) => {
        if (installed === null && known.get(instance) === asking)
          known.delete(instance)
      })
      return asking
    },
    seed(instance, installed) {
      known.set(instance, Promise.resolve(installed))
    },
    forget(instance) {
      known.delete(instance)
    },
  }
}

export const START_IN = [
  { key: "home", cwd: null },
  { key: "desktop", cwd: "C:\\Users\\Administrator\\Desktop" },
  { key: "work", cwd: "C:\\work" },
] as const satisfies readonly { key: string; cwd: string | null }[]

export type MenuNode =
  | {
      readonly kind: "item"
      readonly label: string
      readonly launch: Launch
      readonly enabled: boolean
    }
  | { readonly kind: "separator" }
  | {
      readonly kind: "submenu"
      readonly label: string
      readonly items: readonly MenuNode[]
    }

type Label = (key: string, values?: Record<string, string>) => string

const shellItems = (
  label: Label,
  installed: Installed | null,
  cwd: string | null,
): MenuNode[] =>
  SHELLS.map((shell) => {
    const has = installed?.[shell] ?? true
    const name = label(`shell.${shell}`)
    return {
      kind: "item",
      label: has ? name : label("shell.notInstalled", { shell: name }),
      launch: { shell, cwd },
      enabled: has,
    }
  })

export function shellMenu(
  label: Label,
  installed: Installed | null,
): MenuNode[] {
  const [home, ...others] = START_IN
  return [
    ...shellItems(label, installed, home.cwd),
    { kind: "separator" },
    ...others.map(
      (place): MenuNode => ({
        kind: "submenu",
        label: label("terminal.startIn", {
          place: place.key === "work" ? place.cwd : label(`place.${place.key}`),
        }),
        items: shellItems(label, installed, place.cwd),
      }),
    ),
  ]
}

export function connectArgs(r: OpenRequest): string[] {
  return [
    "terminal",
    "-i",
    r.instance,
    "--shell",
    r.shell,
    ...(r.cwd === null ? [] : ["--cwd", r.cwd]),
    "--connect",
    "--json",
  ]
}

const Endpoint = z.object({
  url: z.string().regex(/^ws:\/\/127\.0\.0\.1:\d+\//),
  protocols: z.array(z.string()),
})

export type Endpoint = z.infer<typeof Endpoint>

export function parseEndpoint(stdout: string): Endpoint | null {
  for (const line of stdout.split("\n").reverse()) {
    if (line.trim() === "") continue
    try {
      return Endpoint.safeParse(JSON.parse(line)).data ?? null
    } catch {
      return null
    }
  }
  return null
}

export function failureText(stdout: string, stderr: string): string {
  const all = `${stdout}\n${stderr}`
  const errors = [...all.matchAll(/^::error::(.*)$/gm)]
    .map((m) => (m[1] ?? "").trim())
    .filter((s) => s !== "")
  return errors.length > 0 ? errors.join("\n") : all.trim()
}

export function shellTitle(raw: string): string | null {
  const title = raw.replace(/^Administrator:\s*/, "").trim()
  if (title === "" || /^[A-Za-z]:\\[^"]*\.exe$/i.test(title)) return null
  return title
}
