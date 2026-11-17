import * as commands from "./commands"
import type { OpHandlers } from "./ops"
import * as savecmds from "./savecmds"

export const SERVICE_HANDLERS: OpHandlers = {
  pause: { run: savecmds.pause, cancel: "never" },
  resume: { run: savecmds.resume, cancel: "never" },
  wake: { run: savecmds.resume, cancel: "never" },
  sleep: { run: savecmds.sleep, cancel: "never" },
  lock: { run: savecmds.lock, cancel: "never" },
  reboot: { run: commands.reboot, cancel: "before-request" },
  kill: {
    run: async (args) => await commands.kill(args, { inService: true }),
    cancel: "never",
  },
}
