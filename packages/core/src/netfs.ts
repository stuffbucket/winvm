/**
 * Mount an SMB share with macOS's NetFS framework, through bun:ffi, so the
 * password never appears on a command line (`mount_smbfs //user:pw@…` puts it
 * in every `ps`). macOS only.
 *
 * Every dictionary NetFS takes is built from an XML property list
 * (CFPropertyListCreateWithData), which gives CFType callbacks without having
 * to reach CoreFoundation's data symbols from FFI.
 */
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi"

const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
const NETFS = "/System/Library/Frameworks/NetFS.framework/NetFS"
const UTF8 = 0x08000100
/** MNT_DONTBROWSE: not shown on the desktop or in Finder's sidebar. */
const MNT_DONTBROWSE = 0x00100000

export interface NetfsMount {
  /** smb://127.0.0.1:PORT/SHARE */
  readonly url: string
  /** The folder to mount ON (it must exist and be empty). */
  readonly dir: string
  readonly user: string
  readonly password: string
}

const cstr = (s: string): Buffer => Buffer.from(`${s}\0`, "utf8")
const xmlEscape = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export function plist(entries: Readonly<Record<string, string | number | boolean>>): string {
  const body = Object.entries(entries)
    .map(([k, v]) => {
      const value = typeof v === "boolean" ? (v ? "<true/>" : "<false/>") : typeof v === "number" ? `<integer>${String(v)}</integer>` : `<string>${xmlEscape(v)}</string>`
      return `<key>${xmlEscape(k)}</key>${value}`
    })
    .join("")
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${body}</dict></plist>`
}

/** What NetFS is asked to do: no UI, no keychain or preferences, a soft, unbrowsable mount exactly on `dir`. */
export const OPEN_OPTIONS = { UIOption: "NoUI", NoUserPreferences: true, AllowLoopback: true } as const
export const MOUNT_OPTIONS = { UIOption: "NoUI", MountAtMountDir: true, SoftMount: true, MountFlags: MNT_DONTBROWSE } as const

/** NetFSMountURLSync's result: 0, or an errno (80 EAUTH: wrong user or password). */
export function netfsMount(m: NetfsMount): number {
  const cf = dlopen(CF, {
    CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    CFURLCreateWithString: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    CFURLCreateFromFileSystemRepresentation: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.bool], returns: FFIType.ptr },
    CFDataCreate: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
    CFPropertyListCreateWithData: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
  })
  const netfs = dlopen(NETFS, {
    NetFSMountURLSync: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  })
  const owned: Pointer[] = []
  const keep = (p: Pointer | bigint | null, what: string): Pointer => {
    if (p === null || typeof p === "bigint") throw new Error(`could not create ${what}`)
    owned.push(p)
    return p
  }
  const str = (s: string, what: string): Pointer => {
    const b = cstr(s)
    return keep(cf.symbols.CFStringCreateWithCString(null, ptr(b), UTF8), what)
  }
  const dict = (entries: Readonly<Record<string, string | number | boolean>>): Pointer => {
    const xml = Buffer.from(plist(entries), "utf8")
    const data = keep(cf.symbols.CFDataCreate(null, ptr(xml), xml.length), "options data")
    // 2: kCFPropertyListMutableContainersAndLeaves
    return keep(cf.symbols.CFPropertyListCreateWithData(null, data, 2, null, null), "options")
  }
  try {
    const url = keep(cf.symbols.CFURLCreateWithString(null, str(m.url, "url text"), null), "url")
    const dirBytes = Buffer.from(m.dir, "utf8")
    const dir = keep(cf.symbols.CFURLCreateFromFileSystemRepresentation(null, ptr(dirBytes), dirBytes.length, true), "mount folder")
    const out = new BigUint64Array(1)
    return netfs.symbols.NetFSMountURLSync(url, dir, str(m.user, "user"), str(m.password, "password"), dict(OPEN_OPTIONS), dict(MOUNT_OPTIONS), ptr(out))
  } finally {
    for (const p of owned.reverse()) cf.symbols.CFRelease(p)
    cf.close()
    netfs.close()
  }
}
