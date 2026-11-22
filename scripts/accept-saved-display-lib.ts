export const SOCKET_PATH_LIMIT = 103

export function socketPathProblem(
  paths: readonly string[],
  limit = SOCKET_PATH_LIMIT,
): string | null {
  const longest = paths.reduce((a, b) => (b.length > a.length ? b : a), "")
  if (longest.length <= limit) return null
  return `the socket path ${longest} is ${String(longest.length)} characters; a unix socket path is limited to ${String(limit)}. Use a shorter temporary root.`
}

export function runtimePin(
  env: Readonly<Record<string, string | undefined>>,
  runtimeCache: string,
): Record<string, string> {
  const set = (name: string): boolean => (env[name] ?? "") !== ""
  return set("WINVM_RUNTIME_CACHE") || set("WINVM_RUNTIME")
    ? {}
    : { WINVM_RUNTIME_CACHE: runtimeCache }
}

export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | undefined
  return () => (started ??= fn())
}

export type TerminationSignal = "SIGINT" | "SIGTERM"
const SIGNAL_NUMBERS: Readonly<Record<TerminationSignal, number>> = {
  SIGINT: 2,
  SIGTERM: 15,
}

export const signalExitCode = (signal: TerminationSignal): number =>
  128 + SIGNAL_NUMBERS[signal]

export interface RunState {
  readonly passed: boolean
  readonly interrupted: TerminationSignal | null
  readonly stopped: boolean
}

export function finish(s: RunState): {
  readonly removeRoot: boolean
  readonly passed: boolean
  readonly exitCode: number
} {
  if (s.interrupted !== null)
    return {
      removeRoot: false,
      passed: false,
      exitCode: signalExitCode(s.interrupted),
    }
  if (!s.passed) return { removeRoot: false, passed: false, exitCode: 1 }
  return s.stopped
    ? { removeRoot: true, passed: true, exitCode: 0 }
    : { removeRoot: false, passed: false, exitCode: 1 }
}

export interface SignalSource {
  on(signal: TerminationSignal, listener: () => void): unknown
}

export function exitOnSignals(
  source: SignalSource,
  hooks: {
    readonly interrupted: (signal: TerminationSignal) => void
    readonly cleanup: () => Promise<void>
    readonly report: (signal: TerminationSignal) => void
    readonly exit: (code: number) => void
  },
): void {
  let handling = false
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    source.on(signal, () => {
      if (handling) return
      handling = true
      hooks.interrupted(signal)
      void hooks
        .cleanup()
        .catch(() => undefined)
        .then(() => {
          hooks.report(signal)
          hooks.exit(signalExitCode(signal))
        })
    })
  }
}
