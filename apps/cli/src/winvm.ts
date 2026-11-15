#!/usr/bin/env bun
/**
 * winvm — a scriptable Windows 11 ARM64 guest on plain QEMU + Hypervisor.framework.
 *
 *   winvm doctor                     check host prerequisites
 *   winvm build --iso <win11.iso>    build the golden base image (~20 min, once)
 *   winvm adopt <disk.qcow2>         turn an existing installed disk into a base
 *   winvm start [-i name]            boot an instance (creating it if absent)
 *   winvm exec  [-i name] -- <cmd>   run a command in the guest; --timeout S (900), 124 if hit
 *   winvm agent [-i name] install    the in-guest agent: fast exec/files/GUI (agent.ts)
 *   winvm put / get / launch         files in and out; a program on the guest's desktop
 *   winvm dir [-i name] [path]       a guest folder (default the Desktop); --json for the app
 *   winvm terminal [-i name]         a shell in the guest (pwsh, powershell, cmd), here
 *   winvm ui tree|find|click|wait|tray …   drive the GUI by UI Automation names; see ui.ts
 *   winvm snapshot [-i name] [tag]   capture the running guest, RAM and all
 *   winvm rewind   [-i name] [tag]   put it back — ~10-20 s running, no reboot
 *   winvm save / load / saves        whole-machine saves as files; see saves.ts
 *   winvm saves note <save>          a title, text and tags on a save; see notes.ts
 *   winvm share set PATH | clear | install   a Mac folder as a drive in Windows; see sharecmds.ts
 *   winvm golden create | reset      settled mapped-ram save for fast resets; see golden.ts
 *   winvm pause / resume / stow      freeze, unfreeze, save-and-quit
 *   winvm sleep / wake / lock        lock Windows and freeze it, wake it, lock it
 *   winvm settings [key=value]       the user's settings (XDG config dir)
 *   winvm reboot [-i name]           restart Windows, back when logged on again
 *   winvm clock [-i name]            guest-vs-host clock offset, and fix it
 *   winvm reset [-i name]            discard all changes, back to the base
 *   winvm ls                         images and instances, with disk usage
 *   winvm status [-i name]           what an instance is doing, in one screen
 *   winvm info [-i name]             its processors, memory, disk and network
 *   winvm open [-i name] [--web]     its screen: Screen Sharing, or the browser
 *   winvm screenshot | type | key | click | move | scroll   drive it with no window
 *   winvm webview enable|eval|click|wait|text   WebView2 windows over DevTools
 *   winvm ocr [--find T] / click --text T   read the screen with macOS Vision
 *   winvm cua serve | run "<task>"   Claude's computer-use tool against the guest; see cuacmds.ts
 *   winvm mcp [install|uninstall|status]   the guest as an MCP server for Claude Code and Claude Desktop; see mcpcmds.ts
 *   winvm toasts [--since T] [--find T]     notifications apps raised, from Windows' record
 *   winvm watch [-i name] [--stop]   idle watcher: autosave, stow, clock sync
 *   winvm config [-i name] [k=v ...] per-instance watcher settings
 *   winvm run job.yml / test dir/    CI jobs from a golden save; see runner.ts
 *   winvm timemachine [--yes]        keep the VM files out of Time Machine backups
 *
 * ## Self-contained and project-agnostic, on purpose
 *
 * THIS DIRECTORY IS THE WHOLE TOOL. Copy this directory anywhere — another
 * repository, or no repository at all — and it works. It reads no manifest, no
 * version file, and nothing else belonging to whatever happens to host it.
 * Everything project-specific is passed in: what to stage in the guest
 * (`--payload`), and what version to assert (`--expect` / `--expect-file`).
 *
 * An earlier version of this tool did not hold that line — it read
 * `../../.bun-version` and keyed its state directory on one project's name — and
 * the result was an uncaught `ENOENT` anywhere else plus two consumers silently
 * sharing a single 15 GB disk image.
 *
 * ## One base image, many thin instances
 *
 * A Windows install is ~15 GB, so a copy per consumer is not viable. The base is
 * built once and never written again; each instance is a qcow2 OVERLAY backed by
 * it, storing only its own deltas — megabytes for a boot, not gigabytes.
 *
 * Three properties fall out of that, which is why it is the design rather than
 * an optimisation:
 *
 *   - RESET is `rm overlay && qemu-img create`: instant, and exactly the base
 *     state, with no reinstall.
 *   - CONCURRENCY is free. Instances share one base, never touch each other, and
 *     each gets its own overlay, firmware vars, TPM state, sockets and VNC
 *     display.
 *   - DEBUGGING survives. An instance persists across stop/start, so a broken
 *     guest can be inspected and reset only when you are done with it.
 *
 * `--ephemeral` adds QEMU's `-snapshot`, so even the overlay is untouched and
 * the whole run is discarded on exit.
 *
 * ## Rewinding is cheaper than resetting
 *
 * `reset` returns to the base image, which still costs a boot afterwards. A
 * SNAPSHOT captures the running machine including RAM, and restoring one is not
 * a reboot: the guest resumes mid-instruction. Take one yourself once the guest
 * is where you want to keep returning to — `start` deliberately does not, because
 * snapshotting a guest that has not finished starting livelocks it.
 *
 * That is why the disk runs on virtio-blk rather than the NVMe it installs on:
 * QEMU's nvme device model is non-migratable and `savevm` refuses to touch it.
 * See qemu.ts and snapshot.ts.
 *
 * ## The guest boots to audit mode
 *
 * There is no out-of-box experience: the answer file sets
 * Microsoft-Windows-Deployment | Reseal | Mode = Audit, so every boot lands on a
 * desktop logged in as the built-in Administrator in about 35 seconds. OOBE was
 * not merely slow, it was undetectable — qemu-ga answers throughout it, so no
 * probe could tell a starting guest from a started one. See the docs.
 *
 * ## Layout
 *
 *   apps/cli/src/winvm.ts   this file — argument dispatch only
 *
 * Everything else is the @winvm/core package, in packages/core/src unless
 * noted (assets/, firmware/ and web/ sit beside src/):
 *
 *   commands.ts   the verbs
 *   paths.ts      state layout and instance metadata
 *   host.ts       prerequisites, shelling out, downloads
 *   qemu.ts       the QEMU command line and process lifecycle
 *   qga.ts        guest-agent client (the scriptable channel)
 *   agent.ts      the in-guest agent's client and install; agentfwd.ts its port forward
 *   guestagent.ts the in-guest agent itself (runs IN the guest); agentcmds.ts its verbs
 *   termcmds.ts   `terminal`: a guest shell over the agent's WebSocket (assets/conpty.cs)
 *   qmp.ts        QEMU monitor client (keystrokes, snapshots)
 *   snapshot.ts   capture and restore a running guest
 *   saves.ts      file saves: format, compatibility, save/load mechanics, screenshots
 *   notes.ts      a person's notes on a save, kept in the XDG data dir (xdg.ts)
 *   savecmds.ts   the save verbs, and the start/rewind hooks
 *   clock.ts      put the guest's clock on the host's
 *   watch.ts      the per-instance watcher process (idle.ts holds its decisions)
 *   config.ts     per-instance settings
 *   diagnose.ts   known failure signatures, read from a guest's own artifacts
 *   status.ts     `status`: gathering (QMP, guest agent, files) and formatting
 *   screen.ts     `open`, `display` and the input verbs
 *   runner.ts     `run` / `test`: jobs from golden saves (job.ts parses, guest.ts
 *                 is the channel, report.ts renders, runcmds.ts the verbs)
 *   input.ts      screenshots, keys and the pointer, over QMP
 *   vnc.ts        VNC ports, websocket, password (why there is one)
 *   display.ts    the display device: ramfb, or virtio-gpu at a chosen size
 *   guestdisplay.ts  Windows' side of the screen size
 *   monitor.ts    short-deadline QMP commands
 *   web.ts        `web`: the browser view's server; web/ holds the page and noVNC
 *   webview.ts    `webview`: WebView2 DevTools from the host (cdp.ts the client)
 *   ocr.ts        `ocr`, `click --text`: screendump + Vision (assets/ocr.swift)
 *   cua.ts        computer-use actions -> QMP (cuacmds.ts: `cua serve`, `cua run`)
 *   toasts.ts     `toasts`: the guest's notification database, read on the host
 *   media.ts      seed ISO and result volume
 *   instance.ts   create / reset / seal
 *   assets/       answer file, provisioning script, UEFI boot selector
 *
 * See docs/windows-vm-qemu.md for the reasoning behind the device choices.
 *
 * Exit code: the guest command's, so `winvm exec` is transparent in a `&&` chain.
 */
import { instanceName, parseArgs } from "@winvm/core/args"
import { bunVersionWarning, listInstances, pinnedBunVersion, recordCliEntry } from "@winvm/core/paths"
import { ManagementError, reconcileManagement, reconcileNote, shouldReconcileVerb } from "@winvm/core/lifecycle"
import { InstanceBusy, operationFor, withOperation } from "@winvm/core/operation"
import * as agentcmds from "@winvm/core/agentcmds"
import * as termcmds from "@winvm/core/termcmds"
import * as uicmds from "@winvm/core/uicmds"
import * as commands from "@winvm/core/commands"
import * as cuacmds from "@winvm/core/cuacmds"
import * as finder from "@winvm/core/finder"
import * as mcpcmds from "@winvm/core/mcpcmds"
import * as goldens from "@winvm/core/golden"
import * as machineinfo from "@winvm/core/machineinfo"
import * as ocr from "@winvm/core/ocr"
import * as runcmds from "@winvm/core/runcmds"
import * as savecmds from "@winvm/core/savecmds"
import * as sharecmds from "@winvm/core/sharecmds"
import * as screen from "@winvm/core/screen"
import * as service from "@winvm/core/service"
import * as settings from "@winvm/core/settings"
import * as status from "@winvm/core/status"
import * as web from "@winvm/core/web"
import * as webview from "@winvm/core/webview"
import * as timemachine from "@winvm/core/timemachine"
import * as toasts from "@winvm/core/toasts"

// Work that outlives this command (the idle watcher, the web server, job host
// steps) is spawned through this same entry point; core reads it as cliEntry().
// Nothing in core reads it while being imported, so recording it here, after
// the hoisted imports, still comes before anything is spawned.
recordCliEntry(import.meta.path)
const bunWarning = bunVersionWarning(Bun.version, pinnedBunVersion())
if (bunWarning !== null) console.warn(bunWarning)

const [, , sub, ...rawArgs] = process.argv
const args = parseArgs(rawArgs)

// Machine-impacting commands publish what they are doing for the app and for
// `status` (operation.ts). The lease callback only returns the exit code; the
// process exits after it has cleared, never inside it.
const operation = operationFor(sub, args)
const leased = async (run: () => number | Promise<number>): Promise<number> => {
  if (operation === null) return await run()
  try {
    return await withOperation(instanceName(args), operation, run)
  } catch (error) {
    if (!(error instanceof InstanceBusy)) throw error
    console.error(`::error::${error.message}`)
    return 1
  }
}
// The guest's drives in Finder, left mounted by a QEMU that died: unmounted
// before anything else runs (finder.ts). Free unless the instance shares its
// drives and is not running. Unmounting from a dead server takes a minute, so
// a command that only looks leaves it to a detached `winvm files _clean`.
const NO_SWEEP = ["help", "--help", "ls", "list", "doctor", "timemachine", "tm", "watch", "serve"]
const LOOK_ONLY = ["status", "info", "saves", "snapshots", "config", "screenshot", "mcp", "cua-serve"]
if (sub !== undefined && !NO_SWEEP.includes(sub) && !(sub === "files" && args.positional[0]?.startsWith("_") === true)) {
  if (LOOK_ONLY.includes(sub) || (sub === "files" && args.positional[0] === "status")) finder.cleanStaleLater(instanceName(args))
  else finder.cleanStale(instanceName(args))
}

// The instance's control service and watcher, brought up to this build if an
// update left them running older code (lifecycle.ts). Never QEMU, never inside
// the service or watcher themselves (WINVM_NO_RECONCILE), never for verbs that
// tear the instance down. `status` with no instance named looks at them all:
// it is how the app starts, so one instance that cannot be repaired is
// reported and the rest are still repaired and listed. A command for one
// instance stops at its failure instead.
if (sub !== undefined && shouldReconcileVerb(sub) && !(sub === "files" && args.positional[0]?.startsWith("_") === true)) {
  const named = args.flags.get("instance") ?? process.env["WINVM_INSTANCE"]
  const every = sub === "status" && named === undefined
  const reconcileOne = async (name: string): Promise<void> => {
    try {
      // Never waits out a watcher's autosave or stow: this runs before every
      // command, and the app's status call has a deadline. It defers instead.
      const note = reconcileNote(name, await reconcileManagement(name, undefined, { waitForBusyWatcher: false }))
      if (note !== null) console.error(note)
    } catch (error) {
      // Anything else from one instance is reported like a failed repair when
      // listing them all: the list is what the app needs to show anything.
      if (!(error instanceof ManagementError) && !every) throw error
      console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
      if (!every) process.exit(1)
    }
  }
  // Each instance has its own lifecycle and save locks. Repair them together so
  // several independent 10–15 second replacements still fit the app's status deadline.
  if (every) await Promise.all(listInstances().map(reconcileOne))
  else await reconcileOne(instanceName(args))
}

let exitCode: number
switch (sub) {
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
    exitCode = await leased(() => commands.start(args))
    break
  case "stop":
    exitCode = await leased(() => commands.stop(args))
    break
  case "reboot":
    exitCode = await leased(() => commands.reboot(args))
    break
  case "kill":
    exitCode = await leased(() => commands.kill(args))
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
    exitCode = await leased(() => commands.rewind(args))
    break
  case "snapshots":
    exitCode = await commands.snapshots(args)
    break
  case "save":
    exitCode = await leased(() => savecmds.save(args))
    break
  case "load":
    exitCode = await leased(() => savecmds.load(args))
    break
  case "share":
    exitCode = await leased(() => sharecmds.shareCmd(args))
    break
  case "golden":
    exitCode = await leased(() => goldens.golden(args))
    break
  case "saves":
    exitCode = savecmds.list(args)
    break
  case "pause":
    exitCode = await leased(() => savecmds.pause(args))
    break
  case "resume":
  case "wake":
    exitCode = await leased(() => savecmds.resume(args))
    break
  case "sleep":
    exitCode = await leased(() => savecmds.sleep(args))
    break
  case "lock":
    exitCode = await leased(() => savecmds.lock(args))
    break
  case "settings":
    exitCode = settings.settingsCmd(args)
    break
  case "stow":
    exitCode = await leased(() => savecmds.stow(args))
    break
  case "clock":
    exitCode = await savecmds.clock(args)
    break
  case "watch":
    exitCode = await commands.watchCmd(args)
    break
  case "serve": {
    const handle = await service.runService(instanceName(args))
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void handle.stop())
    await handle.done
    exitCode = 0
    break
  }
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
    exitCode = await status.run({ instance: args.flags.get("instance") ?? process.env["WINVM_INSTANCE"] ?? null, json: args.flags.has("json") })
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
