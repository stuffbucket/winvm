import { useCallback, useEffect, useRef, useState } from "react"

import { homeDir, pickFolder, winvm } from "../../backend"
import { t } from "../../i18n"
import type { Phase, SharedFolderStatus } from "../../model"
import { parseSharedFolder } from "../../model"
import { clearArgs, cliError, installArgs, setArgs, statusArgs } from "./folder"

export type SharedFolderWork = "set" | "clear" | "install"

/** The shared Mac folder of the machine shown, and what the panel can do with it. */
export interface SharedFolderView {
  readonly status: SharedFolderStatus | null
  /** What the last read or change said when it failed. */
  readonly error: string | null
  /** A change running for this machine (the setup takes minutes). */
  readonly working: SharedFolderWork | null
  readonly home: string | null
  choose(): void
  stop(): void
  setReadonly(on: boolean): void
  install(): void
}

/**
 * Reads `winvm share status` while the panel shows (`active`), again when the
 * machine starts, stops or its agent comes up, and after each change. The
 * setup runs for minutes and outlives the panel being closed; while it runs no
 * other read replaces what it will print.
 */
export function useSharedFolder(instance: string | null, phase: Phase | null, guestReady: boolean, active: boolean): SharedFolderView {
  const [status, setStatus] = useState<SharedFolderStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [work, setWork] = useState<{ instance: string; kind: SharedFolderWork } | null>(null)
  const [home, setHome] = useState<string | null>(null)
  const shown = useRef(instance)
  shown.current = instance
  const reads = useRef(0)

  useEffect(() => {
    homeDir()
      .then(setHome)
      .catch(() => setHome(null))
  }, [])

  // Another machine: nothing known about it yet.
  useEffect(() => {
    setStatus(null)
    setError(null)
  }, [instance])

  const read = useCallback(async (name: string): Promise<void> => {
    const n = ++reads.current
    try {
      const out = await winvm(...statusArgs(name))
      if (n !== reads.current || shown.current !== name) return
      const got = out.code === 0 ? parseSharedFolder(out.stdout) : null
      setStatus(got)
      setError(got === null ? `${t("folder.statusError")} ${cliError(out)}`.trim() : null)
    } catch (e: unknown) {
      if (n !== reads.current || shown.current !== name) return
      setError(`${t("folder.statusError")} ${String(e)}`)
    }
  }, [])

  const installing = work?.kind === "install" && work.instance === instance
  useEffect(() => {
    if (!active || instance === null || installing) return
    void read(instance)
  }, [active, instance, phase, guestReady, installing, read])

  const change = useCallback(
    async (name: string, kind: SharedFolderWork, args: string[]): Promise<void> => {
      setWork({ instance: name, kind })
      setError(null)
      // A read already on its way would answer for the state before this change.
      reads.current++
      try {
        const out = await winvm(...args)
        if (shown.current !== name) return
        const got = out.code === 0 ? parseSharedFolder(out.stdout) : null
        if (got !== null) setStatus(got)
        else {
          setError(cliError(out) || t("folder.changeError"))
          await read(name)
        }
      } catch (e: unknown) {
        if (shown.current === name) setError(String(e))
      } finally {
        setWork((w) => (w?.instance === name && w.kind === kind ? null : w))
      }
    },
    [read],
  )

  const busy = work !== null && work.instance === instance
  const choose = (): void => {
    if (instance === null || busy) return
    const s = status
    pickFolder(t("folder.pickTitle"), s?.folder ?? home ?? undefined)
      .then((path) => {
        if (path !== null) void change(instance, "set", setArgs(instance, path, s?.letter ?? "Z", s?.readonly ?? false))
      })
      .catch((e: unknown) => setError(String(e)))
  }
  const stop = (): void => {
    if (instance !== null && !busy) void change(instance, "clear", clearArgs(instance))
  }
  const setReadonly = (on: boolean): void => {
    const s = status
    if (instance !== null && !busy && s !== null && s.folder !== null) void change(instance, "set", setArgs(instance, s.folder, s.letter, on))
  }
  const install = (): void => {
    if (instance !== null && !busy) void change(instance, "install", installArgs(instance))
  }

  return { status, error, working: work !== null && work.instance === instance ? work.kind : null, home, choose, stop, setReadonly, install }
}
