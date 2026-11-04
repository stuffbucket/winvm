/**
 * Helpers for scripts/accept-saved-display.ts that need no winvm modules, so
 * the guards and the cleanup protocol can be tested without a VM.
 */

/** macOS `sun_path` holds 104 bytes including the terminating NUL. */
export const SOCKET_PATH_LIMIT = 103

/**
 * Why a unix socket cannot live at one of `paths`, or null. QEMU, swtpm and the
 * CLI's own clients all bind or connect by path, and fail with an opaque EINVAL
 * when it is too long (a deep `$TMPDIR` is the usual cause), long after a 15 GB
 * image has been cloned.
 */
export function socketPathProblem(paths: readonly string[], limit = SOCKET_PATH_LIMIT): string | null {
  const longest = paths.reduce((a, b) => (b.length > a.length ? b : a), "")
  if (longest.length <= limit) return null
  return `the socket path ${longest} is ${String(longest.length)} characters; a unix socket path is limited to ${String(limit)}. Use a shorter temporary root.`
}

/**
 * The environment to add so a redirected XDG_DATA_HOME does not hide the
 * runtime: `runtimeCache` is where the runtime resolves in the person's own
 * environment. Nothing when the runtime is already pinned some other way.
 */
export function runtimePin(env: Readonly<Record<string, string | undefined>>, runtimeCache: string): Record<string, string> {
  const set = (name: string): boolean => (env[name] ?? "") !== ""
  return set("WINVM_RUNTIME_CACHE") || set("WINVM_RUNTIME") ? {} : { WINVM_RUNTIME_CACHE: runtimeCache }
}

/** Run `fn` at most once; every caller gets the first call's promise. */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | undefined
  return () => (started ??= fn())
}

export type TerminationSignal = "SIGINT" | "SIGTERM"
const SIGNAL_NUMBERS: Readonly<Record<TerminationSignal, number>> = { SIGINT: 2, SIGTERM: 15 }

/** The shell's convention for a process ended by a signal. */
export const signalExitCode = (signal: TerminationSignal): number => 128 + SIGNAL_NUMBERS[signal]

export interface SignalSource {
  on(signal: TerminationSignal, listener: () => void): unknown
}

/**
 * On SIGINT or SIGTERM: say the run was interrupted (so it is not a pass and
 * its root is kept), run `cleanup` (which must be safe to share with the normal
 * path, see `once`), report, then exit non-zero. A second signal while the
 * cleanup runs is ignored so it cannot cut the cleanup short.
 */
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
