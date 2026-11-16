import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import * as agent from "./agent"
import { freePort, NETDEV } from "./agentfwd"
import type { Args } from "./args"
import { instanceName } from "./args"
import type { Target } from "./cdp"
import { CdpSession, pickTarget, targets } from "./cdp"
import type { Paths } from "./paths"
import { pathsFor } from "./paths"
import * as qemu from "./qemu"
import * as qmp from "./qmp"

export const DEFAULT_PORT = 9222
export const relayPort = (port: number): number => port + 10_000

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)
const fail = (msg: string): number => {
  console.error(`::error::${msg}`)
  return 1
}

export interface WebviewState {
  readonly port: number
  readonly hostPort: number | null
}

const statePath = (p: Paths): string => resolve(p.dir, "webview.json")

export function readState(p: Paths): WebviewState | null {
  const f = statePath(p)
  if (!existsSync(f)) return null
  try {
    const s = JSON.parse(readFileSync(f, "utf8")) as Partial<WebviewState>
    if (typeof s.port !== "number") return null
    return {
      port: s.port,
      hostPort: typeof s.hostPort === "number" ? s.hostPort : null,
    }
  } catch {
    return null
  }
}

const writeState = (p: Paths, s: WebviewState): void => {
  writeFileSync(statePath(p), `${JSON.stringify(s, null, 2)}\n`)
}

const POLICY =
  "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments"
const psq = (s: string): string => `'${s.replaceAll("'", "''")}'`

export function guestScript(exe: string, port: number, on: boolean): string {
  const relay = relayPort(port)
  const rule = `winvm-cdp-${String(relay)}`
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${String(relay)} 2>&1 | Out-Null`,
    `netsh advfirewall firewall delete rule name=${rule} 2>&1 | Out-Null`,
  ]
  if (on) {
    lines.push(
      `New-Item -Path ${psq(POLICY)} -Force | Out-Null`,
      `New-ItemProperty -Path ${psq(POLICY)} -Name ${psq(exe)} -Value ${psq(`--remote-debugging-port=${String(port)}`)} -PropertyType String -Force | Out-Null`,
      `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${String(relay)} connectaddress=127.0.0.1 connectport=${String(port)} | Out-Null`,
      `if ($LASTEXITCODE -ne 0) { throw 'netsh interface portproxy add failed' }`,
      `netsh advfirewall firewall add rule name=${rule} dir=in action=allow protocol=TCP localport=${String(relay)} remoteip=10.0.2.2 | Out-Null`,
      `if ($LASTEXITCODE -ne 0) { throw 'netsh advfirewall firewall add rule failed' }`,
      "Set-Service iphlpsvc -StartupType Automatic; Start-Service iphlpsvc",
    )
  } else {
    lines.push(
      `Remove-ItemProperty -Path ${psq(POLICY)} -Name ${psq(exe)} -ErrorAction SilentlyContinue`,
    )
  }
  lines.push("$global:LASTEXITCODE = 0")
  return lines.join("\n")
}

export function forwardsTo(
  usernet: string,
  guestPort: number,
): readonly number[] {
  const ports: number[] = []
  for (const line of usernet.split(/\r?\n/)) {
    const m =
      /^\s*TCP\[HOST_FORWARD\]\s+\d+\s+\S+\s+(\d+)\s+\S+\s+(\d+)\s/.exec(line)
    if (m !== null && Number(m[2]) === guestPort) ports.push(Number(m[1]))
  }
  return ports
}

export async function ensureForward(p: Paths, port: number): Promise<number> {
  const relay = relayPort(port)
  const s = readState(p)
  const known = s !== null && s.port === port ? s.hostPort : null
  const present = forwardsTo(await qmp.hmp(p.qmp, "info usernet"), relay)
  if (known !== null && present.includes(known)) return known
  if (present[0] !== undefined) {
    writeState(p, { port, hostPort: present[0] })
    return present[0]
  }
  let lastError = ""
  for (const hostPort of [known ?? (await freePort()), await freePort()]) {
    const said = await qmp
      .hmp(
        p.qmp,
        `hostfwd_add ${NETDEV} tcp:127.0.0.1:${String(hostPort)}-:${String(relay)}`,
      )
      .catch((e: unknown) => String(e))
    if (
      said === "" ||
      forwardsTo(await qmp.hmp(p.qmp, "info usernet"), relay).includes(hostPort)
    ) {
      writeState(p, { port, hostPort })
      return hostPort
    }
    lastError = said
  }
  throw new Error(
    `could not forward a host port to the guest's DevTools relay: ${lastError}`,
  )
}

/** `http://127.0.0.1:<hostPort>` for an instance's WebView2 DevTools port. */
export async function baseUrl(name: string, port?: number): Promise<string> {
  const p = pathsFor(name)
  if (!qemu.isRunning(p)) throw new Error(`instance "${name}" is not running`)
  const want = port ?? readState(p)?.port ?? DEFAULT_PORT
  return `http://127.0.0.1:${String(await ensureForward(p, want))}`
}

export async function enable(
  name: string,
  exe: string,
  port = DEFAULT_PORT,
): Promise<number> {
  const p = pathsFor(name)
  const c = await agent.ensure(name)
  const r = await c.pwsh(guestScript(exe, port, true), { timeoutMs: 60_000 })
  if (r.code !== 0)
    throw new Error(`enabling in the guest failed: ${r.output.trim()}`)
  return await ensureForward(p, port)
}

export async function disable(
  name: string,
  exe: string,
  port = DEFAULT_PORT,
): Promise<void> {
  const c = await agent.ensure(name)
  const r = await c.pwsh(guestScript(exe, port, false), { timeoutMs: 60_000 })
  if (r.code !== 0)
    throw new Error(`disabling in the guest failed: ${r.output.trim()}`)
}

export async function session(
  name: string,
  match: string | null,
  o: { readonly port?: number; readonly timeoutMs?: number } = {},
): Promise<{ s: CdpSession; target: Target }> {
  const base = await baseUrl(name, o.port)
  const deadline = Date.now() + (o.timeoutMs ?? 10_000)
  let last = ""
  for (;;) {
    try {
      const t = pickTarget(await targets(base), match)
      if (t?.webSocketDebuggerUrl !== undefined)
        return { s: await CdpSession.open(t.webSocketDebuggerUrl), target: t }
      last = match === null ? "no page target" : `no page matching "${match}"`
    } catch (error) {
      last = errMsg(error)
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${last} — is the app running, and was it started after \`winvm webview enable\`?`,
      )
    }
    await Bun.sleep(250)
  }
}

export const USAGE =
  "winvm webview [-i name] <command>   drive WebView2 windows over DevTools\n" +
  "  enable  <exe> [--port 9222]     policy + relay in the guest; restart the app after\n" +
  "  disable <exe> [--port 9222]\n" +
  "  targets [--json]                pages (and other targets) behind the port\n" +
  "  eval    <js>                    print the value (JSON; strings raw)\n" +
  "  click   <selector>              a real mouse click at the element's centre\n" +
  "  wait    <selector> [--visible]  until it exists (--visible: has a box)\n" +
  "  text    <selector> [--expect T] its innerText (--expect: fail unless it contains T)\n" +
  "  common: [--target T] page whose URL/title contains T; [--timeout S] (default 10)\n" +
  "          [--port N] the guest DevTools port (default: the last enabled, else 9222)\n"

export async function webview(args: Args): Promise<number> {
  const name = instanceName(args)
  const eaten = ["visible", "json"]
    .map((f) => args.flags.get(f))
    .filter((v): v is string => v !== undefined && v !== "true")
  const [first, ...pos] = [...args.positional, ...eaten, ...args.rest]
  const verb = first ?? ""
  const portFlag = args.flags.get("port")
  const port = portFlag === undefined ? undefined : Number(portFlag)
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port <= 0 || relayPort(port) > 65_535)
  )
    return fail(`--port must be 1-${String(65_535 - 10_000)}`)
  const timeoutMs = Number(args.flags.get("timeout") ?? 10) * 1000
  const match = args.flags.get("target") ?? null
  const arg = pos.join(" ")
  if (!qemu.isRunning(pathsFor(name)))
    return fail(`instance "${name}" is not running`)
  try {
    switch (verb) {
      case "enable":
      case "disable": {
        if (arg === "" || /[\\/]/.test(arg))
          return fail(
            `usage: winvm webview ${verb} <exe file name, e.g. maximal-shell.exe> [--port N]`,
          )
        if (verb === "disable") {
          await disable(name, arg, port)
          console.log(`DevTools off for ${arg} (restart it to apply)`)
          return 0
        }
        const hostPort = await enable(name, arg, port)
        console.log(
          `DevTools on for ${arg}: guest 127.0.0.1:${String(port ?? DEFAULT_PORT)} -> host 127.0.0.1:${String(hostPort)} (start or restart the app to apply)`,
        )
        return 0
      }
      case "targets": {
        const list = await targets(await baseUrl(name, port))
        if (args.flags.has("json")) console.log(JSON.stringify(list, null, 2))
        else
          for (const t of list)
            console.log(`${t.type.padEnd(14)} ${t.title}  ${t.url}`)
        return 0
      }
      case "eval":
      case "click":
      case "wait":
      case "text": {
        if (arg === "")
          return fail(
            `usage: winvm webview ${verb} <${verb === "eval" ? "js" : "selector"}>`,
          )
        const { s } = await session(name, match, {
          ...(port === undefined ? {} : { port }),
          timeoutMs,
        })
        try {
          if (verb === "eval") {
            const v = await s.eval(arg, timeoutMs)
            const json: unknown =
              typeof v === "string" ? v : JSON.stringify(v, null, 2)
            console.log(typeof json === "string" ? json : "undefined")
          } else if (verb === "click") {
            await s.waitFor(arg, { timeoutMs, visible: true })
            const at = await s.click(arg)
            console.log(
              `clicked ${arg} at (${at.x.toFixed(0)}, ${at.y.toFixed(0)})`,
            )
          } else if (verb === "wait") {
            const ms = await s.waitFor(arg, {
              timeoutMs,
              visible: args.flags.has("visible"),
            })
            console.log(`${arg} after ${ms.toFixed(0)} ms`)
          } else {
            const text = await s.text(arg)
            console.log(text)
            const want = args.flags.get("expect")
            if (
              want !== undefined &&
              !text.toLowerCase().includes(want.toLowerCase())
            )
              return fail(`${arg} does not contain "${want}"`)
          }
        } finally {
          s.close()
        }
        return 0
      }
      default:
        console.error(USAGE)
        return 2
    }
  } catch (error) {
    return fail(errMsg(error))
  }
}
