import * as commands from "./commands"
import * as goldens from "./golden"
import type { OpHandler, OpHandlers } from "./ops"
import * as savecmds from "./savecmds"

export const STOW_HANDLER: OpHandler = {
  run: async (args) => await savecmds.stow(args),
  cancel: "cooperative",
  hostEnd: "finish",
}

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
  start: { run: commands.start, cancel: "before-request" },
  stop: {
    run: commands.stop,
    cancel: "cooperative",
    hostEnd: "finish-after-mark",
  },
  stow: STOW_HANDLER,
  save: { run: savecmds.save, cancel: "cooperative", hostEnd: "finish" },
  load: { run: savecmds.load, cancel: "before-request" },
  rewind: { run: commands.rewind, cancel: "before-request" },
  "golden-reset": { run: goldens.golden, cancel: "before-request" },
}
