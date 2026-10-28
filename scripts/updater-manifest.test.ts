import { describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { updaterManifest, verifyUpdaterSignature } from "./updater-manifest.ts"

const b64 = (b: Uint8Array | string): string => Buffer.from(b).toString("base64")

/** A minisign key pair in the format `tauri signer generate` writes, and a signer for it. */
function keyPair(id = Buffer.from("0123456789abcdef", "hex")) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32)
  const pubkey = b64(`untrusted comment: minisign public key\n${b64(Buffer.concat([Buffer.from("Ed"), id, raw]))}\n`)
  const signFile = (data: Uint8Array, trusted: string): string => {
    const sig = sign(null, createHash("blake2b512").update(data).digest(), privateKey)
    const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey)
    const box = [
      "untrusted comment: signature from tauri secret key",
      b64(Buffer.concat([Buffer.from("ED"), id, sig])),
      `trusted comment: ${trusted}`,
      b64(global),
      "",
    ].join("\n")
    return b64(box)
  }
  return { pubkey, signFile }
}

const data = Buffer.from("the app bundle")

describe("verifyUpdaterSignature", () => {
  test("accepts a file signed by the key for that version", () => {
    const k = keyPair()
    const sig = k.signFile(data, "timestamp:1\tfile:winvm.app.tar.gz\tversion:0.2.0")
    expect(verifyUpdaterSignature(data, sig, k.pubkey, "v0.2.0")).toContain("version:0.2.0")
  })

  test("rejects a signature for another version", () => {
    const k = keyPair()
    const sig = k.signFile(data, "timestamp:1\tversion:0.1.9")
    expect(() => verifyUpdaterSignature(data, sig, k.pubkey, "0.2.0")).toThrow("signed for version 0.1.9, expected 0.2.0")
  })

  test("rejects a signature with no version", () => {
    const k = keyPair()
    const sig = k.signFile(data, "timestamp:1\tfile:winvm.app.tar.gz")
    expect(() => verifyUpdaterSignature(data, sig, k.pubkey, "0.2.0")).toThrow("signed for version (none)")
  })

  test("rejects a changed file", () => {
    const k = keyPair()
    const sig = k.signFile(data, "version:0.2.0")
    expect(() => verifyUpdaterSignature(Buffer.from("something else"), sig, k.pubkey, "0.2.0")).toThrow(
      "the signature does not match the file",
    )
  })

  test("rejects another key", () => {
    const signer = keyPair(Buffer.from("1111111111111111", "hex"))
    const app = keyPair(Buffer.from("2222222222222222", "hex"))
    const sig = signer.signFile(data, "version:0.2.0")
    expect(() => verifyUpdaterSignature(data, sig, app.pubkey, "0.2.0")).toThrow(
      "signed with key 1111111111111111, expected 2222222222222222",
    )
  })
})

describe("updaterManifest", () => {
  test("lists the bundle for Apple Silicon Macs", () => {
    const m = updaterManifest({
      tag: "v0.2.0",
      signature: "c2ln\n",
      url: "https://github.com/stuffbucket/winvm/releases/download/v0.2.0/winvm-v0.2.0-darwin-arm64.app.tar.gz",
      notes: "Fixes.",
      date: new Date("2026-10-28T08:00:00Z"),
    })
    expect(m).toEqual({
      version: "0.2.0",
      notes: "Fixes.",
      pub_date: "2026-10-28T08:00:00.000Z",
      platforms: {
        "darwin-aarch64": {
          signature: "c2ln",
          url: "https://github.com/stuffbucket/winvm/releases/download/v0.2.0/winvm-v0.2.0-darwin-arm64.app.tar.gz",
        },
      },
    })
  })
})
