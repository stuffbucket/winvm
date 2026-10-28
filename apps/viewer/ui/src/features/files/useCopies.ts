import { useCallback, useEffect, useRef, useState } from "react"

import { downloadsDir, outputText, pickFolder, pickSavePath, unusedPath, winvm } from "../../backend"
import { t } from "../../i18n"
import type { Entry } from "./files"
import { childPath, freeName, hostName, isListing, leafName, parseListing } from "./files"

/** A copy under way: which way, how far, and what it's on. */
export interface CopyJob {
  readonly way: "in" | "out"
  readonly done: number
  readonly total: number
  readonly name: string
}

export interface CopyResult {
  readonly ok: boolean
  readonly title: string
  readonly detail?: string
  /** Out: the Mac file or folder to show in Finder. */
  readonly reveal?: string
}

export interface Copies {
  readonly job: CopyJob | null
  readonly result: CopyResult | null
  /** Bumped each time files land in Windows, so a browser showing that folder reads it again. */
  readonly landed: number
  /** Copy Mac files and folders into a Windows folder; null is the Desktop. */
  copyIn(paths: readonly string[], folder: string | null): void
  /** Copy Windows files and folders to the Mac, asking where with the native panels. */
  copyOut(folder: string, entries: readonly Entry[]): void
  dismiss(): void
}

const dirOf = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf("/")))

/** Copies in and out of one instance, one at a time, in the order asked for. */
export function useCopies(instance: string | null): Copies {
  const [job, setJob] = useState<CopyJob | null>(null)
  const [result, setResult] = useState<CopyResult | null>(null)
  const [landed, setLanded] = useState(0)
  const queue = useRef<Promise<void>>(Promise.resolve())

  const enqueue = useCallback((work: () => Promise<CopyResult | null>): void => {
    queue.current = queue.current.then(async () => {
      try {
        const done = await work()
        if (done !== null) setResult(done)
      } catch (error) {
        setResult({ ok: false, title: t("files.copyFailed"), detail: String(error) })
      } finally {
        setJob(null)
      }
    })
  }, [])

  const copyIn = useCallback(
    (paths: readonly string[], folder: string | null): void => {
      if (instance === null || paths.length === 0) return
      enqueue(async () => {
        setResult(null)
        setJob({ way: "in", done: 0, total: paths.length, name: hostName(paths[0] ?? "") })
        // The folder as it is now: where "Desktop" is, and the names a copy must not replace.
        const args = ["dir", "-i", instance, ...(folder === null ? [] : [folder]), "--all", "--json"]
        const out = await winvm(...args)
        const listing = parseListing(out.stdout, out.stderr)
        if (!isListing(listing)) return { ok: false, title: t("files.copyFailed"), detail: listing.detail }
        const taken = new Set(listing.entries.map((e) => e.name))
        const failed: string[] = []
        for (const [i, path] of paths.entries()) {
          const name = hostName(path)
          setJob({ way: "in", done: i, total: paths.length, name })
          const target = freeName(name, taken)
          taken.add(target)
          const put = await winvm("put", "-i", instance, path, childPath(listing.path, target))
          if (put.code !== 0) failed.push(`${name}: ${outputText(put)}`)
        }
        setLanded((n) => n + 1)
        const into = leafName(listing.path)
        if (failed.length > 0) return { ok: false, title: t("files.notCopied", { count: failed.length }), detail: failed.join("\n") }
        return paths.length === 1
          ? { ok: true, title: t("files.copiedIn", { name: hostName(paths[0] ?? ""), folder: into }) }
          : { ok: true, title: t("files.copiedInMany", { count: paths.length, folder: into }) }
      })
    },
    [instance, enqueue],
  )

  const copyOut = useCallback(
    (folder: string, entries: readonly Entry[]): void => {
      if (instance === null || entries.length === 0) return
      enqueue(async () => {
        const downloads = await downloadsDir()
        const first = entries[0]
        if (first === undefined) return null
        // One file: the save panel, which asks before replacing. Otherwise a folder, and names that replace nothing.
        let targets: string[]
        if (entries.length === 1 && !first.dir) {
          const to = await pickSavePath(t("files.saveTitle"), `${downloads}/${first.name}`)
          if (to === null) return null
          targets = [to]
        } else {
          const dir = await pickFolder(t("files.folderTitle", { count: entries.length }), downloads)
          if (dir === null) return null
          targets = []
          for (const e of entries) targets.push(await unusedPath(dir, e.name, e.dir))
        }
        setResult(null)
        const failed: string[] = []
        for (const [i, e] of entries.entries()) {
          setJob({ way: "out", done: i, total: entries.length, name: e.name })
          const got = await winvm("get", "-i", instance, childPath(folder, e.name), targets[i] ?? "")
          if (got.code !== 0) failed.push(`${e.name}: ${outputText(got)}`)
        }
        const where = hostName(dirOf(targets[0] ?? ""))
        if (failed.length > 0) return { ok: false, title: t("files.notCopied", { count: failed.length }), detail: failed.join("\n") }
        const reveal = targets[0] ?? ""
        return entries.length === 1
          ? { ok: true, title: t("files.copiedOut", { name: hostName(reveal), folder: where }), reveal }
          : { ok: true, title: t("files.copiedOutMany", { count: entries.length, folder: where }), reveal }
      })
    },
    [instance, enqueue],
  )

  const dismiss = useCallback(() => setResult(null), [])

  // A copy that worked is said for a while; one that didn't stays until dismissed.
  useEffect(() => {
    if (result?.ok !== true) return
    const timer = setTimeout(() => setResult(null), 10_000)
    return () => clearTimeout(timer)
  }, [result])

  return { job, result, landed, copyIn, copyOut, dismiss }
}
