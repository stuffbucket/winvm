import { matrix, passes, THEME_NAMES } from "../src/contrast"

const RATIO_WIDTH = 5
const checks = matrix()
const failing = checks.filter((c) => !passes(c))

for (const theme of THEME_NAMES) {
  console.log(`\n${theme.toUpperCase()}`)
  for (const c of checks.filter((x) => x.theme === theme)) {
    const mark = passes(c) ? "  " : "✗ "
    const ratio = c.ratio.toFixed(2).padStart(RATIO_WIDTH)
    console.log(
      `${mark}${ratio}  --${c.fg} on --${c.bg}  [${c.role} ≥${String(c.min)}] ${c.why}`,
    )
  }
}
console.log(
  `\ncontrast: ${String(failing.length)} of ${String(checks.length)} pairings below their minimum`,
)
if (failing.length > 0) process.exit(1)
