/**
 * `shell: winvm` job steps: lines of winvm commands run ON THE HOST against
 * the job's instance — for what the guest cannot do from inside itself, or
 * does better from outside: drive a WebView2 window over DevTools, read the
 * screen, check toasts, click.
 *
 *   - name: Settings shows the account section
 *     shell: winvm
 *     run: |
 *       webview wait 'a[href="#account"]' --timeout 30
 *       webview click 'a[href="#apps"]'
 *       ocr --find "MCP servers"
 *       ui tray Maximal --menu "Quit Maximal"
 *       toasts --app maximal --find "Sign in" --since 5m --wait 30
 *
 * Each non-empty line not starting with `#` is one command (a leading `winvm`
 * is optional), split like a POSIX shell would split it — whitespace, '…' and
 * "…" quoting, no expansion — and run as `bun winvm.ts <cmd> -i <instance>`
 * with the job's and the step's env. The step stops at the first line that
 * exits non-zero, with that line's code. No `background`.
 */
import { resolve } from "node:path"

/** Shell-like word splitting: whitespace separates; '…' is literal; "…" honours \" and \\. */
export function splitWords(line: string): string[] {
  const words: string[] = []
  let cur = ""
  let inWord = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? ""
    if (ch === "'") {
      const end = line.indexOf("'", i + 1)
      if (end < 0) throw new Error(`unterminated ' in: ${line}`)
      cur += line.slice(i + 1, end)
      i = end
      inWord = true
    } else if (ch === '"') {
      let j = i + 1
      for (; j < line.length && line[j] !== '"'; j += 1) {
        if (line[j] === "\\" && (line[j + 1] === '"' || line[j + 1] === "\\")) j += 1
        cur += line[j] ?? ""
      }
      if (j >= line.length) throw new Error(`unterminated " in: ${line}`)
      i = j
      inWord = true
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(cur)
      cur = ""
      inWord = false
    } else {
      cur += ch
      inWord = true
    }
  }
  if (inWord) words.push(cur)
  return words
}

/** The commands in a step's `run`, each as argv for winvm.ts (instance inserted after the verb). */
export function commands(run: string, instance: string): string[][] {
  const out: string[][] = []
  for (const raw of run.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const words = splitWords(line)
    if (words[0] === "winvm") words.shift()
    const [verb, ...rest] = words
    if (verb === undefined) continue
    out.push([verb, "-i", instance, ...rest])
  }
  return out
}

export interface HostStepResult {
  readonly exitcode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

const WINVM = resolve(import.meta.dir, "winvm.ts")
/** A word as it would be typed: quoted when it needs to be. */
export const quote = (w: string): string => (/^[\w@%+=:,./#-]+$/.test(w) ? w : `'${w.replaceAll("'", `'"'"'`)}'`)

export async function runHostStep(
  run: string,
  instance: string,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<HostStepResult> {
  const deadline = Date.now() + timeoutMs
  let stdout = ""
  let stderr = ""
  for (const argv of commands(run, instance)) {
    stdout += `$ winvm ${argv.filter((_, i) => i !== 1 && i !== 2).map(quote).join(" ")}\n`
    const p = Bun.spawn([process.execPath, WINVM, ...argv], {
      env: { ...process.env, ...env, WINVM_INSTANCE: instance },
      stdout: "pipe",
      stderr: "pipe",
    })
    let timedOut = false
    const killer = setTimeout(() => {
      timedOut = true
      p.kill("SIGKILL")
    }, Math.max(0, deadline - Date.now()))
    const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    clearTimeout(killer)
    stdout += o
    stderr += e
    if (timedOut) return { exitcode: 124, stdout, stderr, timedOut }
    if (code !== 0) return { exitcode: code, stdout, stderr, timedOut: false }
  }
  return { exitcode: 0, stdout, stderr, timedOut: false }
}
