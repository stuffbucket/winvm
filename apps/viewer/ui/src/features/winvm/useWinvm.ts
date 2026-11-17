import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  errorMessage,
  installCli,
  type Output,
  outputText,
  winvm,
} from "../../backend"
import type {
  Checks,
  ClosePolicy,
  Connection,
  Phase,
  Status,
  VmOperation,
} from "../../model"
import {
  closePolicyAssignment,
  isLivePhase,
  parseChecks,
  parseConnection,
  parseStatus,
  phase,
  titleAssignment,
} from "../../model"
import { type AgentSeen, agentSeen, UNSEEN } from "./agentSeen"
import {
  operationFor,
  phaseAfter,
  StatusGuard,
  shownPhase,
  type Verb,
} from "./statusGuard"

export type { Verb } from "./statusGuard"

export interface RunOptions {
  readonly format?: "zstd" | "mapped"
}

export interface Ran {
  readonly verb: Verb | "open" | "put"
  readonly code: number
  readonly output: string
}

interface RanOn extends Ran {
  readonly seq: number
}

type Runner = (...args: string[]) => Promise<Output>

export interface ActiveOperation {
  readonly operation: VmOperation
  readonly source: "local" | "external"
}

export interface Winvm {
  readonly names: readonly string[]
  readonly name: string | null
  readonly titles: Readonly<Record<string, string | null>>
  readonly phases: Readonly<Record<string, Phase>>
  readonly status: Status | null
  readonly phase: Phase | null
  readonly agentSeen: AgentSeen
  readonly statusError: string | null
  readonly checks: Checks | null
  readonly checksError: string | null
  readonly connection: Connection | null
  readonly busy: Verb | null
  readonly operation: ActiveOperation | null
  readonly failure: Ran | null
  readonly last: Ran | null
  readonly cliPath: string | null
  select: (name: string) => void
  act: (verb: Verb, arg?: string, options?: RunOptions) => Promise<Ran | null>
  runOn: (
    name: string,
    verb: Verb,
    arg?: string,
    through?: Runner,
  ) => Promise<Ran | null>
  lastOn(name: string): RanOn | null
  openScreenSharing(): Promise<void>
  installCommand: () => Promise<void>
  dismissFailure: () => void
  rename: (title: string) => Promise<string | null>
  setClosePolicy(policy: ClosePolicy): Promise<string | null>
  refresh(): Promise<void>
  refreshAll(): Promise<readonly Status[] | null>
  refreshOne(name: string): Promise<Status | null>
}

interface Local {
  readonly target: string | null
  readonly verb: Verb
}

const errorText = (e: unknown): string => errorMessage(e)

export function useWinvm(): Winvm {
  const [names, setNames] = useState<readonly string[]>([])
  const [name, setName] = useState<string | null>(null)
  const [titles, setTitles] = useState<Readonly<Record<string, string | null>>>(
    {},
  )
  const [phases, setPhases] = useState<Readonly<Record<string, Phase>>>({})
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [checks, setChecks] = useState<Checks | null>(null)
  const [checksError, setChecksError] = useState<string | null>(null)
  const [connection, setConnection] = useState<{
    pid: number
    conn: Connection
  } | null>(null)
  const [locals, setLocals] = useState<readonly Local[]>([])
  const [failure, setFailure] = useState<Ran | null>(null)
  const [last, setLast] = useState<Ran | null>(null)
  const [cliPath, setCliPath] = useState<string | null>(null)
  const [polls, setPolls] = useState(0)
  const [seen, setSeen] = useState<AgentSeen>(UNSEEN)
  const [held, setHeld] = useState<Phase | null>(null)
  const guard = useRef(new StatusGuard())
  const outcomes = useRef(new Map<string, RanOn>())
  const ranCount = useRef(0)
  const tick = useRef(0)
  const nameRef = useRef<string | null>(null)
  nameRef.current = name

  const showList = useCallback((list: readonly Status[]): void => {
    setNames(list.map((s) => s.name))
    setTitles(Object.fromEntries(list.map((s) => [s.name, s.title])))
    setPhases(Object.fromEntries(list.map((s) => [s.name, phase(s)])))
  }, [])

  const loadNames = useCallback(async (): Promise<string | null> => {
    const out = await winvm("status", "--json")
    const list = parseStatus(out.stdout)
    if (list === null) {
      setStatusError(
        outputText(out) || `winvm status exited ${String(out.code)}`,
      )
      return null
    }
    showList(list)
    return list[0]?.name ?? "default"
  }, [showList])

  const loadStatus = useCallback(
    async (target: string): Promise<Status | null> => {
      const ticket = guard.current.begin()
      const out = await winvm("status", "--json", "-i", target)
      const s = parseStatus(out.stdout)?.[0]
      if (s === undefined) {
        if (target === nameRef.current)
          setStatusError(
            outputText(out) || `winvm status exited ${String(out.code)}`,
          )
        return null
      }
      if (target === nameRef.current) {
        if (!guard.current.land(ticket)) return s
        setHeld(null)
        setStatusError(null)
        setStatus(s)
        setSeen((was) => agentSeen(was, s))
      }
      setTitles((was) =>
        was[s.name] === s.title ? was : { ...was, [s.name]: s.title },
      )
      setPhases((was) =>
        was[s.name] === phase(s) ? was : { ...was, [s.name]: phase(s) },
      )
      return s
    },
    [],
  )

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

  const refreshAll = useCallback(async (): Promise<
    readonly Status[] | null
  > => {
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
        setSeen((was) => agentSeen(was, selected))
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
      setChecksError(
        c === null
          ? outputText(out) || `winvm doctor exited ${String(out.code)}`
          : null,
      )
    } catch (e) {
      setChecksError(errorText(e))
    }
  }, [])

  useEffect(() => {
    void loadChecks()
  }, [loadChecks])

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
  const busy =
    locals.find((l) => l.target === null || l.target === name)?.verb ?? null
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
  const polled = useMemo(
    () => ({ live, pid, name, polls }),
    [live, pid, name, polls],
  )
  useEffect(() => {
    const { pid, name } = polled
    if (!polled.live || pid === null || name === null) {
      setConnection(null)
      return
    }
    if ((connection !== null && connection.pid === pid) || asking.current)
      return
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
  }, [polled, connection])

  const execute = useCallback(
    async (
      machine: string | null,
      verb: Verb,
      arg?: string,
      through: Runner = winvm,
      options?: RunOptions,
    ): Promise<Ran> => {
      const target = verb === "setup" ? null : machine
      const owner = target ?? nameRef.current
      const local: Local = { target, verb }
      const record = (ran: Ran): void => {
        if (owner === null) return
        ranCount.current += 1
        outcomes.current.set(owner, { ...ran, seq: ranCount.current })
      }
      setLocals((was) => [...was, local])
      setFailure(null)
      let result: Ran
      try {
        const extra = [
          ...(arg === undefined || arg === "" ? [] : [arg]),
          ...(verb === "save" && options?.format !== undefined
            ? ["--format", options.format]
            : []),
        ]
        const out =
          target === null
            ? await winvm("setup")
            : await through(verb, "-i", target, ...extra)
        const ran: Ran = { verb, code: out.code, output: outputText(out) }
        result = ran
        record(ran)
        setLast(ran)
        if (out.code !== 0) setFailure(ran)
        if (target === null || target === nameRef.current)
          guard.current.settle(out.code === 0 ? phaseAfter(verb) : null)
      } catch (e) {
        const ran: Ran = { verb, code: -1, output: errorText(e) }
        result = ran
        record(ran)
        setLast(ran)
        setFailure(ran)
        if (target === null || target === nameRef.current)
          guard.current.settle(null)
      } finally {
        setHeld(guard.current.held)
        setLocals((was) => was.filter((l) => l !== local))
      }
      if (verb === "setup") await loadChecks()
      const after = target ?? nameRef.current
      if (after !== null) await loadStatus(after).catch(() => undefined)
      return result
    },
    [loadChecks, loadStatus],
  )

  const runOn = useCallback(
    (
      target: string,
      verb: Verb,
      arg?: string,
      through?: Runner,
    ): Promise<Ran | null> => execute(target, verb, arg, through),
    [execute],
  )

  const lastOn = useCallback(
    (target: string): RanOn | null => outcomes.current.get(target) ?? null,
    [],
  )

  const act = useCallback(
    async (
      verb: Verb,
      arg?: string,
      options?: RunOptions,
    ): Promise<Ran | null> => {
      const target = nameRef.current
      if (verb === "setup") return execute(null, verb, arg)
      return target === null
        ? null
        : execute(target, verb, arg, undefined, options)
    },
    [execute],
  )

  const openScreenSharing = useCallback(async (): Promise<void> => {
    if (name === null) return
    const out = await winvm("open", "-i", name)
    if (out.code !== 0)
      setFailure({ verb: "open", code: out.code, output: outputText(out) })
  }, [name])

  const installCommand = useCallback(async (): Promise<void> => {
    try {
      setCliPath(await installCli())
    } catch (e) {
      setFailure({ verb: "setup", code: -1, output: errorText(e) })
    }
  }, [])

  const select = useCallback((next: string): void => {
    guard.current.settle(null)
    setHeld(null)
    setStatus(null)
    setSeen(UNSEEN)
    setConnection(null)
    setName(next)
  }, [])

  const rename = useCallback(
    async (title: string): Promise<string | null> => {
      if (name === null) return null
      const out = await winvm("config", "-i", name, titleAssignment(title))
      if (out.code !== 0)
        return outputText(out) || `winvm config exited ${String(out.code)}`
      const set = title.trim()
      setTitles((was) => ({ ...was, [name]: set === "" ? null : set }))
      return null
    },
    [name],
  )

  const setClosePolicy = useCallback(
    async (policy: ClosePolicy): Promise<string | null> => {
      const target = nameRef.current
      if (target === null) return null
      try {
        const out = await winvm(
          "config",
          "-i",
          target,
          closePolicyAssignment(policy),
        )
        if (out.code !== 0)
          return outputText(out) || `winvm config exited ${String(out.code)}`
      } catch (e) {
        return errorText(e)
      }
      await refreshOne(target)
      return null
    },
    [refreshOne],
  )

  return {
    names,
    name,
    titles,
    phases:
      name !== null && p !== null && phases[name] !== p
        ? { ...phases, [name]: p }
        : phases,
    rename,
    setClosePolicy,
    refresh: async () => {
      await loadNames()
    },
    refreshAll,
    refreshOne,
    status: current,
    phase: p,
    agentSeen: seen,
    statusError,
    checks,
    checksError,
    connection:
      connection !== null && connection.pid === pid ? connection.conn : null,
    busy,
    operation,
    failure,
    last,
    cliPath,
    select,
    act,
    runOn,
    lastOn,
    openScreenSharing,
    installCommand,
    dismissFailure: () => {
      setFailure(null)
    },
  }
}
