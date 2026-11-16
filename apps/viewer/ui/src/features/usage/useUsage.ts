import { useEffect, useRef, useState } from "react"

import { instanceUsage } from "../../backend"
import {
  fraction,
  parseSample,
  pushHistory,
  type Sample,
  type Usage,
  usageFrom,
} from "./usage"

const USAGE_EVERY_MS = 2500

export interface UsageView {
  readonly now: Usage | null
  readonly cpuHistory: readonly number[]
  readonly memoryHistory: readonly number[]
}

const EMPTY: UsageView = { now: null, cpuHistory: [], memoryHistory: [] }

const visible = (): boolean => document.visibilityState !== "hidden"

export function useUsage(
  pid: number | null,
  instance: string | null,
  cpus: number | null,
  memoryMiB: number | null,
  readUsage: (
    pid: number,
    instance: string | null,
  ) => Promise<unknown> = instanceUsage,
): UsageView {
  const [view, setView] = useState<UsageView>(EMPTY)
  const [shown, setShown] = useState(visible)
  const prev = useRef<Sample | null>(null)

  useEffect(() => {
    const on = (): void => {
      setShown(visible())
    }
    document.addEventListener("visibilitychange", on)
    return () => {
      document.removeEventListener("visibilitychange", on)
    }
  }, [])

  useEffect(() => {
    prev.current = null
    setView(EMPTY)
  }, [pid])

  useEffect(() => {
    if (pid === null || !shown) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async (): Promise<void> => {
      try {
        const sample = parseSample(await readUsage(pid, instance))
        if (sample !== null && !stopped) {
          const now = usageFrom(prev.current, sample, cpus, memoryMiB)
          prev.current = sample
          setView((v) => ({
            now,
            cpuHistory: pushHistory(v.cpuHistory, now.cpu),
            memoryHistory: pushHistory(
              v.memoryHistory,
              now.memory === null ? null : fraction(now.memory),
            ),
          }))
        }
      } catch {}
      if (!stopped) timer = setTimeout(() => void read(), USAGE_EVERY_MS)
    }
    void read()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [pid, instance, shown, cpus, memoryMiB, readUsage])

  return view
}
