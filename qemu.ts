/**
 * The QEMU command line, and the process lifecycle around it.
 *
 * Every device below is a decision with a reason; most were derived from UTM's
 * source, which is the best available record of what actually works for a
 * Windows ARM64 guest on Apple Silicon. Changing one of these is how a guest
 * stops booting, so the reasons are recorded inline rather than in a commit
 * message nobody will find.
 */
import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync } from "node:fs"

import { restoreForward } from "./agentfwd"
import { requireFirmware } from "./host"
import type { InstanceMeta, Paths } from "./paths"
import { media } from "./paths"
import { RAMFB, displayArgs, readDisplay } from "./display"
import * as qga from "./qga"
import * as qmp from "./qmp"
import { applyPassword, ensureFreeDisplay, vncArg } from "./vnc"

export interface LaunchOptions {
  /** Attach the Windows ISO, guest tools and seed. Only a base build needs them. */
  readonly installMedia: boolean
  /** QEMU `-snapshot`: even the overlay is left untouched and the run is discarded. */
  readonly ephemeral: boolean
  /**
   * Boot the disk on virtio-blk instead of NVMe. Only images whose guest has
   * viostor as a boot-start driver can do this — see ImageMeta.virtioBoot.
   */
  readonly virtioBoot: boolean
  /** Resume straight into a saved VM state instead of booting. */
  readonly loadvm?: string
  /** QEMU `-incoming <uri>`: start paused, fed a migration stream (a file save). See saves.ts. */
  readonly incoming?: string
}

export function qemuArgs(name: string, p: Paths, meta: InstanceMeta, o: LaunchOptions): readonly string[] {
  // BOOT ORDER IS LOAD-BEARING DURING A BUILD. The install CD must come first;
  // give the (empty) disk index 0 and EDK2 tries it, fails, and drops to a UEFI
  // shell *before* USB enumeration has produced any filesystem — the mapping
  // table shows the NVMe block device and nothing else, so startup.nsh is not
  // even found, let alone run. Once installed, the disk is the boot device and
  // the CDs are gone.
  const diskBootIndex = o.installMedia ? 1 : 0
  const a: string[] = [
    "-name", `winvm-${name}`,
    "-machine", "virt,accel=hvf",
    // `host` under HVF is what UTM uses for this guest. `max` falls back to TCG
    // for features HVF cannot provide, and boots far slower.
    "-cpu", "host",
    "-smp", "4",
    "-m", "4096",
    "-drive", `if=pflash,format=raw,readonly=on,file=${requireFirmware().code}`,
    // QCOW2, not the raw vars image. A writable raw device blocks `savevm` for
    // the entire machine — see Paths.vars.
    "-drive", `if=pflash,format=qcow2,file=${p.vars}`,
    // qemu-xhci, NOT nec-usb-xhci. QEMU's own documentation recommends XHCI for
    // any guest since ~2010 and spells the device `qemu-xhci`
    // <https://qemu-project.gitlab.io/qemu/system/devices/usb.html>; the NEC
    // model is the legacy one and carries an open upstream bug, "usb3:
    // nec-usb-xhci broken", reported as unwell since QEMU 5.2 and still open
    // against 10.x <https://gitlab.com/qemu-project/qemu/-/issues/3241>.
    //
    // This is not cosmetic. On nec-usb-xhci the guest hung on its SECOND boot,
    // spinning a full core inside EDK2's USB stack with the firmware console
    // stopped dead on `UsbBootExecCmd: Success to Exec 0x0 Cmd (Result = 1)` and
    // never reaching a boot target. It reproduced on a build and on a plain
    // instance, and it was the real source of what looked like random
    // flakiness elsewhere.
    "-device", "qemu-xhci,id=usb-bus",
    // THE BOOT DISK CHANGES BUS BETWEEN INSTALLING AND RUNNING, and both halves
    // are load-bearing.
    //
    // NVMe while installing: Windows 11 ARM64 has an in-box NVMe driver
    // (stornvme.sys), so Setup sees the disk with nothing injected. WinPE has no
    // virtio-blk driver at all, so installing onto virtio would mean injecting
    // viostor at windowsPE, and a <DriverPaths> entry names a drive letter that
    // WinPE assigns by enumeration order. (It is also why a virtio disk attached
    // during a build cannot disturb the answer file's DiskID 0: WinPE cannot see
    // it.)
    //
    // virtio-blk while running: the nvme device model has NO migration support
    // — `savevm` fails with "Device '...nvme' is non-migratable" — so live
    // snapshots are impossible on NVMe. The build primes viostor as a boot-start
    // driver (see Paths.prime) precisely so the finished image can run here.
    "-drive", `if=none,media=disk,id=hd0,file=${p.overlay}`,
    ...(o.virtioBoot
      ? ["-device", `virtio-blk-pci,drive=hd0,bootindex=${String(diskBootIndex)}`]
      : ["-device", `nvme,drive=hd0,serial=winvm,bootindex=${String(diskBootIndex)}`]),
    "-device", "usb-kbd,bus=usb-bus.0",
    "-device", "usb-tablet,bus=usb-bus.0",
    // Windows 11 ARM64 has no in-box virtio-net driver; NetKVM arrives with the
    // guest tools, after which this gives the guest real outbound internet.
    "-netdev", "user,id=net0",
    "-device", "virtio-net-pci,netdev=net0",
    // The command channel. See qga.ts, and qga.waitFor on why nothing should
    // connect to it before the guest has opened the port.
    "-device", "virtio-serial",
    "-chardev", `socket,path=${p.qga},server=on,wait=off,id=${qga.CHARDEV}`,
    "-device", `virtserialport,chardev=${qga.CHARDEV},name=org.qemu.guest_agent.0`,
    "-chardev", `socket,id=chrtpm,path=${p.tpmSock}`,
    "-tpmdev", "emulator,id=tpm0,chardev=chrtpm",
    // tpm-tis-device, not UTM's tpm-crb-device: Homebrew's QEMU builds only the
    // TIS model for aarch64. Verified equivalent here — with swtpm attached the
    // firmware enumerates all four PCR banks either way.
    // ppi=off: the Physical Presence Interface adds a small RAM region that
    // HVF refuses to map (QEMU 11.1 on macOS 26: "HV_BAD_ARGUMENT" at
    // hvf-all.c:123, and qemu exits). Windows doesn't need PPI.
    "-device", "tpm-tis-device,tpmdev=tpm0,ppi=off",
    // UTC, because the GUEST's time zone is UTC: the answer file pins
    // <TimeZone>UTC</TimeZone>, and Windows reads the RTC as local time
    // (RealTimeIsUniversal unset). `base=localtime` handed it the HOST's wall
    // time, so on a Pacific host every cold boot came up seven hours slow
    // (measured: -7h 0m 1s). clock=host (the default) keeps the PL031 tracking
    // real time across pauses, but Windows only reads it at boot — restored
    // guests are put right by clock.ts instead.
    "-rtc", "base=utc,clock=host",
    // A UEFI-GOP framebuffer, so there is a picture before any driver loads.
    // Not virtio-gpu by default, which needs viogpudo — UTM's own docs report
    // that driver black-screening recent Windows 11. An instance can opt in to
    // it for a larger screen (`winvm display`); a build never does. See display.ts.
    ...displayArgs(o.installMedia ? RAMFB : readDisplay(p)),
    "-display", "none",
    // Loopback only, with a websocket listener for the browser view and a
    // password, which macOS Screen Sharing needs and the websocket must have.
    // See vnc.ts.
    "-vnc", vncArg(meta.vnc),
    "-qmp", `unix:${p.qmp},server=on,wait=off`,
    "-serial", `file:${p.serial}`,
    "-pidfile", p.pid,
  ]
  if (o.ephemeral) a.push("-snapshot")
  if (o.loadvm !== undefined) a.push("-loadvm", o.loadvm)
  if (o.incoming !== undefined) a.push("-incoming", o.incoming)
  if (o.installMedia) {
    a.push(
      // USB STORAGE IS ONLY ATTACHED WHILE INSTALLING, and the device lines
      // follow Linaro's published reference for a Windows ARM64 guest on
      // qemu-system-aarch64 — `usb-storage` + `media=cdrom` on a qemu-xhci bus,
      // with NO `removable=` flag
      // <https://linaro.atlassian.net/wiki/spaces/WOAR/pages/28914909194/windows-arm64+VM+using+qemu-system>.
      //
      // A RUNNING INSTANCE NOW HAS NO USB STORAGE AT ALL. The result volume used
      // to be attached to every boot, and EDK2 hung enumerating it: the firmware
      // console stopped dead on `UsbBootExecCmd: Success to Exec 0x0 Cmd
      // (Result = 1)` with a core pegged and no boot target ever chosen. That was
      // seen on a plain instance carrying only that one USB disk, so it is not a
      // matter of how many are attached. An instance does not need the volume —
      // its answer file and transcript matter only during a build, and the
      // firmware finds Windows Boot Manager on the ESP without a shell selector.
      "-drive", `if=none,media=disk,id=res0,format=raw,file=${p.result}`,
      "-device", "usb-storage,drive=res0,removable=true,bus=usb-bus.0",
      "-drive", `if=none,media=cdrom,id=cd0,file=${media.iso()},readonly=on`,
      "-device", "usb-storage,drive=cd0,bootindex=0,bus=usb-bus.0",
      "-drive", `if=none,media=cdrom,id=cd1,file=${media.tools()},readonly=on`,
      "-device", "usb-storage,drive=cd1,bus=usb-bus.0",
      "-drive", `if=none,media=cdrom,id=cd2,file=${media.seed()},readonly=on`,
      "-device", "usb-storage,drive=cd2,bus=usb-bus.0",
      // The scratch virtio-blk device whose only job is to exist, so PnP installs
      // viostor and marks it boot-start. See Paths.prime.
      "-drive", `if=none,media=disk,id=prime0,file=${p.prime}`,
      "-device", "virtio-blk-pci,drive=prime0",
    )
  }
  return a
}

/**
 * The swtpm processes serving this instance's TPM state, found by their command
 * line. Matched on the exact `dir=<tpmDir> ` argument, so "fix-1" can never
 * claim "fix-10"'s emulator, and so one left by an earlier, crashed launch —
 * which no pidfile records — is found as well.
 */
function swtpmPids(p: Paths): readonly number[] {
  const dir = p.tpmDir.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&")
  const r = spawnSync("pgrep", ["-f", `^swtpm socket --tpmstate dir=${dir} `], { encoding: "utf8" })
  if (r.status !== 0) return []
  return r.stdout
    .split("\n")
    .map((l) => Number.parseInt(l, 10))
    .filter((n) => Number.isFinite(n))
}

/**
 * Stop this instance's swtpm, if any is left.
 *
 * `terminate` on the control channel (see startSwtpm) ends swtpm once QEMU has
 * connected and then gone, however it went. It cannot cover a QEMU that died
 * before connecting, or an emulator started by an older winvm without that
 * flag — and those leaked, one per failed launch or `kill`, for as long as the
 * host stayed up. Every teardown path calls this, so none depends on swtpm
 * noticing by itself.
 */
export function stopSwtpm(p: Paths): void {
  for (const pid of swtpmPids(p)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already gone between the listing and the signal.
    }
  }
  rmSync(p.tpmSock, { force: true })
}

async function startSwtpm(p: Paths): Promise<void> {
  // Anything still running here outlived the QEMU it served — launch is only
  // reached with no QEMU on this instance — and carries that machine's
  // volatile TPM state. Start clean, as a power cycle would. The stale socket
  // goes with it: binding over one fails. Waited out, because the new one
  // cannot take the state directory's lock until the old one has let go.
  stopSwtpm(p)
  for (let i = 0; i < 50 && swtpmPids(p).length > 0; i += 1) await new Promise((r) => setTimeout(r, 20))
  const proc = spawn(
    "swtpm",
    [
      "socket",
      "--tpmstate",
      `dir=${p.tpmDir}`,
      // `terminate`: exit when QEMU's connection drops, so a SIGKILLed or
      // crashed QEMU does not leave its emulator behind.
      "--ctrl",
      `type=unixio,path=${p.tpmSock},terminate`,
      "--tpm2",
    ],
    { detached: true, stdio: "ignore" },
  )
  proc.unref()

  // WAIT FOR THE SOCKET TO EXIST. Measured here, swtpm needs ~15 ms to bind it,
  // and QEMU connects to this path while parsing its own command line — so
  // returning immediately is a coin flip that QEMU sometimes loses, and loses
  // more often under load. It does not degrade: a chardev that cannot connect
  // aborts the launch outright (see below).
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (existsSync(p.tpmSock)) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`swtpm never created ${p.tpmSock} — check \`winvm doctor\``)
}

/**
 * Start the guest, and confirm it actually started.
 *
 * THE CONFIRMATION IS THE POINT. QEMU validates its command line and connects
 * its chardevs during startup, and reports failure by printing one line to
 * stderr and **exiting 0** — verified here with an unreachable TPM socket. This
 * used to be spawned detached with `stdio: "ignore"` and no check at all, which
 * made a launch that never happened indistinguishable from a slow boot: `start`
 * waited out its five-minute agent timeout and then blamed the guest agent, and
 * `build` saw "not running" on its first poll and promoted an empty disk to a
 * sealed base image.
 *
 * Throws if the guest is gone within a couple of seconds, with QEMU's own words.
 */
export async function launch(name: string, p: Paths, meta: InstanceMeta, o: LaunchOptions): Promise<void> {
  await startSwtpm(p)
  // Rotate rather than delete: the usual response to a bad boot is another boot,
  // and truncating here would erase the evidence being retried.
  if (existsSync(p.serial)) renameSync(p.serial, p.serialPrev)
  rmSync(p.qemuLog, { force: true })
  // No QEMU runs here (launch is only reached then), so any monitor socket is
  // a dead one's; gone, its reappearance means THIS QEMU created it.
  if (o.incoming !== undefined) rmSync(p.qmp, { force: true })
  // A display another home's instance (or anything else) is listening on would
  // fail QEMU's bind; move to a free one first.
  const m = await ensureFreeDisplay(name, p, meta)

  const log = openSync(p.qemuLog, "w")
  const proc = spawn("qemu-system-aarch64", [...qemuArgs(name, p, m, o)], {
    detached: true,
    stdio: ["ignore", log, log],
  })
  closeSync(log)
  proc.unref()

  const exited = new Promise<"exited">((res) => proc.on("exit", () => res("exited")))
  let timer: ReturnType<typeof setTimeout> | undefined
  const survived = new Promise<"alive">((res) => {
    timer = setTimeout(() => res("alive"), 2000)
  })
  // A LOAD WAITS ON QEMU, NOT ON THE TIMER. Two seconds of "still alive?" was
  // most of a mapped-ram load, which cannot even start until the monitor takes
  // `migrate-incoming`. A monitor that answers `query-status` means the command
  // line was accepted, the chardevs connected and the machine built; and with
  // -incoming no vCPU runs until the stream is in, so there is no later
  // failure for the timer to catch. (A boot keeps the timer: its vCPUs start
  // at once, and HVF can refuse a mapping only then.)
  let stop = false
  const answering =
    o.incoming === undefined ? new Promise<never>(() => undefined) : monitorAnswers(p, () => stop)
  const outcome = await Promise.race([exited, survived, answering])
  stop = true
  clearTimeout(timer)
  if (outcome === "alive") {
    // `password=on` refuses every VNC client until a password is set, so set it
    // now rather than leave the screen unreachable until someone runs `open`.
    // Advisory: a guest without a screen is still a working guest.
    await applyPassword(p).catch((error: unknown) => {
      console.warn(`warning: could not set the VNC password: ${error instanceof Error ? error.message : String(error)}`)
    })
    // The in-guest agent's port forward is runtime state, gone with the last
    // QEMU; put it back for an instance that has one (a no-op otherwise).
    await restoreForward(p)
    return
  }

  // A QEMU that died this early may never have connected to swtpm, and then
  // `terminate` never fires.
  stopSwtpm(p)
  // Read and handle absence, rather than asking whether it exists and then
  // reading: the two-step version races anything else touching the file.
  const why = readTextOr(p.qemuLog, "").trim()
  throw new Error(`qemu exited immediately${why === "" ? "" : `:\n  ${why.split("\n").join("\n  ")}`}`)
}

async function monitorAnswers(p: Paths, stopped: () => boolean): Promise<"alive"> {
  while (!stopped()) {
    if (existsSync(p.qmp)) {
      try {
        await qmp.execute(p.qmp, "query-status", undefined, 5000)
        return "alive"
      } catch {
        // Socket bound but not yet accepting; ask again.
      }
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  return await new Promise<never>(() => undefined)
}

/**
 * Read a file, or fall back — never "does it exist?" followed by a read.
 *
 * The two-step form is a time-of-check/time-of-use race: these files are written
 * by a QEMU process running concurrently, so the answer can change between the
 * question and the read. Attempting the read and handling failure has no window.
 */
function readTextOr(path: string, fallback: string, encoding: BufferEncoding = "utf8"): string {
  try {
    return readFileSync(path, encoding)
  } catch {
    return fallback
  }
}

/**
 * Wait for a line to appear on the guest's firmware console.
 *
 * The serial log is the only channel that exists before the guest agent does,
 * which makes it the only way to observe the firmware as an EVENT rather than
 * guessing at it with a clock. Used to know when the install media's boot
 * prompt is imminent — see startup.nsh and qmp.tapEnter.
 *
 * Read as latin1 on purpose: the firmware emits ANSI escapes and NUL padding,
 * and a UTF-8 decode of that mangles the very bytes being matched.
 */
export async function waitForSerial(p: Paths, marker: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (readTextOr(p.serial, "", "latin1").replaceAll("\0", "").includes(marker)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/**
 * Per-instance, via QEMU's own pidfile — deliberately NOT a `pgrep
 * qemu-system-aarch64` pattern match. A global match is how one consumer ends
 * up reporting, or stopping, another's VM; an earlier version of this tool had
 * exactly that bug.
 */
export function pidOf(p: Paths): number | null {
  if (!existsSync(p.pid)) return null
  const pid = Number.parseInt(readFileSync(p.pid, "utf8").trim(), 10)
  if (!Number.isFinite(pid)) return null
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0)
    return pid
  } catch {
    // Stale pidfile from a crash or a reboot.
    rmSync(p.pid, { force: true })
    return null
  }
}

export const isRunning = (p: Paths): boolean => pidOf(p) !== null
