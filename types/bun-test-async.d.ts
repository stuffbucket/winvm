import "bun:test"

declare module "bun:test" {
  interface TypedAsyncMatchers<T> {
    toBe(expected: T): Promise<void>
    toBe<X = T>(expected: NoInfer<X>): Promise<void>
    toEqual(expected: T): Promise<void>
    toEqual<X = T>(expected: NoInfer<X>): Promise<void>
    toStrictEqual(expected: T): Promise<void>
    toStrictEqual<X = T>(expected: NoInfer<X>): Promise<void>
    toContain(expected: T extends Iterable<infer U> ? U : T): Promise<void>
    toContain<X = T>(
      expected: NoInfer<X extends Iterable<infer U> ? U : X>,
    ): Promise<void>
    toContainEqual(expected: T extends Iterable<infer U> ? U : T): Promise<void>
    toContainEqual<X = T>(
      expected: NoInfer<X extends Iterable<infer U> ? U : X>,
    ): Promise<void>
  }

  type AsyncMatchers<T> = TypedAsyncMatchers<T> & {
    [K in keyof Omit<
      Matchers<T>,
      "not" | "resolves" | "rejects" | keyof TypedAsyncMatchers<T>
    >]: Matchers<T>[K] extends (...args: infer Args) => void
      ? (...args: Args) => Promise<void>
      : Matchers<T>[K]
  } & { not: AsyncMatchers<T> }

  interface Matchers<T> {
    resolves: AsyncMatchers<Awaited<T>>
    rejects: AsyncMatchers<unknown>
  }
}
