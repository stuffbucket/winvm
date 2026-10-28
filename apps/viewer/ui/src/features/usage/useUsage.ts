import { useEffect, useRef, useState } from "react"

import { instanceUsage } from "../../backend"
import { fraction, parseSample, pushHistory, type Sample, type Usage, usageFrom } from "./usage"

/** How often the meters are read, while the window is showing and the machine runs. */
export const USAGE_EVERY_MS = 2500

export interface UsageView {
  readonly now: Usage | null
  /** Recent CPU percentages and memory fractions, oldest first, for sparklines. */
  readonly cpuHistory: readonly number[]
  readonly memoryHistory: readonly number[]
}

const EMPTY: UsageView = { now: null, cpuHistory: [], memoryHistory: [] }

const visible = (): boolean => document.visibilityState !== "hidden"

/**
 * The running machine's meters: one `ps` and one agent call every 2.5 s (no
 * CLI start), only while `pid` is set (the machine runs) and the window shows.
 */
export function useUsage(pid: number | null, instance: string | null, cpus: number | null, memoryMiB: number | null): UsageView {
  const [view, setView] = useState<UsageView>(EMPTY)
  const [shown, setShown] = useState(visible)
  const prev = useRef<Sample | null>(null)

  useEffect(() => {
    const on = (): void => setShown(visible())
    document.addEventListener("visibilitychange", on)
    return () => document.removeEventListener("visibilitychange", on)
  }, [])

  // Another QEMU process: start again.
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
        const sample = parseSample(await instanceUsage(pid, instance))
        if (sample !== null && !stopped) {
          const now = usageFrom(prev.current, sample, cpus, memoryMiB)
          prev.current = sample
          setView((v) => ({
            now,
            cpuHistory: pushHistory(v.cpuHistory, now.cpu),
            memoryHistory: pushHistory(v.memoryHistory, now.memory === null ? null : fraction(now.memory)),
          }))
        }
      } catch {
        // the next read tries again
      }
      if (!stopped) timer = setTimeout(() => void read(), USAGE_EVERY_MS)
    }
    void read()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [pid, instance, shown, cpus, memoryMiB])

  return view
}
