import { useCallback, useEffect, useRef, useState } from "react"

import {
  type CloseSession,
  type CloseSnapshot,
  closeAt,
  closeCancel,
  closeComplete,
  closeResolved,
  closeRun,
  closeStart,
  closeState,
  errorMessage,
  onViewerCloseRequested,
  onViewerCloseSession,
  outputText,
  winvm,
} from "../../backend"
import { t } from "../../i18n"
import type { Phase, Status, VmOperation } from "../../model"
import {
  closePolicyAssignment,
  isLivePhase,
  phase,
  shownTitle,
} from "../../model"
import { operationFor } from "../winvm/statusGuard"
import type { ActiveOperation, Verb, Winvm } from "../winvm/useWinvm"
import { orderCloseQueue } from "./closeQueue"

export type CloseFlowState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "waiting"
      readonly machine: Status
      readonly operation: ActiveOperation
      readonly index: number
      readonly total: number
    }
  | {
      readonly kind: "asking"
      readonly machine: Status
      readonly index: number
      readonly total: number
      readonly remember: boolean
    }
  | {
      readonly kind: "acting"
      readonly machine: Status
      readonly policy: "stow" | "shutdown"
      readonly index: number
      readonly total: number
    }
  | {
      readonly kind: "failed"
      readonly machine: Status | null
      readonly message: string
    }

export type CloseChoice = "leave" | "stow" | "shutdown"

export interface CloseFlow {
  readonly state: CloseFlowState
  readonly session: CloseSession | null
  setRemember: (value: boolean) => void
  choose: (policy: CloseChoice) => void
  cancel: () => void
}

const IDLE: CloseFlowState = { kind: "idle" }

const VERB = { stow: "stow", shutdown: "stop" } as const satisfies Record<
  Exclude<CloseChoice, "leave">,
  Verb
>

type Answer = { readonly policy: CloseChoice; readonly remember: boolean }

interface Transaction {
  cancelled: boolean
  wake: (() => void) | null
  ranBefore: (name: string) => number
  readonly resolved: Set<string>
  first: string | null
}

const transactionOf = (
  resolved: readonly string[],
  first: string | null,
): Transaction => ({
  cancelled: false,
  wake: null,
  ranBefore: () => 0,
  resolved: new Set(resolved),
  first,
})

const policyOf = (verb: string): "stow" | "shutdown" =>
  verb === "stow" ? "stow" : "shutdown"

const isCancelled = (tx: Transaction): boolean => tx.cancelled

function ranBefore(w: Winvm): (name: string) => number {
  const known = new Map(w.names.map((n) => [n, w.lastOn(n)?.seq ?? 0]))
  const latest = Math.max(0, ...known.values())
  return (name) => known.get(name) ?? latest
}

const WAIT_MS = 1500

function busyWith(w: Winvm, s: Status): ActiveOperation | null {
  if (w.name === s.name && w.busy !== null)
    return { operation: operationFor(w.busy), source: "local" }
  return s.operation === null
    ? null
    : { operation: s.operation.operation, source: "external" }
}

type Outcome = "resolved" | "skipped" | "stopped"

function settled(operation: VmOperation, p: Phase): boolean | null {
  switch (operation) {
    case "start":
    case "reboot":
    case "resume":
    case "wake":
      return p === "running" || p === "starting"
    case "stop":
    case "kill":
      return p === "stopped"
    case "stow":
      return p === "stowed"
    case "pause":
      return p === "paused"
    case "sleep":
      return p === "asleep"
    case "golden-create":
    case "golden-reset":
    case "load":
    case "lock":
    case "reset":
    case "rewind":
    case "save":
    case "setup":
    case "snapshot":
      return null
  }
}

async function rememberChoice(
  name: string,
  choice: CloseChoice,
): Promise<string | null> {
  try {
    const out = await winvm("config", "-i", name, closePolicyAssignment(choice))
    return out.code === 0
      ? null
      : outputText(out) || `winvm config exited ${String(out.code)}`
  } catch (e) {
    return errorMessage(e)
  }
}

export function useCloseFlow(w: Winvm): CloseFlow {
  const [state, setState] = useState<CloseFlowState>(IDLE)
  const [session, setSession] = useState<CloseSession | null>(null)
  const wRef = useRef(w)
  wRef.current = w
  const active = useRef(false)
  const shown = useRef<CloseFlowState>(IDLE)
  const answer = useRef<((a: Answer | null) => void) | null>(null)
  const transaction = useRef<Transaction | null>(null)

  const show = useCallback((next: CloseFlowState): void => {
    shown.current = next
    setState(next)
  }, [])

  useEffect(() => {
    let gone = false

    const fail = (
      tx: Transaction,
      machine: Status | null,
      message: string,
    ): void => {
      tx.cancelled = true
      if (transaction.current === tx) transaction.current = null
      if (machine !== null && wRef.current.name !== machine.name)
        wRef.current.select(machine.name)
      show({ kind: "failed", machine, message })
      setSession(null)
      active.current = false
      closeCancel().catch(() => undefined)
    }

    const resolveOne = async (
      tx: Transaction,
      name: string,
      known: Status | null,
      index: number,
      total: number,
    ): Promise<Outcome> => {
      if (wRef.current.name !== name) wRef.current.select(name)
      closeAt(name).catch(() => undefined)
      const before = tx.ranBefore(name)
      let external: VmOperation | null = null
      let s: Status | null
      for (;;) {
        s = await wRef.current.refreshOne(name)
        if (isCancelled(tx)) return "stopped"
        if (s === null) {
          fail(tx, known, t("close.statusFailed"))
          return "stopped"
        }
        const operation = busyWith(wRef.current, s)
        if (operation === null) break
        if (operation.source === "external") external = operation.operation
        show({ kind: "waiting", machine: s, operation, index, total })
        await new Promise<void>((wake) => {
          const timer = setTimeout(wake, WAIT_MS)
          tx.wake = () => {
            clearTimeout(timer)
            wake()
          }
        })
        tx.wake = null
        if (isCancelled(tx)) return "stopped"
      }
      const own = wRef.current.lastOn(name)
      if (own !== null && own.seq > before && own.code !== 0) {
        fail(
          tx,
          s,
          own.output ||
            t("close.actionFailed", { title: shownTitle(s.name, s.title) }),
        )
        return "stopped"
      }
      if (external !== null && settled(external, phase(s)) === false) {
        fail(
          tx,
          s,
          t("close.externalFailed", {
            operation: external,
            title: shownTitle(s.name, s.title),
          }),
        )
        return "stopped"
      }
      if (!isLivePhase(phase(s))) return "skipped"
      let choice: CloseChoice
      let remember = false
      const unsure = external !== null && settled(external, phase(s)) === null
      if (s.closePolicy === "ask" || unsure) {
        show({ kind: "asking", machine: s, index, total, remember: false })
        const chosen = await new Promise<Answer | null>((settle) => {
          answer.current = settle
        })
        answer.current = null
        if (chosen === null || isCancelled(tx)) return "stopped"
        choice = chosen.policy
        remember = chosen.remember
      } else {
        choice = s.closePolicy
      }
      if (choice !== "leave") {
        show({ kind: "acting", machine: s, policy: choice, index, total })
        const ran = await wRef.current.runOn(
          name,
          VERB[choice],
          undefined,
          closeRun,
        )
        if (ran === null || ran.code !== 0) {
          fail(
            tx,
            s,
            ran?.output ||
              t("close.actionFailed", { title: shownTitle(s.name, s.title) }),
          )
          return "stopped"
        }
      }
      if (remember) {
        const why = await rememberChoice(name, choice)
        if (why !== null) {
          fail(tx, s, why)
          return "stopped"
        }
      }
      await closeResolved(name).catch(() => undefined)
      show(IDLE)
      return "resolved"
    }

    const run = async (tx: Transaction): Promise<void> => {
      const resolved = tx.resolved
      let last: Status | null = wRef.current.status
      let list = await wRef.current.refreshAll()
      if (list === null) {
        fail(tx, last, t("close.statusFailed"))
        return
      }
      let queue = orderCloseQueue(list, tx.first ?? wRef.current.name, resolved)
      while (queue.length > 0) {
        for (
          let next = queue.shift();
          next !== undefined;
          next = queue.shift()
        ) {
          const outcome = await resolveOne(
            tx,
            next,
            list.find((s) => s.name === next) ?? null,
            resolved.size + 1,
            resolved.size + queue.length + 1,
          )
          if (outcome === "stopped") return
          if (outcome === "resolved") resolved.add(next)
          last = list.find((s) => s.name === next) ?? last
        }
        list = await wRef.current.refreshAll()
        if (list === null) {
          fail(tx, last, t("close.statusFailed"))
          return
        }
        queue = orderCloseQueue(list, null, resolved)
      }
      await closeComplete()
    }

    const settle = (tx: Transaction, work: Promise<void>): void => {
      work.catch((e: unknown) => {
        if (!tx.cancelled) fail(tx, wRef.current.status, errorMessage(e))
      })
    }

    const begin = (): void => {
      if (active.current) return
      active.current = true
      const tx = transactionOf([], null)
      transaction.current = tx
      closeStart().then(
        () => {
          tx.ranBefore = ranBefore(wRef.current)
          settle(tx, run(tx))
        },
        () => {
          active.current = false
        },
      )
    }

    const resume = async (
      tx: Transaction,
      from: CloseSnapshot,
    ): Promise<void> => {
      let snapshot = from
      for (
        let command = snapshot.command;
        command !== null;
        command = snapshot.command
      ) {
        if (wRef.current.name !== command.machine)
          wRef.current.select(command.machine)
        const s = await wRef.current.refreshOne(command.machine)
        if (isCancelled(tx)) return
        if (s !== null)
          show({
            kind: "acting",
            machine: s,
            policy: policyOf(command.verb),
            index: tx.resolved.size + 1,
            total: tx.resolved.size + 1,
          })
        await new Promise<void>((wake) => {
          setTimeout(wake, WAIT_MS)
        })
        snapshot = await closeState()
        if (isCancelled(tx)) return
      }
      if (snapshot.state !== "running") {
        if (transaction.current === tx) transaction.current = null
        active.current = false
        show(IDLE)
        return
      }
      const ended = snapshot.last
      if (ended !== null && ended.code !== 0) {
        const s = await wRef.current.refreshOne(ended.machine)
        fail(
          tx,
          s,
          ended.output ||
            t("close.actionFailed", {
              title: s === null ? ended.machine : shownTitle(s.name, s.title),
            }),
        )
        return
      }
      tx.first = snapshot.machine ?? tx.first
      await run(tx)
    }

    const adopt = (snapshot: CloseSnapshot): void => {
      if (active.current) return
      active.current = true
      const tx = transactionOf(snapshot.resolved, snapshot.machine)
      tx.ranBefore = ranBefore(wRef.current)
      transaction.current = tx
      settle(tx, resume(tx, snapshot))
    }

    const unlistenSession = onViewerCloseSession((next) => {
      if (!gone) setSession(next)
    })
    const unlisten = onViewerCloseRequested(begin, () => {
      closeState().then(
        (snapshot) => {
          if (gone) return
          if (snapshot.session !== null) setSession(snapshot.session)
          if (snapshot.state === "requested") begin()
          else if (snapshot.state === "running") adopt(snapshot)
        },
        () => undefined,
      )
    })
    return () => {
      gone = true
      unlisten()
      unlistenSession()
    }
  }, [show])

  const choose = useCallback((policy: CloseChoice): void => {
    const now = shown.current
    if (now.kind !== "asking") return
    const settle = answer.current
    answer.current = null
    settle?.({ policy, remember: now.remember })
  }, [])

  const setRemember = useCallback(
    (value: boolean): void => {
      const now = shown.current
      if (now.kind === "asking" && now.remember !== value)
        show({ ...now, remember: value })
    },
    [show],
  )

  const cancel = useCallback((): void => {
    const now = shown.current
    if (now.kind === "failed") {
      show(IDLE)
      return
    }
    if (now.kind !== "asking" && now.kind !== "waiting") return
    const tx = transaction.current
    if (tx !== null) {
      tx.cancelled = true
      tx.wake?.()
    }
    transaction.current = null
    answer.current?.(null)
    active.current = false
    show(IDLE)
    setSession(null)
    closeCancel().catch(() => undefined)
  }, [show])

  return {
    state,
    session,
    setRemember,
    choose,
    cancel,
  }
}
