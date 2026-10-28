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
 *   winvm golden create | reset      settled mapped-ram save for fast resets; see golden.ts
 *   winvm pause / resume / stow      freeze, unfreeze, save-and-quit
 *   winvm sleep / wake / lock        lock Windows and freeze it, wake it, lock it
 *   winvm settings [key=value]       the user's settings (XDG config dir)
 *   winvm reboot [-i name]           restart Windows, back when logged on again
 *   winvm clock [-i name]            guest-vs-host clock offset, and fix it
 *   winvm reset [-i name]            discard all changes, back to the base
 *   winvm ls                         images and instances, with disk usage
 *   winvm status [-i name]           what an instance is doing, in one screen
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
 *   saves.ts      file saves: format, compatibility, save/load mechanics
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
import { bunVersionWarning, pinnedBunVersion, recordCliEntry } from "@winvm/core/paths"
import * as agentcmds from "@winvm/core/agentcmds"
import * as termcmds from "@winvm/core/termcmds"
import * as uicmds from "@winvm/core/uicmds"
import * as commands from "@winvm/core/commands"
import * as cuacmds from "@winvm/core/cuacmds"
import * as mcpcmds from "@winvm/core/mcpcmds"
import * as goldens from "@winvm/core/golden"
import * as ocr from "@winvm/core/ocr"
import * as runcmds from "@winvm/core/runcmds"
import * as savecmds from "@winvm/core/savecmds"
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

switch (sub) {
  case "doctor":
    process.exit(commands.doctor(args.flags.has("json")))
  // eslint-disable-next-line no-fallthrough
  case "timemachine":
  case "tm":
    process.exit(timemachine.run(process.argv.includes("--yes")))

  case "ls":
  case "list":
    process.exit(commands.ls(args.flags.has("json")))
  // eslint-disable-next-line no-fallthrough
  case "create":
    process.exit(commands.create(args))
  // eslint-disable-next-line no-fallthrough
  case "adopt":
    process.exit(commands.adopt(args))
  // eslint-disable-next-line no-fallthrough
  case "build":
    process.exit(await commands.build(args))
  // eslint-disable-next-line no-fallthrough
  case "start":
    process.exit(await commands.start(args))
  // eslint-disable-next-line no-fallthrough
  case "stop":
    process.exit(await commands.stop(args))
  // eslint-disable-next-line no-fallthrough
  case "reboot":
    process.exit(await commands.reboot(args))
  // eslint-disable-next-line no-fallthrough
  case "kill":
    process.exit(commands.kill(args))
  // eslint-disable-next-line no-fallthrough
  case "reset":
    process.exit(commands.reset(args))
  // eslint-disable-next-line no-fallthrough
  case "destroy":
    process.exit(commands.destroy(args))
  // eslint-disable-next-line no-fallthrough
  case "exec":
    process.exit(await commands.exec(args))
  // eslint-disable-next-line no-fallthrough
  case "agent":
    process.exit(await agentcmds.agentCmd(args))
  // eslint-disable-next-line no-fallthrough
  case "put":
    process.exit(await agentcmds.put(args))
  // eslint-disable-next-line no-fallthrough
  case "get":
    process.exit(await agentcmds.get(args))
  // eslint-disable-next-line no-fallthrough
  case "dir":
    process.exit(await agentcmds.dir(args))
  // eslint-disable-next-line no-fallthrough
  case "mkdir":
    process.exit(await agentcmds.mkdir(args))
  // eslint-disable-next-line no-fallthrough
  case "mv":
    process.exit(await agentcmds.mv(args))
  // eslint-disable-next-line no-fallthrough
  case "cp":
    process.exit(await agentcmds.cp(args))
  // eslint-disable-next-line no-fallthrough
  case "rm":
    process.exit(await agentcmds.rm(args))
  // eslint-disable-next-line no-fallthrough
  case "launch":
    process.exit(await agentcmds.launch(args))
  // eslint-disable-next-line no-fallthrough
  case "ui":
    process.exit(await uicmds.uiCmd(args))
  // eslint-disable-next-line no-fallthrough
  case "terminal":
    process.exit(await termcmds.terminal(args))
  // eslint-disable-next-line no-fallthrough
  case "smoke":
    process.exit(await commands.smoke(args))
  // eslint-disable-next-line no-fallthrough
  case "snapshot":
    process.exit(await commands.snap(args))
  // eslint-disable-next-line no-fallthrough
  case "rewind":
    process.exit(await commands.rewind(args))
  // eslint-disable-next-line no-fallthrough
  case "snapshots":
    process.exit(await commands.snapshots(args))
  // eslint-disable-next-line no-fallthrough
  case "save":
    process.exit(await savecmds.save(args))
  // eslint-disable-next-line no-fallthrough
  case "load":
    process.exit(await savecmds.load(args))
  // eslint-disable-next-line no-fallthrough
  case "golden":
    process.exit(await goldens.golden(args))
  // eslint-disable-next-line no-fallthrough
  case "saves":
    process.exit(savecmds.list(args))
  // eslint-disable-next-line no-fallthrough
  case "pause":
    process.exit(await savecmds.pause(args))
  // eslint-disable-next-line no-fallthrough
  case "resume":
  case "wake":
    process.exit(await savecmds.resume(args))
  // eslint-disable-next-line no-fallthrough
  case "sleep":
    process.exit(await savecmds.sleep(args))
  // eslint-disable-next-line no-fallthrough
  case "lock":
    process.exit(await savecmds.lock(args))
  // eslint-disable-next-line no-fallthrough
  case "settings":
    process.exit(settings.settingsCmd(args))
  // eslint-disable-next-line no-fallthrough
  case "stow":
    process.exit(await savecmds.stow(args))
  // eslint-disable-next-line no-fallthrough
  case "clock":
    process.exit(await savecmds.clock(args))
  case "watch":
    process.exit(await commands.watchCmd(args))
  // eslint-disable-next-line no-fallthrough
  case "serve": {
    const handle = await service.runService(instanceName(args))
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void handle.stop())
    await handle.done
    process.exit(0)
  }
  // eslint-disable-next-line no-fallthrough
  case "run":
    process.exit(await runcmds.run(args))
  // eslint-disable-next-line no-fallthrough
  case "test":
    process.exit(await runcmds.test(args))
  // eslint-disable-next-line no-fallthrough
  case "config":
    process.exit(commands.configCmd(args))
  // eslint-disable-next-line no-fallthrough
  case "diagnose":
    process.exit(commands.diagnoseCmd(args))
  // eslint-disable-next-line no-fallthrough
  case "setup":
    process.exit(await commands.setup(args))
  // eslint-disable-next-line no-fallthrough
  case "rmi":
    process.exit(commands.rmi(args))
  // eslint-disable-next-line no-fallthrough
  case "prune":
    process.exit(commands.prune(args))
  // eslint-disable-next-line no-fallthrough
  case "status":
    process.exit(await status.run({ instance: args.flags.get("instance") ?? process.env["WINVM_INSTANCE"] ?? null, json: args.flags.has("json") }))
  // eslint-disable-next-line no-fallthrough
  case "open":
    process.exit(await screen.open(args))
  // eslint-disable-next-line no-fallthrough
  case "web":
    process.exit(await web.run(args))
  // eslint-disable-next-line no-fallthrough
  case "screenshot":
    process.exit(await screen.screenshot(args))
  // eslint-disable-next-line no-fallthrough
  case "type":
    process.exit(await screen.type(args))
  // eslint-disable-next-line no-fallthrough
  case "key":
    process.exit(await screen.key(args))
  // eslint-disable-next-line no-fallthrough
  case "click":
    process.exit(await screen.click(args))
  // eslint-disable-next-line no-fallthrough
  case "move":
    process.exit(await screen.move(args))
  // eslint-disable-next-line no-fallthrough
  case "scroll":
    process.exit(await screen.scroll(args))
  // eslint-disable-next-line no-fallthrough
  case "display":
    process.exit(await screen.display(args))
  // eslint-disable-next-line no-fallthrough
  case "webview":
    process.exit(await webview.webview(args))
  // eslint-disable-next-line no-fallthrough
  case "ocr":
    process.exit(await ocr.ocr(args))
  // eslint-disable-next-line no-fallthrough
  case "toasts":
    process.exit(await toasts.toasts(args))
  // eslint-disable-next-line no-fallthrough
  case "cua":
    process.exit(await cuacmds.cua(args))
  // eslint-disable-next-line no-fallthrough
  case "cua-serve":
    process.exit(await cuacmds.cua(args, "serve"))
  // eslint-disable-next-line no-fallthrough
  case "mcp":
    process.exit(await mcpcmds.mcpCmd(args))
  // eslint-disable-next-line no-fallthrough
  case "help":
  case "--help":
    console.log(commands.USAGE)
    process.exit(0)
  // eslint-disable-next-line no-fallthrough
  default:
    console.error(commands.USAGE)
    process.exit(2)
}
