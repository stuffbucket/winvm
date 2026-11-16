import type { Proc, PwshResponse } from "./guestagent"

export interface LockAgent {
  pwsh(script: string, o?: { readonly timeoutMs?: number }): Promise<PwshResponse>
  launch(argv: readonly string[]): Promise<{ readonly pid: number }>
  procs(): Promise<readonly Proc[]>
}

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
  readonly enabled: string | null
  readonly confirmed: boolean
}

export async function lockWindows(
  c: LockAgent,
  o: { readonly waitMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<Locked> {
  const sleep = o.sleep ?? (async (ms: number): Promise<void> => { await new Promise((r) => setTimeout(r, ms)) })
  const r = await c.pwsh(ENABLE_SIGN_IN, { timeoutMs: 30_000 })
  if (r.code !== 0) throw new Error(`could not make sure Windows can sign back in: ${r.output.trim()}`)
  const enabled = /^enabled (.+)$/m.exec(r.output)?.[1]?.trim() ?? null
  const before = new Set((await c.procs()).filter(isLogonUi).map((p) => p.pid))
  await c.launch(LOCK_ARGV)
  const deadline = Date.now() + (o.waitMs ?? 5000)
  for (;;) {
    if ((await c.procs()).some((p) => isLogonUi(p) && !before.has(p.pid))) break
    if (before.size > 0 || Date.now() >= deadline) return { enabled, confirmed: before.size > 0 }
    await sleep(150)
  }
  await sleep(700)
  return { enabled, confirmed: true }
}
