import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { relative, resolve } from "node:path"

const CONFIG = resolve(import.meta.dir, "..", "..", "..", ".macos-builder", "config")
const MAIN = "Contents/MacOS/winvm-viewer"
const PROFILES: Readonly<Record<string, string>> = {
  "Contents/MacOS/winvm": "bun-runtime",
  "Contents/Resources/runtime/bin/qemu-system-aarch64": "qemu-hvf",
}
const MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca])

function isMachO(path: string): boolean {
  const buf = Buffer.alloc(4)
  const fd = openSync(path, "r")
  try {
    return readSync(fd, buf, 0, 4, 0) === 4 && MAGIC.has(buf.readUInt32BE(0))
  } finally {
    closeSync(fd)
  }
}

function machO(app: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (st.isFile() && isMachO(p)) out.push(relative(app, p))
    }
  }
  walk(resolve(app, "Contents"))
  return out.filter((p) => p !== MAIN).sort()
}

export function signList(app: string): string {
  return machO(app)
    .map((p) => `${p}:${PROFILES[p] ?? "default"}`)
    .join(",")
}

const LINE = /^sign_nested[ \t]*=[ \t]*(.*)$/m
const current = (): string => LINE.exec(readFileSync(CONFIG, "utf8"))?.[1]?.trim() ?? ""

const [mode, app] = process.argv.slice(2)
if ((mode !== "--check" && mode !== "--write") || app === undefined) {
  console.error("usage: bun apps/viewer/scripts/sign-list.ts --check|--write <winvm.app>")
  process.exit(2)
}
const want = signList(resolve(app))
if (mode === "--write") {
  const config = readFileSync(CONFIG, "utf8")
  if (!LINE.test(config)) {
    console.error("::error::.macos-builder/config has no sign_nested line to write")
    process.exit(1)
  }
  writeFileSync(CONFIG, config.replace(LINE, `sign_nested = ${want}`))
  console.log(`${String(want.split(",").length)} nested binaries written to .macos-builder/config`)
} else if (current() !== want) {
  console.error("::error::.macos-builder/config sign_nested does not match the app's Mach-O files.")
  console.error("Run: bun apps/viewer/scripts/sign-list.ts --write <winvm.app>")
  process.exit(1)
} else {
  console.log(`sign_nested matches the app (${String(want.split(",").length)} nested binaries)`)
}
