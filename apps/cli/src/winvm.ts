#!/usr/bin/env bun
import * as agentcmds from "@winvm/core/agentcmds"
import { instanceName, parseArgs } from "@winvm/core/args"
import * as commands from "@winvm/core/commands"
import * as cuacmds from "@winvm/core/cuacmds"
import * as finder from "@winvm/core/finder"
import * as follow from "@winvm/core/follow"
import * as goldens from "@winvm/core/golden"
import {
  ManagementError,
  reconcileManagement,
  reconcileNote,
  shouldReconcileVerb,
} from "@winvm/core/lifecycle"
import * as machineinfo from "@winvm/core/machineinfo"
import * as mcpcmds from "@winvm/core/mcpcmds"
import * as ocr from "@winvm/core/ocr"
import * as opclient from "@winvm/core/opclient"
import {
  automaticFrom,
  InstanceBusy,
  operationFor,
  withOperation,
} from "@winvm/core/operation"
import { isServiceOp } from "@winvm/core/ops"
import {
  bunVersionWarning,
  pinnedBunVersion,
  recordCliEntry,
} from "@winvm/core/paths"
import * as reconcile from "@winvm/core/reconcile"
import * as runcmds from "@winvm/core/runcmds"
import * as savecmds from "@winvm/core/savecmds"
import * as screen from "@winvm/core/screen"
import * as service from "@winvm/core/service"
import * as settings from "@winvm/core/settings"
import * as sharecmds from "@winvm/core/sharecmds"
import * as status from "@winvm/core/status"
import * as termcmds from "@winvm/core/termcmds"
import * as timemachine from "@winvm/core/timemachine"
import * as toasts from "@winvm/core/toasts"
import * as uicmds from "@winvm/core/uicmds"
import * as web from "@winvm/core/web"
import * as webview from "@winvm/core/webview"

recordCliEntry(import.meta.path)
const bunWarning = bunVersionWarning(Bun.version, pinnedBunVersion())
if (bunWarning !== null) console.warn(bunWarning)

const [, , sub, ...rawArgs] = process.argv
const args = parseArgs(rawArgs)

const operation = operationFor(sub, args)
const serviceOp = isServiceOp(operation) ? operation : null
const leased = async (run: () => number | Promise<number>): Promise<number> => {
  if (operation === null) return await run()
  try {
    return await withOperation(instanceName(args), operation, run, {
      interruptible: true,
      automatic: automaticFrom(args),
      ...(serviceOp !== null && args.flags.has("wait")
        ? { queue: true, waitMs: Number.POSITIVE_INFINITY }
        : {}),
    })
  } catch (error) {
    if (!(error instanceof InstanceBusy)) throw error
    console.error(`::error::${error.message}`)
    return 1
  }
}
const viaService = async (here: () => Promise<number>): Promise<number> =>
  serviceOp === null
    ? await here()
    : await opclient.runOp({ op: serviceOp, args, argv: rawArgs }, here)
const NO_SWEEP = [
  "help",
  "--help",
  "ls",
  "list",
  "doctor",
  "timemachine",
  "tm",
  "watch",
  "serve",
  "events",
  "status",
  "reconcile",
  "cancel",
]
const LOOK_ONLY = [
  "info",
  "saves",
  "snapshots",
  "config",
  "screenshot",
  "mcp",
  "cua-serve",
]
if (
  sub !== undefined &&
  !NO_SWEEP.includes(sub) &&
  !(sub === "files" && args.positional[0]?.startsWith("_") === true)
) {
  if (
    LOOK_ONLY.includes(sub) ||
    (sub === "files" && args.positional[0] === "status")
  )
    finder.cleanStaleLater(instanceName(args))
  else finder.cleanStale(instanceName(args))
}

if (
  sub !== undefined &&
  shouldReconcileVerb(sub) &&
  !(sub === "files" && args.positional[0]?.startsWith("_") === true)
) {
  const name = instanceName(args)
  try {
    const note = reconcileNote(
      name,
      await reconcileManagement(name, undefined, {
        waitForBusyWatcher: false,
      }),
    )
    if (note !== null) console.error(note)
  } catch (error) {
    if (!(error instanceof ManagementError)) throw error
    console.error(`::error::${error.message}`)
    process.exit(1)
  }
}

let exitCode: number
switch (sub ?? "") {
  case "doctor":
    exitCode = commands.doctor(args.flags.has("json"))
    break
  case "timemachine":
  case "tm":
    exitCode = timemachine.run(process.argv.includes("--yes"))
    break

  case "ls":
  case "list":
    exitCode = commands.ls(args.flags.has("json"))
    break
  case "create":
    exitCode = commands.create(args)
    break
  case "adopt":
    exitCode = commands.adopt(args)
    break
  case "build":
    exitCode = await commands.build(args)
    break
  case "start":
    exitCode = await viaService(() => leased(() => commands.start(args)))
    break
  case "stop":
    exitCode = await viaService(() => leased(() => commands.stop(args)))
    break
  case "reboot":
    exitCode = await viaService(() => leased(() => commands.reboot(args)))
    break
  case "kill":
    exitCode = await viaService(() => leased(() => commands.kill(args)))
    break
  case "cancel":
    exitCode = await opclient.cancelCmd(args)
    break
  case "reset":
    exitCode = await leased(() => commands.reset(args))
    break
  case "destroy":
    exitCode = await leased(() => commands.destroy(args))
    break
  case "exec":
    exitCode = await commands.exec(args)
    break
  case "agent":
    exitCode = await agentcmds.agentCmd(args)
    break
  case "put":
    exitCode = await agentcmds.put(args)
    break
  case "get":
    exitCode = await agentcmds.get(args)
    break
  case "dir":
    exitCode = await agentcmds.dir(args)
    break
  case "mkdir":
    exitCode = await agentcmds.mkdir(args)
    break
  case "mv":
    exitCode = await agentcmds.mv(args)
    break
  case "cp":
    exitCode = await agentcmds.cp(args)
    break
  case "rm":
    exitCode = await agentcmds.rm(args)
    break
  case "files":
    exitCode = await finder.filesCmd(args)
    break
  case "launch":
    exitCode = await agentcmds.launch(args)
    break
  case "ui":
    exitCode = await uicmds.uiCmd(args)
    break
  case "terminal":
    exitCode = await termcmds.terminal(args)
    break
  case "smoke":
    exitCode = await commands.smoke(args)
    break
  case "snapshot":
    exitCode = await leased(() => commands.snap(args))
    break
  case "rewind":
    exitCode = await viaService(() => leased(() => commands.rewind(args)))
    break
  case "snapshots":
    exitCode = await commands.snapshots(args)
    break
  case "save":
    exitCode = await viaService(() => leased(() => savecmds.save(args)))
    break
  case "load":
    exitCode = await viaService(() => leased(() => savecmds.load(args)))
    break
  case "share":
    exitCode = await leased(() => sharecmds.shareCmd(args))
    break
  case "golden":
    exitCode = await viaService(() => leased(() => goldens.golden(args)))
    break
  case "saves":
    exitCode = savecmds.list(args)
    break
  case "pause":
    exitCode = await viaService(() => leased(() => savecmds.pause(args)))
    break
  case "resume":
  case "wake":
    exitCode = await viaService(() => leased(() => savecmds.resume(args)))
    break
  case "sleep":
    exitCode = await viaService(() => leased(() => savecmds.sleep(args)))
    break
  case "lock":
    exitCode = await viaService(() => leased(() => savecmds.lock(args)))
    break
  case "settings":
    exitCode = settings.settingsCmd(args)
    break
  case "stow":
    exitCode = await viaService(() => savecmds.stow(args, leased))
    break
  case "clock":
    exitCode = await savecmds.clock(args)
    break
  case "watch":
    exitCode = await commands.watchCmd(args)
    break
  case "serve": {
    const name = instanceName(args)
    const handle = await service.runService(name)
    service.serviceSignals(name, () => void handle.stop())
    await handle.done
    exitCode = 0
    break
  }
  case "reconcile":
    exitCode = await reconcile.reconcileCmd(args)
    break
  case "events":
    exitCode = await follow.eventsCmd(args)
    break
  case "run":
    exitCode = await runcmds.run(args)
    break
  case "test":
    exitCode = await runcmds.test(args)
    break
  case "config":
    exitCode = commands.configCmd(args)
    break
  case "diagnose":
    exitCode = commands.diagnoseCmd(args)
    break
  case "setup":
    exitCode = await leased(() => commands.setup(args))
    break
  case "rmi":
    exitCode = commands.rmi(args)
    break
  case "prune":
    exitCode = commands.prune(args)
    break
  case "status":
    exitCode = await status.run({
      instance:
        args.flags.get("instance") ?? process.env.WINVM_INSTANCE ?? null,
      json: args.flags.has("json"),
    })
    break
  case "info":
    exitCode = await machineinfo.infoCmd(args)
    break
  case "open":
    exitCode = await screen.open(args)
    break
  case "web":
    exitCode = await web.run(args)
    break
  case "screenshot":
    exitCode = await screen.screenshot(args)
    break
  case "type":
    exitCode = await screen.type(args)
    break
  case "key":
    exitCode = await screen.key(args)
    break
  case "click":
    exitCode = await screen.click(args)
    break
  case "move":
    exitCode = await screen.move(args)
    break
  case "scroll":
    exitCode = await screen.scroll(args)
    break
  case "display":
    exitCode = await screen.display(args)
    break
  case "webview":
    exitCode = await webview.webview(args)
    break
  case "ocr":
    exitCode = await ocr.ocr(args)
    break
  case "toasts":
    exitCode = await toasts.toasts(args)
    break
  case "cua":
    exitCode = await cuacmds.cua(args)
    break
  case "cua-serve":
    exitCode = await cuacmds.cua(args, "serve")
    break
  case "mcp":
    exitCode = await mcpcmds.mcpCmd(args)
    break
  case "help":
  case "--help":
    console.log(commands.USAGE)
    exitCode = 0
    break
  default:
    console.error(commands.USAGE)
    exitCode = 2
    break
}
process.exit(exitCode)
