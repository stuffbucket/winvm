import { expect, it } from "bun:test"

import { problem } from "./check-comments"

const line = (text: string) => problem("ts", `// ${text}`, false)
const block = (text: string) => problem("ts", `/* ${text} */`, true)

it("allows a reasoned oxlint line directive for one rule", () => {
  expect(
    line(
      "oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Tauri rejects with strings",
    ),
  ).toBeUndefined()
})

it("rejects an oxlint directive without a reason", () => {
  expect(
    line("oxlint-disable-next-line typescript/no-floating-promises"),
  ).toContain("oxlint directive")
  expect(
    line("oxlint-disable-next-line typescript/no-floating-promises --"),
  ).toContain("oxlint directive")
})

it("rejects the file, block, unscoped and multi-rule forms", () => {
  expect(
    line("oxlint-disable typescript/no-floating-promises -- reason"),
  ).toContain("oxlint directive")
  expect(
    block("oxlint-disable typescript/no-floating-promises -- reason"),
  ).toContain("oxlint directive")
  expect(
    block("oxlint-disable-next-line typescript/no-floating-promises -- reason"),
  ).toContain("oxlint directive")
  expect(line("oxlint-disable-next-line -- reason")).toContain(
    "oxlint directive",
  )
  expect(
    line("oxlint-disable-next-line typescript/a, typescript/b -- reason"),
  ).toContain("oxlint directive")
  expect(
    line("oxlint-enable typescript/no-floating-promises -- reason"),
  ).toContain("oxlint directive")
})

it("rejects every eslint directive, even with a reason or a URL", () => {
  expect(line("eslint-disable-next-line no-console")).toContain(
    "eslint directive",
  )
  expect(line("eslint-disable-next-line no-console -- reason")).toContain(
    "eslint directive",
  )
  expect(
    line("eslint-disable-next-line no-console -- see https://example.com/why"),
  ).toContain("eslint directive")
  expect(block("eslint-disable")).toContain("eslint directive")
  expect(block("eslint-enable")).toContain("eslint directive")
  expect(problem("rust", "// eslint-disable-line", false)).toContain(
    "eslint directive",
  )
})

it("still treats prose as prose and keeps the other allowed forms", () => {
  expect(line("just a remark")).toBe("prose comment")
  expect(line("a link https://example.com")).toBeUndefined()
  expect(line("@ts-expect-error the type is wrong")).toBeUndefined()
})
