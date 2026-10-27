import { expect, it } from "bun:test"

import { subjectOf, subjectProblem } from "./check-commit-msg"

it("accepts a Conventional Commit subject", () => {
  expect(subjectProblem("fix(qemu): pass ppi=off only when supported")).toBeUndefined()
})

it("accepts subjects git writes itself", () => {
  expect(subjectProblem("Merge branch 'main' into feat/x")).toBeUndefined()
  expect(subjectProblem("fixup! feat: a")).toBeUndefined()
})

it("rejects a subject release-please can't read", () => {
  expect(subjectProblem("Fixed stuff")).toContain("not a Conventional Commit")
})

it("reads the subject past comments and blank lines", () => {
  expect(subjectOf("\n# comment\nfeat: a\n\nbody")).toBe("feat: a")
})
