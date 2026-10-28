/**
 * The shells the Terminal window opens, where they start, and the menu that
 * offers them. Everything here is data, so the toolbar's menu and the
 * window's tabs agree on names, and adding a choice (Run as administrator,
 * Run as SYSTEM) is adding rows.
 */
import { z } from "zod"

export type Shell = "pwsh" | "powershell" | "cmd"

export const SHELLS: readonly Shell[] = ["pwsh", "powershell", "cmd"]

/** Which shells a guest has. Windows comes with Windows PowerShell and Command Prompt; PowerShell 7 may be missing. */
export type Installed = Readonly<Record<Shell, boolean>>

/**
 * What a click on >_ or Cmd-T opens, in the home folder: PowerShell 7 where
 * the guest has it, else Windows PowerShell. Not knowing yet, PowerShell 7,
 * which the guest falls back from (with a note) if it must.
 */
export const defaultShell = (installed: Installed | null): Shell => (installed === null || installed.pwsh ? "pwsh" : "powershell")

/** One new tab: which instance, which shell, and where it starts (null: the user's home folder). */
export interface OpenRequest {
  readonly instance: string
  readonly shell: Shell
  readonly cwd: string | null
}

export type Launch = Omit<OpenRequest, "instance">

/** A launch the guest can run: a shell it lacks becomes the default one. */
export const runnable = (launch: Launch, installed: Installed | null): Launch =>
  installed === null || installed[launch.shell] ? launch : { ...launch, shell: defaultShell(installed) }

/** The sidecar arguments that ask which shells the guest has. */
export const shellsArgs = (instance: string): string[] => ["terminal", "-i", instance, "--shells", "--json"]

const InstalledSchema = z.object({ pwsh: z.boolean(), powershell: z.boolean(), cmd: z.boolean() })

/** `winvm terminal --shells --json`: one line, `{"pwsh":false,"powershell":true,"cmd":true}`. */
export function parseInstalled(stdout: string): Installed | null {
  const line = stdout.split("\n").filter((l) => l.trim() !== "").at(-1)
  if (line === undefined) return null
  try {
    return InstalledSchema.safeParse(JSON.parse(line)).data ?? null
  } catch {
    return null
  }
}

/** The shells installed, as the app hands them to the Terminal window; and back. */
export const installedList = (installed: Installed | null): Shell[] | null => (installed === null ? null : SHELLS.filter((s) => installed[s]))
export const fromList = (list: readonly string[]): Installed => ({
  pwsh: list.includes("pwsh"),
  powershell: list.includes("powershell"),
  cmd: list.includes("cmd"),
})

/**
 * Which shells each instance has, asked once and kept until `forget` (the
 * instance stopped or restarted). A failed ask is not kept, so the next one
 * tries again; asks at once share one answer.
 */
export interface ShellCache {
  get(instance: string): Promise<Installed | null>
  seed(instance: string, installed: Installed): void
  forget(instance: string): void
}

export function shellCache(ask: (instance: string) => Promise<Installed | null>): ShellCache {
  const known = new Map<string, Promise<Installed | null>>()
  return {
    get(instance) {
      const had = known.get(instance)
      if (had !== undefined) return had
      const asking = ask(instance).catch(() => null)
      known.set(instance, asking)
      void asking.then((installed) => {
        if (installed === null && known.get(instance) === asking) known.delete(instance)
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

/**
 * Where a shell can start. Windows in winvm's images is used as the built-in
 * Administrator, so its desktop has a fixed path.
 */
export const START_IN = [
  { key: "home", cwd: null },
  { key: "desktop", cwd: "C:\\Users\\Administrator\\Desktop" },
  { key: "work", cwd: "C:\\work" },
] as const satisfies readonly { key: string; cwd: string | null }[]

export type MenuNode =
  | { readonly kind: "item"; readonly label: string; readonly launch: Launch; readonly enabled: boolean }
  | { readonly kind: "separator" }
  | { readonly kind: "submenu"; readonly label: string; readonly items: readonly MenuNode[] }

type Label = (key: string, values?: Record<string, string>) => string

const shellItems = (label: Label, installed: Installed | null, cwd: string | null): MenuNode[] =>
  SHELLS.map((shell) => {
    const has = installed?.[shell] ?? true
    const name = label(`shell.${shell}`)
    return { kind: "item", label: has ? name : label("shell.notInstalled", { shell: name }), launch: { shell, cwd }, enabled: has }
  })

/**
 * The >_ button's menu: each shell in the home folder, then each other place
 * to start, holding the same shells. A shell the guest lacks is there,
 * disabled, saying so.
 */
export function shellMenu(label: Label, installed: Installed | null): MenuNode[] {
  const [home, ...others] = START_IN
  return [
    ...shellItems(label, installed, home.cwd),
    { kind: "separator" },
    ...others.map(
      (place): MenuNode => ({
        kind: "submenu",
        label: label("terminal.startIn", { place: place.key === "work" ? place.cwd : label(`place.${place.key}`) }),
        items: shellItems(label, installed, place.cwd),
      }),
    ),
  ]
}

/** The sidecar arguments that ask the guest for a shell and print how to reach it. */
export function connectArgs(r: OpenRequest): string[] {
  return ["terminal", "-i", r.instance, "--shell", r.shell, ...(r.cwd === null ? [] : ["--cwd", r.cwd]), "--connect", "--json"]
}

const Endpoint = z.object({
  url: z.string().regex(/^ws:\/\/127\.0\.0\.1:\d+\//),
  protocols: z.array(z.string()),
})

export type Endpoint = z.infer<typeof Endpoint>

/** `winvm terminal --connect --json`: one line naming the WebSocket and its subprotocols. */
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

/** The `::error::` lines a failed winvm command printed, or everything it printed. */
export function failureText(stdout: string, stderr: string): string {
  const all = `${stdout}\n${stderr}`
  const errors = [...all.matchAll(/^::error::(.*)$/gm)].map((m) => (m[1] ?? "").trim()).filter((s) => s !== "")
  return errors.length > 0 ? errors.join("\n") : all.trim()
}

/**
 * A tab's title from what the shell set (OSC 0 or 2), or null to use the
 * shell's name. A bare program path, which is what pwsh and cmd set, says
 * less than the shell's name; the "Administrator: " prefix cmd adds is shown
 * once, for the whole window.
 */
export function shellTitle(raw: string): string | null {
  const title = raw.replace(/^Administrator:\s*/, "").trim()
  if (title === "" || /^[A-Za-z]:\\[^"]*\.exe$/i.test(title)) return null
  return title
}
