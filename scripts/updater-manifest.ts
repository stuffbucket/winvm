/**
 * The update manifest the winvm app reads (`latest.json`, attached to each
 * release), after checking the update's signature the way the app will.
 *
 * The app's updater (tauri-plugin-updater, `plugins.updater` in
 * apps/viewer/src-tauri/tauri.conf.json) installs a bundle only when its
 * `.sig` was made by `pubkey` and its trusted comment names the release
 * version (`requireSignedVersion`). Checking both here makes a wrongly signed
 * bundle fail the release instead of every user's update.
 *
 * usage: bun scripts/updater-manifest.ts --tag vX.Y.Z --file <.app.tar.gz> --url <download url>
 *          [--sig <path>] [--notes <text>] [--config <tauri.conf.json>] --out <latest.json>
 */
import { createHash, createPublicKey, verify } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const TRUSTED = "trusted comment: "

const unbase64 = (s: string): string => Buffer.from(s.trim(), "base64").toString("utf8")

function line(box: string, i: number): string {
  const l = box.split(/\r?\n/u)[i]
  if (l === undefined) throw new Error(`missing line ${String(i + 1)}`)
  return l
}

function publicKey(pubkey: string): { id: Buffer; key: Buffer } {
  const raw = Buffer.from(line(unbase64(pubkey), 1), "base64")
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("the public key is not a minisign Ed25519 key")
  return { id: raw.subarray(2, 10), key: raw.subarray(10, 42) }
}

/** The key id as minisign prints it. */
const keyId = (id: Buffer): string => Buffer.from(id).reverse().toString("hex").toUpperCase()

const ed25519 = (key: Buffer, message: Buffer, signature: Buffer): boolean =>
  verify(null, message, createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key]), format: "der", type: "spki" }), signature)

/** Throws unless `sigFile` signs `data` with `pubkey` for `version`. Returns the trusted comment. */
export function verifyUpdaterSignature(data: Uint8Array, sigFile: string, pubkey: string, version: string): string {
  const { id, key } = publicKey(pubkey)
  const box = unbase64(sigFile)
  const sig = Buffer.from(line(box, 1), "base64")
  const trustedLine = line(box, 2)
  const global = Buffer.from(line(box, 3), "base64")
  if (sig.length !== 74 || global.length !== 64) throw new Error("the signature is not a minisign signature")
  if (!trustedLine.startsWith(TRUSTED)) throw new Error("the signature has no trusted comment")
  const algorithm = sig.subarray(0, 2).toString("latin1")
  if (algorithm !== "ED" && algorithm !== "Ed") throw new Error(`unsupported signature algorithm ${algorithm}`)
  if (!sig.subarray(2, 10).equals(id)) throw new Error(`signed with key ${keyId(sig.subarray(2, 10))}, expected ${keyId(id)}`)
  // "ED" signs the file's BLAKE2b-512 hash; the older "Ed" signs the file itself.
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : Buffer.from(data)
  if (!ed25519(key, message, sig.subarray(10))) throw new Error("the signature does not match the file")
  const trusted = trustedLine.slice(TRUSTED.length)
  if (!ed25519(key, Buffer.concat([sig.subarray(10), Buffer.from(trusted, "utf8")]), global)) {
    throw new Error("the trusted comment is not covered by the signature")
  }
  const signed = trusted
    .split("\t")
    .find((f) => f.startsWith("version:"))
    ?.slice("version:".length)
  const want = version.replace(/^v/u, "")
  if (signed !== want) throw new Error(`signed for version ${signed ?? "(none)"}, expected ${want}`)
  return trusted
}

export interface ManifestInput {
  readonly tag: string
  readonly signature: string
  readonly url: string
  readonly notes: string
  readonly date: Date
}

/** tauri-plugin-updater's static JSON format, for Apple Silicon Macs only. */
export function updaterManifest(i: ManifestInput) {
  return {
    version: i.tag.replace(/^v/u, ""),
    notes: i.notes,
    pub_date: i.date.toISOString(),
    platforms: { "darwin-aarch64": { signature: i.signature.trim(), url: i.url } },
  }
}

function main(argv: readonly string[]): number {
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const [tag, file, url, out] = [arg("--tag"), arg("--file"), arg("--url"), arg("--out")]
  if (tag === undefined || file === undefined || url === undefined || out === undefined) {
    console.error("usage: updater-manifest.ts --tag vX.Y.Z --file <.app.tar.gz> --url <url> [--sig f] [--notes t] [--config f] --out <latest.json>")
    return 2
  }
  const config = arg("--config") ?? resolve(import.meta.dir, "..", "apps", "viewer", "src-tauri", "tauri.conf.json")
  const pubkey = (JSON.parse(readFileSync(config, "utf8")) as { plugins?: { updater?: { pubkey?: unknown } } }).plugins?.updater?.pubkey
  if (typeof pubkey !== "string" || pubkey === "") {
    console.error(`::error::no plugins.updater.pubkey in ${config}`)
    return 1
  }
  const signature = readFileSync(arg("--sig") ?? `${file}.sig`, "utf8")
  try {
    const trusted = verifyUpdaterSignature(readFileSync(file), signature, pubkey, tag)
    console.log(`${basename(file)}: signed by ${keyId(publicKey(pubkey).id)} for ${tag} (${trusted})`)
  } catch (error) {
    console.error(`::error::${basename(file)}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const manifest = updaterManifest({ tag, signature, url, notes: arg("--notes") ?? "", date: new Date() })
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`wrote ${out} for ${manifest.version}`)
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
