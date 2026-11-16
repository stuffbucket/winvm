const TYPES = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
]
const CONVENTIONAL = new RegExp(
  `^(?:${TYPES.join("|")})(?:\\([\\w./-]+\\))?!?: \\S`,
)
const GIT_GENERATED = /^(?:Merge |Revert "|(?:fixup|squash|amend)! )/

export function subjectProblem(subject: string): string | undefined {
  if (CONVENTIONAL.test(subject) || GIT_GENERATED.test(subject))
    return undefined
  return `not a Conventional Commit: "${subject}"\n  expected <type>(<scope>)?: <summary>, type one of ${TYPES.join(", ")}`
}

export function subjectOf(message: string): string {
  return (
    message
      .split("\n")
      .find((line) => line.trim() !== "" && !line.startsWith("#"))
      ?.trim() ?? ""
  )
}

if (import.meta.main) {
  const arg = process.argv[2] ?? ""
  const subjects =
    arg === "--subjects"
      ? (await new Response(Bun.stdin.stream()).text())
          .split("\n")
          .filter((line) => line.trim() !== "")
      : [subjectOf(await Bun.file(arg).text())]
  const problems = subjects.flatMap((subject) => subjectProblem(subject) ?? [])
  for (const problem of problems) console.error(problem)
  process.exit(problems.length > 0 ? 1 : 0)
}
