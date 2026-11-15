import "bun:test"

declare module "bun:test" {
  type AsyncMatchers<T> = {
    [K in keyof Omit<
      Matchers<T>,
      "not" | "resolves" | "rejects"
    >]: Matchers<T>[K] extends (...args: infer Args) => void
      ? (...args: Args) => Promise<void>
      : Matchers<T>[K]
  } & { not: AsyncMatchers<unknown> }

  interface Matchers<T> {
    resolves: AsyncMatchers<Awaited<T>>
    rejects: AsyncMatchers<unknown>
  }
}
