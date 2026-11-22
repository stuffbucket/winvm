import { hostChecks, printChecks } from "@winvm/core/host"
import { ensureRuntime } from "@winvm/core/runtime"

if ((process.env.WINVM_RUNTIME ?? "") === "") {
  try {
    const rt = ensureRuntime()
    console.log(`runtime ${rt.manifest?.version ?? "?"} in ${rt.dir}`)
  } catch (error) {
    console.error(
      `could not fetch winvm's runtime: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
const missing = printChecks(hostChecks("required"))
console.log(
  missing === 0
    ? "host is ready for winvm"
    : `${String(missing)} host prerequisite(s) missing`,
)
process.exit(missing === 0 ? 0 : 1)
