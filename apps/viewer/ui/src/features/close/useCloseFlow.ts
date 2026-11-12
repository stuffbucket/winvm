import { useCallback, useEffect, useRef, useState } from "react"

import {
  closeCancel,
  closeComplete,
  closePending,
  closeStart,
  errorMessage,
  onViewerCloseRequested,
  outputText,
  winvm,
} from "../../backend"
import { t } from "../../i18n"
import type { Status } from "../../model"
import { closePolicyAssignment, isLivePhase, phase, shownTitle } from "../../model"
import type { ActiveOperation, Verb, Winvm } from "../winvm/useWinvm"
import { operationFor } from "../winvm/statusGuard"
import { orderCloseQueue } from "./closeQueue"

/** What the close flow is doing, for the dialog and the window. */
export type CloseFlowState =
  | { readonly kind: "idle" }
  | { readonly kind: "waiting"; readonly machine: Status; readonly operation: ActiveOperation; readonly index: number; readonly total: number }
  | { readonly kind: "asking"; readonly machine: Status; readonly index: number; readonly total: number; readonly remember: boolean }
  | { readonly kind: "acting"; readonly machine: Status; readonly policy: "stow" | "shutdown"; readonly index: number; readonly total: number }
  | { readonly kind: "failed"; readonly machine: Status | null; readonly message: string }

export type CloseChoice = "leave" | "stow" | "shutdown"

export interface CloseFlow {
  readonly state: CloseFlowState
  setRemember(value: boolean): void
  choose(policy: CloseChoice): void
  cancel(): void
}

const IDLE: CloseFlowState = { kind: "idle" }

/** The command each mutating choice runs: Shut Down is the graceful `stop`. */
const VERB = { stow: "stow", shutdown: "stop" } as const satisfies Record<Exclude<CloseChoice, "leave">, Verb>

/** The person's answer to one ask. */
type Answer = { readonly policy: CloseChoice; readonly remember: boolean }

/** One close transaction; `cancelled` once it has been abandoned, so nothing it still awaits acts on. */
interface Transaction {
  cancelled: boolean
  /** Ends a wait for another command early, when the person cancels. */
  wake: (() => void) | null
}

/** How often a machine busy with another command is read again: the window's own fast poll. */
const WAIT_MS = 1500

/**
 * What `s` is busy with that this flow did not start: this window's own command on it (the
 * selected machine), else one another process published. Null when it is free.
 */
function busyWith(w: Winvm, s: Status): ActiveOperation | null {
  if (w.name === s.name && w.busy !== null) return { operation: operationFor(w.busy), source: "local" }
  return s.operation === null ? null : { operation: s.operation.operation, source: "external" }
}

/** How one machine came out: resolved (left, stowed, shut down), skipped (no longer live), or the flow stopped. */
type Outcome = "resolved" | "skipped" | "stopped"

/** Writes `name`'s close policy; resolves with why it couldn't, or null. Its result is read, never swallowed. */
async function rememberChoice(name: string, choice: CloseChoice): Promise<string | null> {
  try {
    const out = await winvm("config", "-i", name, closePolicyAssignment(choice))
    return out.code === 0 ? null : outputText(out) || `winvm config exited ${String(out.code)}`
  } catch (e) {
    return errorMessage(e)
  }
}

/**
 * The viewer's close: every live machine resolved, one at a time, before the app may exit.
 *
 * Rust holds the app open and tells the main window once (`viewer-close-requested`); this claims
 * the request with `closeStart`, reads every machine afresh, and resolves the selected one first,
 * then the others in list order. A machine's remembered policy is applied as it is; `ask` asks.
 * Once none is left, it reads every machine again, in case one started meanwhile, and only when
 * that finds none unresolved does it tell Rust the app may exit.
 */
export function useCloseFlow(w: Winvm): CloseFlow {
  const [state, setState] = useState<CloseFlowState>(IDLE)
  // The latest Winvm: the native listener is registered once, and must never act on the first render's.
  const wRef = useRef(w)
  wRef.current = w
  // One flow at a time, claimed synchronously: a repeated request can't start a second.
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

    /**
     * The close can't go on: the window stays open, on the machine it was about, with what went
     * wrong, and Rust is told so the next close request starts afresh.
     */
    const fail = (tx: Transaction, machine: Status | null, message: string): void => {
      tx.cancelled = true
      if (transaction.current === tx) transaction.current = null
      if (machine !== null && wRef.current.name !== machine.name) wRef.current.select(machine.name)
      show({ kind: "failed", machine, message })
      active.current = false
      closeCancel().catch(() => undefined)
    }

    const resolveOne = async (tx: Transaction, name: string, known: Status | null, index: number, total: number): Promise<Outcome> => {
      if (wRef.current.name !== name) wRef.current.select(name)
      let s: Status | null
      for (;;) {
        // Decided from this fresh read, not the selected machine's shown status, which lags a selection.
        s = await wRef.current.refreshOne(name)
        if (tx.cancelled) return "stopped"
        if (s === null) {
          fail(tx, known, t("close.statusFailed"))
          return "stopped"
        }
        // Busy with a command this flow did not start: wait for it, never interrupt it.
        const operation = busyWith(wRef.current, s)
        if (operation === null) break
        show({ kind: "waiting", machine: s, operation, index, total })
        await new Promise<void>((wake) => {
          const timer = setTimeout(wake, WAIT_MS)
          tx.wake = () => {
            clearTimeout(timer)
            wake()
          }
        })
        tx.wake = null
        if (tx.cancelled) return "stopped"
      }
      if (!isLivePhase(phase(s))) return "skipped"
      let choice: CloseChoice
      let remember = false
      if (s.closePolicy === "ask") {
        // Remember starts unchecked on every ask.
        show({ kind: "asking", machine: s, index, total, remember: false })
        const chosen = await new Promise<Answer | null>((settle) => {
          answer.current = settle
        })
        answer.current = null
        // Cancelled: cancel() has already called the close off.
        if (chosen === null || tx.cancelled) return "stopped"
        choice = chosen.policy
        remember = chosen.remember
      } else {
        // Remembered: applied as it is, without asking.
        choice = s.closePolicy
      }
      if (choice !== "leave") {
        show({ kind: "acting", machine: s, policy: choice, index, total })
        // Named, not the selection: the person may look at another machine before it ends. No deadline: a stow takes as long as it takes.
        const ran = await wRef.current.runOn(name, VERB[choice])
        // Its own result, not the window's last failure, which may be another command's.
        if (ran === null || ran.code !== 0) {
          fail(tx, s, ran?.output || t("close.actionFailed", { title: shownTitle(s.name, s.title) }))
          return "stopped"
        }
      }
      // Remembered only now that it has worked, for this machine's stable name, never its title.
      if (remember) {
        const why = await rememberChoice(name, choice)
        if (why !== null) {
          fail(tx, s, why)
          return "stopped"
        }
      }
      show(IDLE)
      return "resolved"
    }

    const run = async (tx: Transaction): Promise<void> => {
      const resolved = new Set<string>()
      // The machine to stay on if the list can't be read: the one shown, else the last one resolved.
      let last: Status | null = wRef.current.status
      let list = await wRef.current.refreshAll()
      if (list === null) return fail(tx, last, t("close.statusFailed"))
      let queue = orderCloseQueue(list, wRef.current.name, resolved)
      while (queue.length > 0) {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          const outcome = await resolveOne(tx, next, list.find((s) => s.name === next) ?? null, resolved.size + 1, resolved.size + queue.length + 1)
          if (outcome === "stopped") return
          if (outcome === "resolved") resolved.add(next)
          last = list.find((s) => s.name === next) ?? last
        }
        // Every machine asked about is resolved: one started meanwhile is not silently left out.
        list = await wRef.current.refreshAll()
        // Never read as "none left": that would let the app exit past a machine it never asked about.
        if (list === null) return fail(tx, last, t("close.statusFailed"))
        queue = orderCloseQueue(list, null, resolved)
      }
      // The app exits from here: nothing more to show.
      await closeComplete()
    }

    const begin = (): void => {
      if (active.current) return
      active.current = true
      const tx: Transaction = { cancelled: false, wake: null }
      transaction.current = tx
      closeStart().then(
        () =>
          // Anything unforeseen calls the close off rather than leave Rust holding the app open with no one answering.
          run(tx).catch((e: unknown) => {
            if (!tx.cancelled) fail(tx, wRef.current.status, errorMessage(e))
          }),
        () => {
          // Rust refused the claim (no request waits any more): another path has it, or it went. Drop this one quietly.
          active.current = false
        },
      )
    }

    const unlisten = onViewerCloseRequested(begin, () => {
      closePending().then(
        (pending) => {
          // Asked by a listener since removed (StrictMode's first mount, a window that went): not this one's to claim.
          if (pending && !gone) begin()
        },
        () => undefined,
      )
    })
    return () => {
      gone = true
      unlisten()
    }
  }, [show])

  const choose = useCallback((policy: CloseChoice): void => {
    const now = shown.current
    if (now.kind !== "asking") return
    // Taken once: a second click before the dialog goes runs nothing more.
    const settle = answer.current
    answer.current = null
    settle?.({ policy, remember: now.remember })
  }, [])

  const setRemember = useCallback(
    (value: boolean): void => {
      const now = shown.current
      if (now.kind === "asking" && now.remember !== value) show({ ...now, remember: value })
    },
    [show],
  )

  const cancel = useCallback((): void => {
    const now = shown.current
    // A failure's notice is dismissed; the close itself was already called off.
    if (now.kind === "failed") {
      show(IDLE)
      return
    }
    // Only an ask, or a wait for a command this flow did not start, can be backed out of; that
    // command carries on. Once this flow runs a stow or a shutdown, it runs to its end.
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
    closeCancel().catch(() => undefined)
  }, [show])

  return {
    state,
    setRemember,
    choose,
    cancel,
  }
}
