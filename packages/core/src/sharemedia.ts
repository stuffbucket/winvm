import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { download } from "./shell"
import { PACKAGE_DIR, mediaDir } from "./paths"

export const VIRTIO_WIN_VERSION = "0.1.302"
export const VIRTIO_WIN_ISO =
  `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-${VIRTIO_WIN_VERSION}-1/virtio-win-${VIRTIO_WIN_VERSION}.iso`
export const VIOFS_ISO_DIR = ["viofs", "w11", "ARM64"] as const
export const VIOFS_FILES: Readonly<Record<string, string>> = {
  "viofs.inf": "9b646634cf37a6b1cd38fc8d8267e9a82a1120878336e3da035440499f1de023",
  "viofs.sys": "41fdaad7f69f2fd62be0fd150ea67d0668a6159c22d13c4878805e486ff01377",
  "viofs.cat": "92be34e83b6316927f6607a8b4b34318182e4d4bc4c4926a537bb17e4e6034ec",
  "virtiofs.exe": "48310721b46bd58a14c91ecb2b4100bebc9ee3ef1cdf4f2b9157a4a37a6443d7",
}

export const WINFSP_VERSION = "2.1.25156"
export const WINFSP_URL = `https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-${WINFSP_VERSION}.msi`
export const WINFSP_SHA256 = "073a70e00f77423e34bed98b86e600def93393ba5822204fac57a29324db9f7a"
export const WINFSP_FILE = "winfsp.msi"

export const INSTALL_SCRIPT = "viofs-install.ps1"
export const installScript = (): string => resolve(PACKAGE_DIR, "assets", INSTALL_SCRIPT)

export const shareMediaDir = (): string => resolve(mediaDir(), `viofs-${VIRTIO_WIN_VERSION}-winfsp-${WINFSP_VERSION}`)

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex")

export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>

const SECTOR = 2048

interface IsoEntry {
  readonly name: string
  readonly lba: number
  readonly size: number
  readonly dir: boolean
}

export function parseDirectory(data: Uint8Array): readonly IsoEntry[] {
  const out: IsoEntry[] = []
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let i = 0
  while (i < data.length) {
    const len = data[i] ?? 0
    if (len === 0) {
      i = (Math.floor(i / SECTOR) + 1) * SECTOR
      continue
    }
    const nameLen = data[i + 32] ?? 0
    const raw = data.subarray(i + 33, i + 33 + nameLen)
    if (!(nameLen === 1 && (raw[0] === 0 || raw[0] === 1))) {
      out.push({
        name: Buffer.from(raw).toString("latin1").replace(/;\d+$/, "").replace(/\.$/, ""),
        lba: view.getUint32(i + 2, true),
        size: view.getUint32(i + 10, true),
        dir: ((data[i + 25] ?? 0) & 2) !== 0,
      })
    }
    i += len
  }
  return out
}

export async function readIsoFiles(read: RangeReader, path: readonly string[], names: readonly string[]): Promise<Map<string, Uint8Array>> {
  const pvd = await read(16 * SECTOR, SECTOR)
  if (pvd[0] !== 1 || new TextDecoder().decode(pvd.subarray(1, 6)) !== "CD001") throw new Error("not an ISO 9660 image")
  const root = new DataView(pvd.buffer, pvd.byteOffset + 156, 34)
  let dir = { lba: root.getUint32(2, true), size: root.getUint32(10, true) }
  const walked: string[] = []
  for (const part of path) {
    const entry = parseDirectory(await read(dir.lba * SECTOR, dir.size)).find((e) => e.dir && e.name.toLowerCase() === part.toLowerCase())
    walked.push(part)
    if (entry === undefined) throw new Error(`the ISO has no ${walked.join("/")}`)
    dir = { lba: entry.lba, size: entry.size }
  }
  const entries = parseDirectory(await read(dir.lba * SECTOR, dir.size))
  const out = new Map<string, Uint8Array>()
  for (const name of names) {
    const e = entries.find((x) => !x.dir && x.name.toLowerCase() === name.toLowerCase())
    if (e === undefined) throw new Error(`the ISO has no ${[...path, name].join("/")}`)
    out.set(name, await read(e.lba * SECTOR, e.size))
  }
  return out
}

export const httpRanges =
  (url: string): RangeReader =>
  async (offset, length) => {
    const r = await fetch(url, { headers: { range: `bytes=${String(offset)}-${String(offset + length - 1)}` } })
    if (r.status !== 206) throw new Error(`${url} answered a range request with ${String(r.status)}, not 206`)
    const b = new Uint8Array(await r.arrayBuffer())
    if (b.length !== length) throw new Error(`${url} sent ${String(b.length)} bytes for a ${String(length)}-byte range`)
    return b
  }

export const shareMediaReady = (dir = shareMediaDir()): boolean =>
  Object.entries(VIOFS_FILES).every(([f, h]) => existsSync(resolve(dir, f)) && sha256(readFileSync(resolve(dir, f))) === h) &&
  existsSync(resolve(dir, WINFSP_FILE)) &&
  sha256(readFileSync(resolve(dir, WINFSP_FILE))) === WINFSP_SHA256

export async function ensureShareMedia(o: { readonly read?: RangeReader; readonly dir?: string } = {}): Promise<string> {
  const dir = o.dir ?? shareMediaDir()
  if (shareMediaReady(dir)) return dir
  mkdirSync(dir, { recursive: true })
  const missing = Object.entries(VIOFS_FILES).filter(([f, h]) => !existsSync(resolve(dir, f)) || sha256(readFileSync(resolve(dir, f))) !== h)
  if (missing.length > 0) {
    console.log(`fetching viofs ${VIRTIO_WIN_VERSION} (ARM64) from virtio-win's ISO`)
    const files = await readIsoFiles(o.read ?? httpRanges(VIRTIO_WIN_ISO), VIOFS_ISO_DIR, Object.keys(VIOFS_FILES))
    for (const [name, data] of files) {
      const want = VIOFS_FILES[name] ?? ""
      const got = sha256(data)
      if (got !== want) {
        throw new Error(
          `${name} from virtio-win ${VIRTIO_WIN_VERSION} does not match its pinned digest.\n  expected ${want}\n  got      ${got}\n` +
            "  Review the new build, then update VIOFS_FILES in sharemedia.ts.",
        )
      }
      writeFileSync(`${resolve(dir, name)}.part`, data)
      renameSync(`${resolve(dir, name)}.part`, resolve(dir, name))
    }
  }
  try {
    download(WINFSP_URL, resolve(dir, WINFSP_FILE), WINFSP_SHA256)
  } catch (error) {
    rmSync(resolve(dir, WINFSP_FILE), { force: true })
    throw error
  }
  return dir
}
