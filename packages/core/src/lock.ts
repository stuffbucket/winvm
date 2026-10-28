/**
 * Locking Windows: back to its lock screen, from which the user signs in again.
 *
 * HOW. `LockWorkStation`, called in the logged-on user's session — through the
 * agent, which runs there (qemu-ga runs in session 0, where locking does
 * nothing for the desktop the user sees). Sending ctrl-alt-del instead opens
 * the security screen (Lock / Switch user / Sign out / Task Manager), not the
 * lock screen, so it is not used.
 *
 * WHY THE ACCOUNT IS ENABLED FIRST. winvm's images run in audit mode, signed
 * in as the built-in Administrator — an account Windows keeps DISABLED, which
 * audit mode's automatic sign-in ignores. Locked, the sign-in screen refuses it
 * ("Your account has been disabled"), and the only way back is a restart.
 * Measured on win11-arm64: once enabled, its blank password signs straight back
 * in from the lock screen with Enter. So the signed-in account is enabled
 * before locking, when it is not already.
 *
 * The lock is confirmed by LogonUI.exe appearing in the user's session, so a
 * caller that pauses next (sleep) freezes the lock screen, not the desktop.
 */
import type { Proc, PwshResponse } from "./guestagent"

/** What locking needs of the agent (AgentClient has it; tests pass a fake). */
export interface LockAgent {
  pwsh(script: string, o?: { readonly timeoutMs?: number }): Promise<PwshResponse>
  launch(argv: readonly string[]): Promise<{ readonly pid: number }>
  procs(): Promise<readonly Proc[]>
}

/** Enables the signed-in local account if Windows has it disabled; prints its name when it did. */
export const ENABLE_SIGN_IN = [
  "$u = (Get-CimInstance Win32_ComputerSystem).UserName",
  "if ($u) {",
  "  $n = $u.Split('\\')[-1]",
  "  $l = Get-LocalUser -Name $n -ErrorAction SilentlyContinue",
  "  if ($l -and -not $l.Enabled) { Enable-LocalUser -Name $n; \"enabled $n\" }",
  "}",
].join("\n")

export const LOCK_ARGV: readonly string[] = ["C:\\Windows\\System32\\rundll32.exe", "user32.dll,LockWorkStation"]

const isLogonUi = (p: Proc): boolean => p.name.toLowerCase() === "logonui.exe"

export interface Locked {
  /** The account enabled so it can sign back in, if one had to be. */
  readonly enabled: string | null
  /** Whether the lock screen was seen (LogonUI running) before giving up waiting. */
  readonly confirmed: boolean
}

export async function lockWindows(
  c: LockAgent,
  o: { readonly waitMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<Locked> {
  const sleep = o.sleep ?? (async (ms: number): Promise<void> => await new Promise((r) => setTimeout(r, ms)))
  const r = await c.pwsh(ENABLE_SIGN_IN, { timeoutMs: 30_000 })
  if (r.code !== 0) throw new Error(`could not make sure Windows can sign back in: ${r.output.trim()}`)
  const enabled = /^enabled (.+)$/m.exec(r.output)?.[1]?.trim() ?? null
  // A LogonUI already there (a lock screen up already) is not this lock's.
  const before = new Set((await c.procs()).filter(isLogonUi).map((p) => p.pid))
  await c.launch(LOCK_ARGV)
  const deadline = Date.now() + (o.waitMs ?? 5000)
  for (;;) {
    if ((await c.procs()).some((p) => isLogonUi(p) && !before.has(p.pid))) break
    if (before.size > 0 || Date.now() >= deadline) return { enabled, confirmed: before.size > 0 }
    await sleep(150)
  }
  // The lock screen draws a moment after LogonUI starts.
  await sleep(700)
  return { enabled, confirmed: true }
}
