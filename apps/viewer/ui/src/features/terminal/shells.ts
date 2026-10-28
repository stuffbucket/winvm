/**
 * The shells the Terminal window opens, where they start, and the menu that
 * offers them. Everything here is data, so the toolbar's menu and the
 * window's tabs agree on names, and adding a choice (Run as administrator,
 * Run as SYSTEM) is adding rows.
 */
import { z } from "zod"

export type Shell = "pwsh" | "powershell" | "cmd"

export const SHELLS: readonly Shell[] = ["pwsh", "powershell", "cmd"]

/** What a click on >_ or Cmd-T opens: PowerShell 7 in the home folder. */
export const DEFAULT_SHELL: Shell = "pwsh"

/** One new tab: which instance, which shell, and where it starts (null: the user's home folder). */
export interface OpenRequest {
  readonly instance: string
  readonly shell: Shell
  readonly cwd: string | null
}

export type Launch = Omit<OpenRequest, "instance">

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
  | { readonly kind: "item"; readonly label: string; readonly launch: Launch }
  | { readonly kind: "separator" }
  | { readonly kind: "submenu"; readonly label: string; readonly items: readonly MenuNode[] }

type Label = (key: string, values?: Record<string, string>) => string

const shellItems = (label: Label, cwd: string | null): MenuNode[] =>
  SHELLS.map((shell) => ({ kind: "item", label: label(`shell.${shell}`), launch: { shell, cwd } }))

/**
 * The >_ button's menu: each shell in the home folder, then each other place
 * to start, holding the same shells.
 */
export function shellMenu(label: Label): MenuNode[] {
  const [home, ...others] = START_IN
  return [
    ...shellItems(label, home.cwd),
    { kind: "separator" },
    ...others.map(
      (place): MenuNode => ({
        kind: "submenu",
        label: label("terminal.startIn", { place: place.key === "work" ? place.cwd : label(`place.${place.key}`) }),
        items: shellItems(label, place.cwd),
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
