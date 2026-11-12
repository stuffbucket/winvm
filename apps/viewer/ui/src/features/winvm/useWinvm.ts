import { useCallback, useEffect, useRef, useState } from "react"

import { errorMessage, installCli, outputText, winvm } from "../../backend"
import type { Checks, Connection, Phase, Status, VmOperation } from "../../model"
import { isLivePhase, parseChecks, parseConnection, parseStatus, phase, titleAssignment } from "../../model"
import { operationFor, phaseAfter, shownPhase, StatusGuard, type Verb } from "./statusGuard"

export type { Verb } from "./statusGuard"

export interface Ran {
  readonly verb: Verb | "open" | "put"
  readonly code: number
  readonly output: string
}

/** What a machine is busy with: this viewer's own command, or one another process published (a close elsewhere, `winvm` in a terminal). */
export interface ActiveOperation {
  readonly operation: VmOperation
  readonly source: "local" | "external"
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
  /** The command this viewer is running on the selected machine, if any. */
  readonly busy: Verb | null
  /** Whatever the selected machine is busy with, from either source; null when idle. */
  readonly operation: ActiveOperation | null
  readonly failure: Ran | null
  readonly last: Ran | null
  readonly cliPath: string | null
  select(name: string): void
  /** Runs a verb on this instance; `arg` names the save for save and load. Resolves with what it did (null: nothing to run). */
  act(verb: Verb, arg?: string): Promise<Ran | null>
  /** Runs a verb on `name`, the machine given and not the selected one; the selection may move before it ends. */
  runOn(name: string, verb: Verb, arg?: string): Promise<Ran | null>
  openScreenSharing(): Promise<void>
  installCommand(): Promise<void>
  dismissFailure(): void
  /** Sets this instance's title (empty clears it); resolves with why it couldn't, or null. */
  rename(title: string): Promise<string | null>
  /** Reads the list of machines again (after one is made or deleted). */
  refresh(): Promise<void>
  /** Reads every machine's status afresh; null when it can't be read. The selected machine's shown status follows. */
  refreshAll(): Promise<readonly Status[] | null>
  /** Reads one machine's status afresh, selected or not; null when it can't be read. */
  refreshOne(name: string): Promise<Status | null>
}

/** A command this viewer is running: against `target`, or (setup) against the host, which every machine waits for. */
interface Local {
  readonly target: string | null
  readonly verb: Verb
}

/**
 * A failure's words: a SidecarError (the helper missing, not starting, or
 * stopped at its deadline) carries the copy for it; never "[object Object]".
 * Polling carries on after any of them: the next read may well answer.
 */
const errorText = (e: unknown): string => errorMessage(e)

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
  const [locals, setLocals] = useState<readonly Local[]>([])
  const [failure, setFailure] = useState<Ran | null>(null)
  const [last, setLast] = useState<Ran | null>(null)
  const [cliPath, setCliPath] = useState<string | null>(null)
  const [polls, setPolls] = useState(0)
  // What the last verb left (paused, asleep, running), shown until a read started after it lands.
  const [held, setHeld] = useState<Phase | null>(null)
  const guard = useRef(new StatusGuard())
  const tick = useRef(0)
  const nameRef = useRef<string | null>(null)
  nameRef.current = name

  /** The picker's view of every machine, from a list read. */
  const showList = useCallback((list: readonly Status[]): void => {
    setNames(list.map((s) => s.name))
    setTitles(Object.fromEntries(list.map((s) => [s.name, s.title])))
    setPhases(Object.fromEntries(list.map((s) => [s.name, phase(s)])))
  }, [])

  const loadNames = useCallback(async (): Promise<string | null> => {
    const out = await winvm("status", "--json")
    const list = parseStatus(out.stdout)
    if (list === null) {
      setStatusError(outputText(out) || `winvm status exited ${String(out.code)}`)
      return null
    }
    showList(list)
    return list[0]?.name ?? "default"
  }, [showList])

  /**
   * Reads `target`'s status. The selected machine's answer lands through the guard (and is shown
   * only if no later read has landed); another's only updates the picker. Resolves with the answer
   * either way, null when there was none to read; a read that cannot run rejects.
   */
  const loadStatus = useCallback(async (target: string): Promise<Status | null> => {
    const ticket = guard.current.begin()
    const out = await winvm("status", "--json", "-i", target)
    const s = parseStatus(out.stdout)?.[0]
    if (s === undefined) {
      if (target === nameRef.current) setStatusError(outputText(out) || `winvm status exited ${String(out.code)}`)
      return null
    }
    if (target === nameRef.current) {
      // Overtaken by a read started later, or started before the last verb ended: stale.
      if (!guard.current.land(ticket)) return s
      setHeld(null)
      setStatusError(null)
      setStatus(s)
    }
    setTitles((was) => (was[s.name] === s.title ? was : { ...was, [s.name]: s.title }))
    setPhases((was) => (was[s.name] === phase(s) ? was : { ...was, [s.name]: phase(s) }))
    return s
  }, [])

  const refreshOne = useCallback(
    async (target: string): Promise<Status | null> => {
      try {
        return await loadStatus(target)
      } catch {
        return null
      }
    },
    [loadStatus],
  )

  const refreshAll = useCallback(async (): Promise<readonly Status[] | null> => {
    const ticket = guard.current.begin()
    try {
      const list = parseStatus((await winvm("status", "--json")).stdout)
      if (list === null) return null
      showList(list)
      const selected = list.find((s) => s.name === nameRef.current)
      if (selected !== undefined && guard.current.land(ticket)) {
        setHeld(null)
        setStatusError(null)
        setStatus(selected)
      }
      return list
    } catch {
      return null
    }
  }, [showList])

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
  }, [loadChecks])

  // Until a machine is known, the list is asked for again at the polling interval, one ask at a
  // time: a status that timed out (busy finishing a save or repair) or failed is tried again,
  // its error shown meanwhile, and the first answer chooses the machine.
  useEffect(() => {
    if (name !== null) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = async (): Promise<void> => {
      let first: string | null = null
      try {
        first = await loadNames()
      } catch (e) {
        setStatusError(errorText(e))
      }
      if (stopped) return
      if (first === null) {
        timer = setTimeout(() => void ask(), 4000)
        return
      }
      setStatusError(null)
      setName((cur) => cur ?? first)
    }
    void ask()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [name, loadNames])

  const current = status !== null && status.name === name ? status : null
  const p = shownPhase(held, current, phase)
  // This viewer's own command on the selected machine comes first; else one another process published.
  const busy = locals.find((l) => l.target === null || l.target === name)?.verb ?? null
  const operation: ActiveOperation | null =
    busy !== null
      ? { operation: operationFor(busy), source: "local" }
      : current?.operation == null
        ? null
        : { operation: current.operation.operation, source: "external" }
  const fast = operation !== null || p === "starting"

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

  /**
   * Runs `verb` against `target` (null: the host, for setup). The machine is named, not read from
   * the selection, so a close flow can stow one machine while the person looks at another.
   */
  const execute = useCallback(
    async (machine: string | null, verb: Verb, arg?: string): Promise<Ran> => {
      // Setup installs the runtime for the host, whichever machine asked: it names none, and every machine waits for it.
      const target = verb === "setup" ? null : machine
      const local: Local = { target, verb }
      setLocals((was) => [...was, local])
      setFailure(null)
      let result: Ran
      try {
        const extra = arg === undefined || arg === "" ? [] : [arg]
        const out = target === null ? await winvm("setup") : await winvm(verb, "-i", target, ...extra)
        const ran: Ran = { verb, code: out.code, output: outputText(out) }
        result = ran
        setLast(ran)
        if (out.code !== 0) setFailure(ran)
        // Show what the verb did at once; reads already out describe the machine before it.
        if (target === null || target === nameRef.current) guard.current.settle(out.code === 0 ? phaseAfter(verb) : null)
      } catch (e) {
        const ran: Ran = { verb, code: -1, output: errorText(e) }
        result = ran
        setLast(ran)
        setFailure(ran)
        if (target === null || target === nameRef.current) guard.current.settle(null)
      } finally {
        setHeld(guard.current.held)
        setLocals((was) => was.filter((l) => l !== local))
      }
      if (verb === "setup") await loadChecks()
      // Read the machine it ran on once more (the selected one, for setup): what is left is what the person and the close flow see.
      const after = target ?? nameRef.current
      if (after !== null) await loadStatus(after).catch(() => undefined)
      return result
    },
    [loadChecks, loadStatus],
  )

  const runOn = useCallback((target: string, verb: Verb, arg?: string): Promise<Ran | null> => execute(target, verb, arg), [execute])

  const act = useCallback(
    async (verb: Verb, arg?: string): Promise<Ran | null> => {
      const target = nameRef.current
      if (verb === "setup") return execute(null, verb, arg)
      return target === null ? null : execute(target, verb, arg)
    },
    [execute],
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
    refreshAll,
    refreshOne,
    status: current,
    phase: p,
    statusError,
    checks,
    checksError,
    connection: connection !== null && connection.pid === pid ? connection.conn : null,
    busy,
    operation,
    failure,
    last,
    cliPath,
    select,
    act,
    runOn,
    openScreenSharing,
    installCommand,
    dismissFailure: () => setFailure(null),
  }
}
