import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, resolve } from "node:path"

import type { Paths } from "./paths"

export const SMB_USER = "winvm-share"
export const SMB_GUEST_PORT = 445

export const SHARES = {
  c: { share: "C", guest: "C:\\" },
  home: { share: "Home", guest: "C:\\Users\\Administrator" },
} as const
export type ShareKey = keyof typeof SHARES
export const SHARE_KEYS: readonly ShareKey[] = ["home", "c"]
export type ShareName = (typeof SHARES)[ShareKey]["share"]

export const isShareKey = (s: string): s is ShareKey =>
  s === "c" || s === "home"

export interface SmbState {
  readonly user: string
  readonly password: string
  readonly hostPort: number | null
  readonly mounted: readonly ShareKey[]
}

export const smbPath = (p: Paths): string => resolve(p.dir, "smb.json")

export const newPassword = (): string =>
  `Wv1-${randomBytes(24).toString("base64url")}`

export function parseSmb(text: string): SmbState | null {
  try {
    const s = JSON.parse(text) as Partial<Record<keyof SmbState, unknown>>
    if (
      typeof s.user !== "string" ||
      s.user === "" ||
      typeof s.password !== "string" ||
      s.password.length < 20
    )
      return null
    const mounted = Array.isArray(s.mounted)
      ? s.mounted.filter(
          (m): m is ShareKey => typeof m === "string" && isShareKey(m),
        )
      : []
    return {
      user: s.user,
      password: s.password,
      hostPort:
        typeof s.hostPort === "number" &&
        Number.isInteger(s.hostPort) &&
        s.hostPort > 0 &&
        s.hostPort < 65536
          ? s.hostPort
          : null,
      mounted: [...new Set(mounted)],
    }
  } catch {
    return null
  }
}

export function readSmb(p: Paths): SmbState | null {
  const f = smbPath(p)
  if (!existsSync(f)) return null
  try {
    return parseSmb(readFileSync(f, "utf8"))
  } catch {
    return null
  }
}

export function writeSmb(p: Paths, s: SmbState): void {
  const f = smbPath(p)
  writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 })
  chmodSync(f, 0o600)
}

export function ensureSmb(p: Paths): {
  readonly state: SmbState
  readonly created: boolean
} {
  const s = readSmb(p)
  if (s !== null) return { state: s, created: false }
  const fresh: SmbState = {
    user: SMB_USER,
    password: newPassword(),
    hostPort: null,
    mounted: [],
  }
  writeSmb(p, fresh)
  return { state: fresh, created: true }
}

export const withMounted = (
  s: SmbState,
  key: ShareKey,
  on: boolean,
): SmbState => ({
  ...s,
  mounted: on
    ? [...new Set([...s.mounted, key])]
    : s.mounted.filter((m) => m !== key),
})

export function mountsRoot(): string {
  const own = process.env.WINVM_MOUNTS
  return own !== undefined && own !== ""
    ? resolve(own)
    : resolve(homedir(), "winvm")
}

export const instanceMountDir = (instance: string): string =>
  resolve(mountsRoot(), instance)
export const mountDir = (instance: string, key: ShareKey): string =>
  resolve(instanceMountDir(instance), SHARES[key].share)

export const instanceOf = (p: Paths): string => basename(p.dir)

export interface MountEntry {
  readonly source: string
  readonly dir: string
  readonly type: string
}

export function parseMountTable(text: string): readonly MountEntry[] {
  const out: MountEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^(.+?) on (.+) \(([^,()]+)(?:,[^()]*)?\)\s*$/.exec(line)
    if (m !== null)
      out.push({
        source: m[1] ?? "",
        dir: m[2] ?? "",
        type: (m[3] ?? "").trim(),
      })
  }
  return out
}

export function isOurMount(
  e: MountEntry,
  want: { readonly dir: string; readonly port: number; readonly share: string },
): boolean {
  if (e.type !== "smbfs" || e.dir !== want.dir) return false
  const m = /^\/\/(?:[^@/]*@)?([^/:]+):(\d+)\/([^/]+)\/?$/.exec(e.source)
  if (m === null) return false
  return (
    m[1] === "127.0.0.1" &&
    Number(m[2]) === want.port &&
    (m[3] ?? "").toLowerCase() === want.share.toLowerCase()
  )
}

export function findOurMount(
  table: readonly MountEntry[],
  want: { readonly dir: string; readonly port: number; readonly share: string },
): MountEntry | null {
  return table.find((e) => isOurMount(e, want)) ?? null
}

export function shareFor(
  guestPath: string,
): { readonly key: ShareKey; readonly rel: readonly string[] } | null {
  const norm = guestPath.replaceAll("/", "\\").replace(/\\+$/, "")
  if (!/^[A-Za-z]:/.test(norm)) return null
  const parts = norm.split("\\").filter((s) => s !== "" && s !== ".")
  if (parts.some((s) => s === "..")) return null
  if ((parts[0] ?? "").toUpperCase() !== "C:") return null
  const home = SHARES.home.guest.split("\\").slice(1)
  const rest = parts.slice(1)
  if (
    rest.length >= home.length &&
    home.every((h, i) => h.toLowerCase() === (rest[i] ?? "").toLowerCase())
  ) {
    return { key: "home", rel: rest.slice(home.length) }
  }
  return { key: "c", rel: rest }
}
