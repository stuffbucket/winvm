import { hostChecks, printChecks } from "../packages/core/src/host"

const missing = printChecks(hostChecks())
console.log(missing === 0 ? "host is ready for winvm" : `${String(missing)} host prerequisite(s) missing or too old`)
process.exit(missing === 0 ? 0 : 1)
