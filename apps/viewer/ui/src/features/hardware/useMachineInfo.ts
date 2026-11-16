import { useCallback, useEffect, useRef, useState } from "react"

import { winvm } from "../../backend"
import { t } from "../../i18n"
import type { Phase } from "../../model"
import { cliError } from "../sharedfolder/folder"
import { type MachineInfo, type Size, infoArgs, parseMachineInfo, sizeArgs } from "./info"

export interface MachineInfoView {
  readonly info: MachineInfo | null
  readonly error: string | null
  readonly working: boolean
  setSize(change: Partial<Size>): void
}

export function useMachineInfo(instance: string | null, phase: Phase | null, guestReady: boolean, active: boolean): MachineInfoView {
  const [info, setInfo] = useState<MachineInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const shown = useRef(instance)
  shown.current = instance
  const reads = useRef(0)

  useEffect(() => {
    setInfo(null)
    setError(null)
  }, [instance])

  const read = useCallback(async (name: string): Promise<void> => {
    const n = ++reads.current
    try {
      const out = await winvm(...infoArgs(name))
      if (n !== reads.current || shown.current !== name) return
      const got = out.code === 0 ? parseMachineInfo(out.stdout) : null
      if (got !== null) setInfo(got)
      setError(got === null ? `${t("hardware.readError")} ${cliError(out)}`.trim() : null)
    } catch (e: unknown) {
      if (n !== reads.current || shown.current !== name) return
      setError(`${t("hardware.readError")} ${String(e)}`)
    }
  }, [])

  useEffect(() => {
    if (!active || instance === null) return
    void read(instance)
  }, [active, instance, phase, guestReady, read])

  const setSize = useCallback(
    (change: Partial<Size>): void => {
      const name = shown.current
      if (name === null) return
      setWorking(name)
      setError(null)
      reads.current++
      void (async () => {
        try {
          const out = await winvm(...sizeArgs(name, change))
          if (shown.current !== name) return
          await read(name)
          if (out.code !== 0) setError(cliError(out) || t("hardware.changeError"))
        } catch (e: unknown) {
          if (shown.current === name) setError(String(e))
        } finally {
          setWorking((w) => (w === name ? null : w))
        }
      })()
    },
    [read],
  )

  return { info, error, working: working !== null && working === instance, setSize }
}
