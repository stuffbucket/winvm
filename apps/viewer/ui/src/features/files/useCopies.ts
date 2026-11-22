import { useCallback, useEffect, useRef, useState } from "react"

import {
  downloadsDir,
  onDragOutEnd,
  onPromise,
  outputText,
  pickFolder,
  pickSavePath,
  unusedPath,
  winvm,
} from "../../backend"
import { t } from "../../i18n"
import type { Entry } from "./files"
import { childPath, freeName, hostName, isListing, leafName } from "./files"
import { listFolder } from "./ops"

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
  readonly reveal?: string
}

export interface Copies {
  readonly job: CopyJob | null
  readonly result: CopyResult | null
  readonly landed: number
  copyIn: (paths: readonly string[], folder: string | null) => void
  copyOut(folder: string, entries: readonly Entry[]): void
  expectPromises(count: number): void
  report(result: CopyResult): void
  dismiss: () => void
}

const RESULT_DISMISS_MS = 10_000

const dirOf = (path: string): string =>
  path.slice(0, Math.max(1, path.lastIndexOf("/")))

export function useCopies(instance: string | null): Copies {
  const [job, setJob] = useState<CopyJob | null>(null)
  const [result, setResult] = useState<CopyResult | null>(null)
  const [landed, setLanded] = useState(0)
  const queue = useRef<Promise<void>>(Promise.resolve())

  const enqueue = useCallback(
    (work: () => Promise<CopyResult | null>): void => {
      queue.current = queue.current.then(async () => {
        try {
          const done = await work()
          if (done !== null) setResult(done)
        } catch (error) {
          setResult({
            ok: false,
            title: t("files.copyFailed"),
            detail: String(error),
          })
        } finally {
          setJob(null)
        }
      })
    },
    [],
  )

  const copyIn = useCallback(
    (paths: readonly string[], folder: string | null): void => {
      if (instance === null || paths.length === 0) return
      enqueue(async () => {
        setResult(null)
        setJob({
          way: "in",
          done: 0,
          total: paths.length,
          name: hostName(paths[0] ?? ""),
        })
        const listing = await listFolder(instance, folder, { hidden: true })
        if (!isListing(listing))
          return {
            ok: false,
            title: t("files.copyFailed"),
            detail: listing.detail,
          }
        const taken = new Set(listing.entries.map((e) => e.name))
        const failed: string[] = []
        for (const [i, path] of paths.entries()) {
          const name = hostName(path)
          setJob({ way: "in", done: i, total: paths.length, name })
          const target = freeName(name, taken)
          taken.add(target)
          const put = await winvm(
            "put",
            "-i",
            instance,
            path,
            childPath(listing.path, target),
          )
          if (put.code !== 0) failed.push(`${name}: ${outputText(put)}`)
        }
        setLanded((n) => n + 1)
        const into = leafName(listing.path)
        if (failed.length > 0)
          return {
            ok: false,
            title: t("files.notCopied", { count: failed.length }),
            detail: failed.join("\n"),
          }
        return paths.length === 1
          ? {
              ok: true,
              title: t("files.copiedIn", {
                name: hostName(paths[0] ?? ""),
                folder: into,
              }),
            }
          : {
              ok: true,
              title: t("files.copiedInMany", {
                count: paths.length,
                folder: into,
              }),
            }
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
        let targets: string[]
        if (entries.length === 1 && !first.dir) {
          const to = await pickSavePath(
            t("files.saveTitle"),
            `${downloads}/${first.name}`,
          )
          if (to === null) return null
          targets = [to]
        } else {
          const dir = await pickFolder(
            t("files.folderTitle", { count: entries.length }),
            downloads,
          )
          if (dir === null) return null
          targets = []
          for (const e of entries)
            targets.push(await unusedPath(dir, e.name, e.dir))
        }
        setResult(null)
        const failed: string[] = []
        for (const [i, e] of entries.entries()) {
          setJob({ way: "out", done: i, total: entries.length, name: e.name })
          const got = await winvm(
            "get",
            "-i",
            instance,
            childPath(folder, e.name),
            targets[i] ?? "",
          )
          if (got.code !== 0) failed.push(`${e.name}: ${outputText(got)}`)
        }
        const where = hostName(dirOf(targets[0] ?? ""))
        if (failed.length > 0)
          return {
            ok: false,
            title: t("files.notCopied", { count: failed.length }),
            detail: failed.join("\n"),
          }
        const reveal = targets[0] ?? ""
        return entries.length === 1
          ? {
              ok: true,
              title: t("files.copiedOut", {
                name: hostName(reveal),
                folder: where,
              }),
              reveal,
            }
          : {
              ok: true,
              title: t("files.copiedOutMany", {
                count: entries.length,
                folder: where,
              }),
              reveal,
            }
      })
    },
    [instance, enqueue],
  )

  const dismiss = useCallback(() => {
    setResult(null)
  }, [])
  const report = useCallback((r: CopyResult) => {
    setResult(r)
  }, [])

  const promised = useRef<{
    total: number
    done: number
    failed: string[]
    dest: string | null
    name: string
  } | null>(null)
  const expectPromises = useCallback((count: number): void => {
    promised.current = {
      total: count,
      done: 0,
      failed: [],
      dest: null,
      name: "",
    }
  }, [])
  useEffect(
    () =>
      onPromise((e) => {
        const p = promised.current ?? {
          total: 1,
          done: 0,
          failed: [],
          dest: null,
          name: "",
        }
        promised.current = p
        if (e.state === "start") {
          setResult(null)
          setJob({
            way: "out",
            done: p.done,
            total: Math.max(p.total, p.done + 1),
            name: e.name,
          })
          return
        }
        p.done += 1
        if (e.state === "failed") p.failed.push(`${e.name}: ${e.error ?? ""}`)
        else if (p.dest === null) {
          p.dest = e.dest ?? null
          p.name = e.name
        }
        if (p.done < p.total) return
        promised.current = null
        setJob(null)
        if (p.failed.length > 0) {
          setResult({
            ok: false,
            title: t("files.notCopied", { count: p.failed.length }),
            detail: p.failed.join("\n"),
          })
          return
        }
        const reveal = p.dest ?? undefined
        const where = reveal === undefined ? "" : hostName(dirOf(reveal))
        setResult(
          p.total === 1
            ? {
                ok: true,
                title: t("files.copiedOut", { name: p.name, folder: where }),
                ...(reveal === undefined ? {} : { reveal }),
              }
            : {
                ok: true,
                title: t("files.copiedOutMany", {
                  count: p.total,
                  folder: where,
                }),
                ...(reveal === undefined ? {} : { reveal }),
              },
        )
      }),
    [],
  )
  useEffect(
    () =>
      onDragOutEnd((e) => {
        if (e.operation === "none") promised.current = null
      }),
    [],
  )

  useEffect(() => {
    if (result?.ok !== true) return
    const timer = setTimeout(() => {
      setResult(null)
    }, RESULT_DISMISS_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [result])

  return {
    job,
    result,
    landed,
    copyIn,
    copyOut,
    expectPromises,
    report,
    dismiss,
  }
}
