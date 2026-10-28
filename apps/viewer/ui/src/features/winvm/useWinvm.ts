import { useCallback, useEffect, useRef, useState } from "react"

import { installCli, outputText, winvm } from "../../backend"
import type { Checks, Connection, Phase, Status } from "../../model"
import { isLivePhase, parseChecks, parseConnection, parseStatus, phase, titleAssignment } from "../../model"
import { phaseAfter, shownPhase, StatusGuard, type Verb } from "./statusGuard"

export type { Verb } from "./statusGuard"

export interface Ran {
  readonly verb: Verb | "open" | "put"
  readonly code: number
  readonly output: string
}

export interface Winvm {
  readonly names: readonly string[]
  readonly name: string | null
  /** Each instance's title (`winvm config title=…`); null or absent: its name. */
  readonly titles: Readonly<Record<string, string | null>>
  /** Each machine's state, as last read (the others' every 40 s or so). */
  readonly phases: Readonly<Record<string, Phase>>
  readonly status: Status | null
  readonly phase: Phase | null
  readonly statusError: string | null
  readonly checks: Checks | null
  readonly checksError: string | null
  readonly connection: Connection | null
  readonly busy: Verb | null
  readonly failure: Ran | null
  readonly last: Ran | null
  readonly cliPath: string | null
  select(name: string): void
  /** Runs a verb on this instance; `arg` names the save for save and load. */
  act(verb: Verb, arg?: string): Promise<void>
  openScreenSharing(): Promise<void>
  installCommand(): Promise<void>
  dismissFailure(): void
  /** Sets this instance's title (empty clears it); resolves with why it couldn't, or null. */
  rename(title: string): Promise<string | null>
  /** Reads the list of machines again (after one is made or deleted). */
  refresh(): Promise<void>
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function useWinvm(): Winvm {
  const [names, setNames] = useState<readonly string[]>([])
  const [name, setName] = useState<string | null>(null)
  const [titles, setTitles] = useState<Readonly<Record<string, string | null>>>({})
  const [phases, setPhases] = useState<Readonly<Record<string, Phase>>>({})
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [checks, setChecks] = useState<Checks | null>(null)
  const [checksError, setChecksError] = useState<string | null>(null)
  const [connection, setConnection] = useState<{ pid: number; conn: Connection } | null>(null)
  const [busy, setBusy] = useState<Verb | null>(null)
  const [failure, setFailure] = useState<Ran | null>(null)
  const [last, setLast] = useState<Ran | null>(null)
  const [cliPath, setCliPath] = useState<string | null>(null)
  const [polls, setPolls] = useState(0)
  // What the last verb left (paused, asleep, running), shown until a read started after it lands.
  const [held, setHeld] = useState<Phase | null>(null)
  const guard = useRef(new StatusGuard())
  const tick = useRef(0)

  const loadNames = useCallback(async (): Promise<string | null> => {
    const out = await winvm("status", "--json")
    const list = parseStatus(out.stdout)
    if (list === null) {
      setStatusError(outputText(out) || `winvm status exited ${String(out.code)}`)
      return null
    }
    const found = list.map((s) => s.name)
    setNames(found)
    setTitles(Object.fromEntries(list.map((s) => [s.name, s.title])))
    setPhases(Object.fromEntries(list.map((s) => [s.name, phase(s)])))
    return found[0] ?? "default"
  }, [])

  const loadStatus = useCallback(async (target: string): Promise<void> => {
    const ticket = guard.current.begin()
    const out = await winvm("status", "--json", "-i", target)
    const s = parseStatus(out.stdout)?.[0]
    if (s === undefined) {
      setStatusError(outputText(out) || `winvm status exited ${String(out.code)}`)
      return
    }
    // Overtaken by a read started later, or started before the last verb ended: stale.
    if (!guard.current.land(ticket)) return
    setHeld(null)
    setStatusError(null)
    setStatus(s)
    setTitles((was) => (was[s.name] === s.title ? was : { ...was, [s.name]: s.title }))
    setPhases((was) => (was[s.name] === phase(s) ? was : { ...was, [s.name]: phase(s) }))
  }, [])

  const loadChecks = useCallback(async (): Promise<void> => {
    try {
      const out = await winvm("doctor", "--json")
      const c = parseChecks(out.stdout)
      setChecks(c)
      setChecksError(c === null ? outputText(out) || `winvm doctor exited ${String(out.code)}` : null)
    } catch (e) {
      setChecksError(errorText(e))
    }
  }, [])

  useEffect(() => {
    void loadChecks()
    loadNames()
      .then((first) => {
        if (first !== null) setName((cur) => cur ?? first)
      })
      .catch((e: unknown) => setStatusError(errorText(e)))
  }, [loadChecks, loadNames])

  const current = status !== null && status.name === name ? status : null
  const p = shownPhase(held, current, phase)
  const fast = busy !== null || p === "starting"

  useEffect(() => {
    if (name === null) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const loop = async (): Promise<void> => {
      tick.current += 1
      try {
        if (tick.current % 10 === 0) await loadNames()
        await loadStatus(name)
      } catch (e) {
        setStatusError(errorText(e))
      }
      setPolls((n) => n + 1)
      if (!stopped) timer = setTimeout(() => void loop(), fast ? 1500 : 4000)
    }
    void loop()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [name, fast, loadNames, loadStatus])

  const live = isLivePhase(p)
  const pid = current?.pid ?? null
  const asking = useRef(false)
  // Asked again on every poll until it answers: the monitor can be busy (a save) the first time.
  useEffect(() => {
    if (!live || pid === null || name === null) {
      setConnection(null)
      return
    }
    if ((connection !== null && connection.pid === pid) || asking.current) return
    asking.current = true
    winvm("open", "--json", "-i", name)
      .then((out) => {
        const conn = parseConnection(out.stdout)
        if (conn !== null) setConnection({ pid, conn })
      })
      .catch(() => undefined)
      .finally(() => {
        asking.current = false
      })
  }, [live, pid, name, connection, polls])

  const act = useCallback(
    async (verb: Verb, arg?: string): Promise<void> => {
      if (name === null && verb !== "setup") return
      setBusy(verb)
      setFailure(null)
      try {
        const extra = arg === undefined || arg === "" ? [] : [arg]
        const out = verb === "setup" ? await winvm("setup") : await winvm(verb, "-i", name ?? "default", ...extra)
        const ran: Ran = { verb, code: out.code, output: outputText(out) }
        setLast(ran)
        if (out.code !== 0) setFailure(ran)
        // Show what the verb did at once; reads already out describe the machine before it.
        guard.current.settle(out.code === 0 ? phaseAfter(verb) : null)
      } catch (e) {
        const ran: Ran = { verb, code: -1, output: errorText(e) }
        setLast(ran)
        setFailure(ran)
        guard.current.settle(null)
      } finally {
        setHeld(guard.current.held)
        setBusy(null)
      }
      if (verb === "setup") await loadChecks()
      if (name !== null) await loadStatus(name).catch(() => undefined)
    },
    [name, loadChecks, loadStatus],
  )

  const openScreenSharing = useCallback(async (): Promise<void> => {
    if (name === null) return
    const out = await winvm("open", "-i", name)
    if (out.code !== 0) setFailure({ verb: "open", code: out.code, output: outputText(out) })
  }, [name])

  const installCommand = useCallback(async (): Promise<void> => {
    try {
      setCliPath(await installCli())
    } catch (e) {
      setFailure({ verb: "setup", code: -1, output: errorText(e) })
    }
  }, [])

  const select = useCallback((next: string): void => {
    // Another machine: nothing held, and the last one's reads still out are stale.
    guard.current.settle(null)
    setHeld(null)
    setStatus(null)
    setConnection(null)
    setName(next)
  }, [])

  const rename = useCallback(
    async (title: string): Promise<string | null> => {
      if (name === null) return null
      const out = await winvm("config", "-i", name, titleAssignment(title))
      if (out.code !== 0) return outputText(out) || `winvm config exited ${String(out.code)}`
      const set = title.trim()
      setTitles((was) => ({ ...was, [name]: set === "" ? null : set }))
      return null
    },
    [name],
  )

  return {
    names,
    name,
    titles,
    // This machine's state as shown here, so the picker agrees with the toolbar.
    phases: name !== null && p !== null && phases[name] !== p ? { ...phases, [name]: p } : phases,
    rename,
    refresh: async () => {
      await loadNames()
    },
    status: current,
    phase: p,
    statusError,
    checks,
    checksError,
    connection: connection !== null && connection.pid === pid ? connection.conn : null,
    busy,
    failure,
    last,
    cliPath,
    select,
    act,
    openScreenSharing,
    installCommand,
    dismissFailure: () => setFailure(null),
  }
}
