import { keeperJob, plistXml } from "@winvm/core/keeper"

const args = process.argv.slice(2)
const value = (flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at < 0 ? undefined : args[at + 1]
}
const label = value("--label")
const program = value("--program")
const dir = value("--dir")
const exitTimeout = Number(value("--exit-timeout") ?? "60")
if (
  label === undefined ||
  program === undefined ||
  dir === undefined ||
  !Number.isInteger(exitTimeout) ||
  exitTimeout <= 0
) {
  console.error(
    "usage: bun scripts/keeper-plist.ts --label L --program P --dir D [--exit-timeout SECONDS]",
  )
  process.exit(2)
}
process.stdout.write(plistXml(keeperJob({ label, program, dir, exitTimeout })))
