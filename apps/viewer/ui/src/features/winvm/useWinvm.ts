import { useCallback, useEffect, useRef, useState } from "react"

import { installCli, outputText, winvm } from "../../backend"
import type { Checks, Connection, Phase, Status } from "../../model"
import { parseChecks, parseConnection, parseStatus, phase } from "../../model"

export type Verb = "start" | "stop" | "reboot" | "pause" | "resume" | "kill" | "setup"

export interface Ran {
  readonly verb: Verb | "open"
  readonly code: number
  readonly output: string
}

export interface Winvm {
  readonly names: readonly string[]
  readonly name: string | null
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
  act(verb: Verb): Promise<void>
  openScreenSharing(): Promise<void>
  installCommand(): Promise<void>
  dismissFailure(): void
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function useWinvm(): Winvm {
  const [names, setNames] = useState<readonly string[]>([])
  const [name, setName] = useState<string | null>(null)
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
    return found[0] ?? "default"
  }, [])

  const loadStatus = useCallback(async (target: string): Promise<void> => {
    const out = await winvm("status", "--json", "-i", target)
    const s = parseStatus(out.stdout)?.[0]
    if (s === undefined) {
      setStatusError(outputText(out) || `winvm status exited ${String(out.code)}`)
      return
    }
    setStatusError(null)
    setStatus(s)
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
  const p = current === null ? null : phase(current)
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

  const live = p === "running" || p === "starting" || p === "paused"
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
    async (verb: Verb): Promise<void> => {
      if (name === null && verb !== "setup") return
      setBusy(verb)
      setFailure(null)
      try {
        const out = verb === "setup" ? await winvm("setup") : await winvm(verb, "-i", name ?? "default")
        const ran: Ran = { verb, code: out.code, output: outputText(out) }
        setLast(ran)
        if (out.code !== 0) setFailure(ran)
      } catch (e) {
        const ran: Ran = { verb, code: -1, output: errorText(e) }
        setLast(ran)
        setFailure(ran)
      } finally {
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
    setStatus(null)
    setConnection(null)
    setName(next)
  }, [])

  return {
    names,
    name,
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
