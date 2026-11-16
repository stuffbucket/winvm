import { existsSync, realpathSync } from "node:fs"
import { dirname } from "node:path"
import { home, media } from "./paths"
import { capture, quiet } from "./shell"

const EXCLUDE_XATTR = "com.apple.metadata:com_apple_backup_excludeItem"

export function isExcluded(path: string): boolean {
  return quiet("xattr", ["-p", EXCLUDE_XATTR, path]) === 0
}

export function targets(o: { readonly realpath?: (path: string) => string } = {}): readonly string[] {
  const out = [home()]
  const iso = media.iso()
  if (existsSync(iso)) {
    try {
      const isoDir = dirname((o.realpath ?? realpathSync)(iso))
      if (!isoDir.startsWith(`${home()}/`)) out.push(isoDir)
    } catch {
    }
  }
  return out.filter((p) => existsSync(p))
}

function hasDestination(): boolean {
  const out = capture("tmutil", ["destinationinfo"])
  return out !== "" && !/No destinations configured/i.test(out)
}

function mountOf(path: string): string {
  const line = capture("df", ["-P", path]).split("\n").at(-1) ?? ""
  return line.split(/\s+/).slice(5).join(" ") || "/"
}

function localSnapshots(mount: string): readonly string[] {
  return capture("tmutil", ["listlocalsnapshots", mount])
    .split("\n")
    .filter((l) => l.startsWith("com.apple.TimeMachine."))
}

export function summary(): string {
  const missing = targets().filter((p) => !isExcluded(p))
  return missing.length === 0
    ? "ok    Time Machine: VM files excluded from backups"
    : `note  Time Machine: ${missing.join(", ")} not excluded -> winvm timemachine`
}

export function run(yes: boolean): number {
  const backups = hasDestination()
  console.log(
    backups
      ? "Time Machine: backing up to a destination"
      : "Time Machine: no backup destination set up (exclusions still apply if you add one)",
  )

  let failed = 0
  for (const path of targets()) {
    if (isExcluded(path)) {
      console.log(`ok    excluded from backups: ${path}`)
      continue
    }
    console.log(`MISS  not excluded from backups: ${path}`)
    const answer = yes ? "y" : process.stdin.isTTY ? prompt(`      Exclude it? [y/N]`) : null
    if (answer?.trim().toLowerCase() !== "y") {
      console.log(yes || process.stdin.isTTY ? "      left as is" : "      (run with --yes to exclude it)")
      continue
    }
    if (quiet("tmutil", ["addexclusion", path]) === 0 && isExcluded(path)) {
      console.log(`      excluded`)
    } else {
      console.error(`::error::could not exclude ${path} (tmutil addexclusion failed)`)
      failed++
    }
  }

  const mount = mountOf(home())
  const snaps = localSnapshots(mount)
  if (snaps.length === 0) {
    console.log(`ok    no local snapshots on ${mount}`)
  } else {
    console.log(
      `note  ${String(snaps.length)} local snapshot(s) on ${mount}. They cover the whole volume, exclusions\n` +
        "      included, so they hold on to VM disk blocks the guest has since overwritten until\n" +
        "      macOS removes them (usually within 24 hours, sooner when space runs low).\n" +
        `      To remove them now: sudo tmutil deletelocalsnapshots ${mount}`,
    )
  }
  return failed === 0 ? 0 : 1
}
