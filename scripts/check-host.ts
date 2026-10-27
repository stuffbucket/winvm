import { hostChecks, printChecks } from "../packages/core/src/host"
import { ensureRuntime } from "../packages/core/src/runtime"

if ((process.env["WINVM_RUNTIME"] ?? "") === "") {
  try {
    const rt = await ensureRuntime()
    console.log(`runtime ${rt.manifest?.version ?? "?"} in ${rt.dir}`)
  } catch (error) {
    console.error(`could not fetch winvm's runtime: ${error instanceof Error ? error.message : String(error)}`)
  }
}
const missing = printChecks(hostChecks())
console.log(missing === 0 ? "host is ready for winvm" : `${String(missing)} host prerequisite(s) missing`)
process.exit(missing === 0 ? 0 : 1)
