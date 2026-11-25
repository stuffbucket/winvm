import type { Size } from "@winvm/displayfit"
import type { CSSProperties, JSX } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  type Action,
  agentFetch,
  announceTitle,
  errorMessage,
  GUEST_FOLDERS_IN_FINDER,
  type GuestShare,
  installedShells,
  onFileDrop,
  onMenu,
  openAccessibilitySettings,
  openFiles,
  openShareInFinder,
  openTerminal,
  outputText,
  popupActions,
  popupMenu,
  revealInFinder,
  type SystemKeys,
  setMainMenuState,
  setWindowTitle,
  shareStart,
  shareStop,
  showWindow,
  systemKeysStatus,
  trace,
  winvm,
} from "./backend"
import { Button } from "./components/Button"
import { Callout } from "./components/Callout"
import { ConfirmDialog } from "./components/ConfirmDialog"
import { cx } from "./components/cx"
import { Popover } from "./components/Popover"
import { HTTP_ACCEPTED, HTTP_OK } from "./constants"
import { SharePanel } from "./features/actions/SharePanel"
import { CheckpointCanvas } from "./features/checkpoints/CheckpointCanvas"
import { ClosePolicyDialog } from "./features/close/ClosePolicyDialog"
import { SessionEndNote } from "./features/close/SessionEndNote"
import { useCloseFlow } from "./features/close/useCloseFlow"
import { useCopies } from "./features/files/useCopies"
import { useMachineInfo } from "./features/hardware/useMachineInfo"
import {
  DeleteMachineBody,
  type Deleting,
} from "./features/machines/DeleteMachine"
import {
  createArgs,
  destroyArgs,
  isLive as machineLive,
  nextAfterDelete,
  parseImages,
} from "./features/machines/machines"
import {
  type NewMachine,
  NewMachineDialog,
} from "./features/machines/NewMachineDialog"
import { OperationOverlay } from "./features/operation/OperationOverlay"
import { Overview } from "./features/overview/Overview"
import { Panel } from "./features/panel/Panel"
import { ReferenceDialog } from "./features/reference/ReferenceDialog"
import { inputRule } from "./features/screen/input"
import { Screen, type ScreenHandle } from "./features/screen/Screen"
import { SettingsDialog } from "./features/settings/SettingsDialog"
import {
  DEFAULT_SETTINGS,
  loadSettings,
  savePauseOverlay,
} from "./features/settings/settings"
import { useSharedFolder } from "./features/sharedfolder/useSharedFolder"
import {
  defaultShell,
  installedList,
  type Launch,
  runnable,
  shellCache,
  shellMenu,
} from "./features/terminal/shells"
import { nativeMenuState } from "./features/toolbar/nativeMenu"
import { type PanelId, Toolbar } from "./features/toolbar/Toolbar"
import type { UsageContext } from "./features/usage/Resources"
import { useUsage } from "./features/usage/useUsage"
import { inputPhase } from "./features/winvm/agentSeen"
import { pauseMenu } from "./features/winvm/pauseMenu"
import type { Verb } from "./features/winvm/useWinvm"
import { useWinvm } from "./features/winvm/useWinvm"
import { t } from "./i18n"
import type { ClosePolicy, Phase, Share } from "./model"
import {
  controls,
  displaySize,
  isFrozen,
  isLivePhase,
  parseShare,
  RESTORED_BUSY,
  shownTitle,
  startSteps,
  terminalBlocked,
} from "./model"

type Confirm = { kind: "stop" | "reboot" | "kill" }

interface Notice {
  readonly tone: "notice" | "error"
  readonly title: string
  readonly detail?: string
}

const DISPLAY_WAIT_MS = 2000
const DISPLAY_REQUEST_TIMEOUT_MS = 22_000
const NOTICE_DISMISS_MS = 8000

const CONFIRM_ACTION: Record<Confirm["kind"], string> = {
  stop: "action.shutDown",
  reboot: "action.restart",
  kill: "action.forceStop",
}

const PANEL_LABEL: Record<PanelId, string> = {
  files: "action.files",
  share: "action.share",
}

export function App(): JSX.Element {
  const w = useWinvm()
  const close = useCloseFlow(w)
  const closeFailed = close.state.kind === "failed" ? close.state : null
  const closeAsking =
    close.state.kind === "asking" || close.state.kind === "waiting"
  const sessionEnd = closeAsking ? null : close.session
  const [actualSize, setActualSize] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [startedFrom, setStartedFrom] = useState<Phase | null>(null)
  const [open, setOpen] = useState<{ id: PanelId; anchor: HTMLElement } | null>(
    null,
  )
  const [share, setShare] = useState<Share | null>(null)
  const [sharing, setSharing] = useState<{
    starting: boolean
    error: string | null
  }>({ starting: false, error: null })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [finding, setFinding] = useState<string | null>(null)
  const [reference, setReference] = useState<{ text: string | null } | null>(
    null,
  )
  const [dropping, setDropping] = useState(false)
  const [checkpoints, setCheckpoints] = useState(false)
  const [closeCheckpoints, setCloseCheckpoints] = useState(0)
  const checkpointOpener = useRef<Element | null>(null)
  useEffect(() => {
    if (checkpoints) return
    const opener = checkpointOpener.current
    checkpointOpener.current = null
    if (opener instanceof HTMLElement) opener.focus({ preventScroll: true })
  }, [checkpoints])
  const [keyboardCaptured, setKeyboardCaptured] = useState(false)
  const [systemKeys, noteSystemKeys] = useState<SystemKeys | null>(null)
  const [askSystemKeys, setAskSystemKeys] = useState<"capture" | "menu" | null>(
    null,
  )
  const systemKeysAsked = useRef(false)
  const [settingClosePolicy, setSettingClosePolicy] = useState(false)
  const [closePolicyError, setClosePolicyError] = useState<{
    name: string
    text: string
  } | null>(null)
  const screen = useRef<ScreenHandle | null>(null)

  useEffect(() => {
    showWindow()
  }, [])
  useEffect(() => {
    const refresh = (): void => {
      systemKeysStatus()
        .then(noteSystemKeys)
        .catch((error: unknown) => {
          console.warn("reading the system-shortcut permission failed", error)
        })
    }
    refresh()
    window.addEventListener("focus", refresh)
    return () => {
      window.removeEventListener("focus", refresh)
    }
  }, [])
  const requestCapture = (): void => {
    if (systemKeys === "needsPermission" && !systemKeysAsked.current)
      setAskSystemKeys("capture")
    else setKeyboardCaptured(true)
  }
  const allowSystemKeys = (): void => {
    openAccessibilitySettings().catch((e: unknown) => {
      setNotice({
        tone: "error",
        title: t("systemKeys.openFailed"),
        detail: errorMessage(e),
      })
    })
  }

  const phase = w.phase
  const live = isLivePhase(phase)
  const frozen = isFrozen(phase)
  const held = phase === "paused" || phase === "asleep" ? phase : null
  const operating = w.operation !== null
  const protect = async (): Promise<void> => {
    const stowed = await w.act("stow")
    if (stowed?.code === 0) await w.act("start")
  }
  const input = inputRule(inputPhase(phase, w.agentSeen), operating)
  const [released, setReleased] = useState<string | null>(null)
  useEffect(() => {
    if (input.forward) setReleased(null)
    else if (keyboardCaptured) {
      setKeyboardCaptured(false)
      setReleased(input.released)
    }
  }, [input.forward, input.released, keyboardCaptured])
  const inputRef = useRef(input)
  inputRef.current = input
  useEffect(() => {
    trace(
      `input: ${input.forward ? "to the guest" : `held back (${input.why ?? "?"})`}; phase ${String(phase)}, verb ${String(w.busy)}`,
    )
  }, [input.forward, input.why, phase, w.busy])
  const guestReady = phase === "running" && !operating
  const hostReady = w.checks === null || w.checks.ready
  const c = controls(
    phase ?? "missing",
    operating || phase === null || !hostReady,
  )
  const blocked = terminalBlocked(
    phase ?? "missing",
    operating || phase === null || !hostReady,
  )
  const missing = w.checks?.checks.filter((x) => !x.ok) ?? []
  const runtimeMissing = missing.some((x) => x.hint === "winvm setup")
  const display = displaySize(w.status?.screen ?? null)
  const liveSource = useCallback(
    () => document.querySelector<HTMLCanvasElement>(".screen__canvas canvas"),
    [],
  )
  const showScreen = live && w.connection !== null
  const resizable = display.device === "virtio-gpu"
  const steps =
    w.busy === "start" && !showScreen
      ? startSteps(startedFrom === "missing", w.status)
      : null
  const activity =
    w.busy !== null
      ? t(`busy.${w.busy}`)
      : phase === "starting"
        ? t("state.starting")
        : held !== null
          ? t(`state.${held}`)
          : null

  const resizeGuest = useCallback(
    async (size: Size, scale: number): Promise<void> => {
      if (w.name === null) return
      if (!guestReady)
        throw new Error("Windows is not ready for a new size yet")
      const reply = await agentFetch(
        w.name,
        "POST",
        "/display",
        {
          op: "set",
          width: size.width,
          height: size.height,
          waitMs: DISPLAY_WAIT_MS,
          scale,
        },
        DISPLAY_REQUEST_TIMEOUT_MS,
      )
      if (reply.status !== HTTP_OK && reply.status !== HTTP_ACCEPTED)
        throw new Error(
          `the agent answered ${String(reply.status)}: ${JSON.stringify(reply.body)}`,
        )
    },
    [w.name, guestReady],
  )
  const metered = live ? (w.status?.pid ?? null) : null
  const usage = useUsage(
    metered,
    guestReady ? w.name : null,
    w.status?.cpus ?? null,
    w.status?.memoryMiB ?? null,
  )
  const usageContext: UsageContext = {
    cpus: w.status?.cpus ?? null,
    overlayBytes: w.status?.overlayBytes ?? null,
  }
  const sharedFolder = useSharedFolder(w.name, phase, guestReady, detailsOpen)
  const machineInfo = useMachineInfo(
    w.name,
    phase,
    guestReady,
    detailsOpen || settingsOpen,
  )

  const run = (verb: Verb, arg?: string): void => {
    if (verb === "start") setStartedFrom(phase)
    void w.act(verb, arg)
  }

  const [pauseOverlay, setPauseOverlay] = useState(
    DEFAULT_SETTINGS.pauseOverlay,
  )
  useEffect(() => {
    let gone = false
    void loadSettings(winvm).then((s) => {
      if (!gone) setPauseOverlay(s.pauseOverlay)
    })
    return () => {
      gone = true
    }
  }, [])
  const changePauseOverlay = (on: boolean): void => {
    setPauseOverlay(on)
    void savePauseOverlay(winvm, on).then((why) => {
      if (why !== null)
        setNotice({ tone: "error", title: t("settings.failed"), detail: why })
    })
  }
  const openPauseMenu = (): void => {
    popupActions(
      pauseMenu({
        t,
        overlay: pauseOverlay,
        controls: c,
        setOverlay: changePauseOverlay,
        sleep: () => {
          run("sleep")
        },
        lock: () => {
          run("lock")
        },
      }),
    ).catch(() => undefined)
  }
  const wake = (): void => {
    if (!operating && phase === "asleep") run("wake")
  }

  const copies = useCopies(w.name)
  const copyIn = copies.copyIn
  const copyNotice = copies.job !== null || copies.result !== null

  useEffect(
    () =>
      onFileDrop(
        (paths) => {
          if (checkpoints) return
          if (guestReady) copyIn(paths, null)
          else if (paths.length > 0)
            setNotice({ tone: "error", title: t("files.notRunning") })
        },
        (over) => {
          setDropping(over && guestReady && !checkpoints)
        },
      ),
    [guestReady, copyIn, checkpoints],
  )

  const titles = w.titles
  const title = w.name === null ? null : shownTitle(w.name, titles[w.name])
  const [renaming, setRenaming] = useState(false)
  useEffect(() => {
    setWindowTitle(title ?? t("app.name"))
  }, [title])
  useEffect(() => {
    for (const [instance, set] of Object.entries(titles))
      announceTitle({ instance, title: set })
  }, [titles])
  const rename = w.rename
  const renamed = (next: string | null): void => {
    setRenaming(false)
    if (next === null || title === null || next.trim() === title) return
    rename(next)
      .then((why) => {
        if (why !== null)
          setNotice({ tone: "error", title: t("rename.failed"), detail: why })
      })
      .catch((e: unknown) => {
        setNotice({
          tone: "error",
          title: t("rename.failed"),
          detail: errorMessage(e),
        })
      })
  }

  const [newOpen, setNewOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [images, setImages] = useState<string[] | null>(null)
  const [startNext, setStartNext] = useState<string | null>(null)
  const openNew = (): void => {
    setCreateError(null)
    setImages(null)
    setNewOpen(true)
    winvm("ls", "--json")
      .then((out) => {
        setImages(parseImages(out.stdout))
      })
      .catch(() => {
        setImages([])
      })
  }
  const createMachine = (m: NewMachine): void => {
    setCreating(true)
    setCreateError(null)
    winvm(...createArgs(m.name, m.image))
      .then(async (out) => {
        if (out.code !== 0) {
          setCreateError(outputText(out) || t("machine.createFailed"))
          return
        }
        await w.refresh()
        w.select(m.name)
        if (m.start) setStartNext(m.name)
        setNewOpen(false)
      })
      .catch((e: unknown) => {
        setCreateError(errorMessage(e))
      })
      .finally(() => {
        setCreating(false)
      })
  }
  useEffect(() => {
    if (
      startNext !== null &&
      w.name === startNext &&
      phase === "stopped" &&
      !operating
    ) {
      setStartNext(null)
      setStartedFrom("missing")
      void w.act("start")
    }
  }, [startNext, w.name, phase, operating, w.act])

  const [deleting, setDeleting] = useState<Deleting | null>(null)
  const [keepSaves, setKeepSaves] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const deleteMachine = async (d: Deleting): Promise<void> => {
    setDeleteBusy(true)
    try {
      if (d.live) await winvm("kill", "-i", d.name)
      const out = await winvm(...destroyArgs(d.name, keepSaves))
      if (out.code !== 0) {
        setNotice({
          tone: "error",
          title: t("machine.deleteFailed", { title: d.title }),
          detail: outputText(out),
        })
        return
      }
      const next = nextAfterDelete(w.names, d.name)
      await w.refresh()
      w.select(next ?? "default")
      setNotice({
        tone: "notice",
        title: t(keepSaves ? "machine.deletedKept" : "machine.deleted", {
          title: d.title,
        }),
      })
    } catch (e) {
      setNotice({
        tone: "error",
        title: t("machine.deleteFailed", { title: d.title }),
        detail: errorMessage(e),
      })
    } finally {
      setDeleteBusy(false)
      setDeleting(null)
    }
  }

  const shells = useMemo(() => shellCache(installedShells), [])
  useEffect(() => {
    if (w.name === null) return
    if (guestReady) void shells.get(w.name)
    else shells.forget(w.name)
  }, [shells, w.name, guestReady])

  const terminal = useCallback(
    (launch: Launch | null): void => {
      const instance = w.name
      if (instance === null || !c.terminal) return
      shells
        .get(instance)
        .then((installed) =>
          openTerminal({
            instance,
            ...runnable(
              launch ?? { shell: defaultShell(installed), cwd: null },
              installed,
            ),
            installed: installedList(installed),
            title: titles[instance] ?? null,
          }),
        )
        .catch((e: unknown) => {
          setNotice({
            tone: "error",
            title: t("terminal.failed"),
            detail: errorMessage(e),
          })
        })
    },
    [shells, w.name, c.terminal, titles],
  )

  const terminalMenu = (): void => {
    const instance = w.name
    if (instance === null) return
    shells
      .get(instance)
      .then((installed) =>
        popupMenu(shellMenu(t, installed), (item) => {
          terminal(item.launch)
        }),
      )
      .catch((e: unknown) => {
        setNotice({
          tone: "error",
          title: t("terminal.failed"),
          detail: errorMessage(e),
        })
      })
  }

  const canCheckpoints =
    w.name !== null && phase !== null && phase !== "missing"
  const openCheckpoints = useCallback(() => {
    setOpen(null)
    if (canCheckpoints && !checkpoints && !settingsOpen) {
      checkpointOpener.current = document.activeElement
      setKeyboardCaptured(false)
      setDropping(false)
      setCheckpoints(true)
    }
  }, [canCheckpoints, checkpoints, settingsOpen])
  const toggleCheckpoints = useCallback(() => {
    if (checkpoints) setCloseCheckpoints((n) => n + 1)
    else openCheckpoints()
  }, [checkpoints, openCheckpoints])
  const canSave = (phase === "running" || phase === "paused") && !operating
  const checkpointsMenu = (): void => {
    popupActions([
      {
        kind: "action",
        label: t("checkpoints.saveNow"),
        enabled: canSave,
        run: () => {
          run("save")
        },
      },
      { kind: "separator" },
      {
        kind: "action",
        label: t("checkpoints.showAll"),
        accelerator: "CmdOrCtrl+Shift+T",
        run: openCheckpoints,
      },
    ]).catch((e: unknown) => {
      setNotice({
        tone: "error",
        title: t("checkpoints.menuFailed"),
        detail: errorMessage(e),
      })
    })
  }

  const menuEnabled = nativeMenuState({
    phase,
    busy: operating,
    hostReady,
    instance: w.name !== null,
    forwardInput: input.forward,
    resizable,
    modal:
      checkpoints ||
      settingsOpen ||
      closeAsking ||
      confirm !== null ||
      deleting !== null ||
      newOpen ||
      reference !== null ||
      askSystemKeys !== null,
    systemKeys,
  })
  const menuStateKey = JSON.stringify(menuEnabled)
  useEffect(() => {
    setMainMenuState(JSON.parse(menuStateKey) as Record<string, boolean>).catch(
      (e: unknown) => {
        console.warn("updating native menu failed", e)
      },
    )
  }, [menuStateKey])
  const install = w.installCommand
  const menuHandler = useRef<(id: string) => void>(() => undefined)
  menuHandler.current = (id) => {
    if (menuEnabled[id] === false) return
    if (id === "vm-new") openNew()
    if (id === "vm-choose")
      document.querySelector<HTMLButtonElement>(".machine-picker")?.click()
    if (id === "vm-delete" && w.name !== null && title !== null) {
      setKeepSaves(false)
      setDeleting({ name: w.name, title, live: machineLive(phase) })
    }
    if (id === "vm-start") run("start")
    if (id === "vm-stop") setConfirm({ kind: "stop" })
    if (id === "vm-reboot") setConfirm({ kind: "reboot" })
    if (id === "vm-kill") setConfirm({ kind: "kill" })
    if (id === "vm-pause") run("pause")
    if (id === "vm-resume") run(phase === "asleep" ? "wake" : "resume")
    if (id === "vm-sleep") run("sleep")
    if (id === "vm-lock") run("lock")
    if (id === "vm-save") run("save")
    if (id === "vm-files") filesWindow()
    if (id === "vm-files-menu") filesMenu()
    if (id === "vm-shells") terminalMenu()
    if (id === "vm-share") {
      const anchor = [
        ...document.querySelectorAll<HTMLButtonElement>(".toolbar button"),
      ].find((b) => b.getAttribute("aria-label") === t("action.share"))
      if (anchor !== undefined) togglePanel("share", anchor)
    }
    if (id === "view-actual-size") setActualSize((v) => !v)
    if (id === "view-screen-sharing") void w.openScreenSharing()
    if (id === "view-details") setDetailsOpen((v) => !v)
    if (id === "view-pause-overlay") changePauseOverlay(!pauseOverlay)
    if (id === "settings") {
      setKeyboardCaptured(false)
      setOpen(null)
      setSettingsOpen(true)
    }
    if (id === "new-terminal") terminal(null)
    if (id === "release-keyboard") setKeyboardCaptured(false)
    if (id === "allow-system-keys") {
      setKeyboardCaptured(false)
      setAskSystemKeys("menu")
    }
    if (
      id === "capture-keyboard" ||
      id === "send-windows-key" ||
      id === "send-ctrl-alt-delete"
    ) {
      const rule = inputRef.current
      if (!showScreen || !rule.forward) {
        if (rule.why !== null) setNotice({ tone: "notice", title: t(rule.why) })
      } else if (id === "capture-keyboard") requestCapture()
      else if (id === "send-windows-key") screen.current?.sendWindowsKey()
      else screen.current?.sendCtrlAltDelete()
    }
    if (id === "rename-window") setRenaming(true)
    if (id === "checkpoints") toggleCheckpoints()
    if (id === "install-cli") void install()
    if (id === "reference") {
      setReference({ text: null })
      winvm("help")
        .then((out) => {
          setReference({ text: outputText(out) })
        })
        .catch((e: unknown) => {
          setReference({ text: errorMessage(e) })
        })
    }
  }
  useEffect(
    () =>
      onMenu((id) => {
        menuHandler.current(id)
      }),
    [],
  )

  useEffect(() => {
    if (w.cliPath !== null)
      setNotice({ tone: "notice", title: t("cli.done", { path: w.cliPath }) })
  }, [w.cliPath])

  useEffect(() => {
    if (notice?.tone !== "notice") return
    const timer = setTimeout(() => {
      setNotice(null)
    }, NOTICE_DISMISS_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [notice])

  useEffect(() => {
    if (!live && share !== null) {
      void shareStop()
      setShare(null)
    }
  }, [live, share])

  const startSharing = (): void => {
    if (w.name === null) return
    setSharing({ starting: true, error: null })
    shareStart(w.name)
      .then((out) => {
        const got = parseShare(out.stdout)
        setShare(got)
        setSharing({
          starting: false,
          error: got === null ? outputText(out) : null,
        })
      })
      .catch((e: unknown) => {
        setSharing({ starting: false, error: errorMessage(e) })
      })
  }

  const stopSharing = (): void => {
    void shareStop()
    setShare(null)
  }

  const filesWindow = (): void => {
    setOpen(null)
    if (w.name !== null)
      openFiles(w.name, titles[w.name] ?? null).catch((e: unknown) => {
        setNotice({
          tone: "error",
          title: t("files.openFailed"),
          detail: errorMessage(e),
        })
      })
  }

  const filesMenu = (): void => {
    const instance = w.name
    if (instance === null) return
    const finder = (
      label: string,
      place: string,
      share: GuestShare,
    ): Action => ({
      kind: "action",
      label: GUEST_FOLDERS_IN_FINDER
        ? label
        : t("files.finder.soon", { label }),
      enabled: GUEST_FOLDERS_IN_FINDER && finding === null,
      run: () => {
        setFinding(place)
        openShareInFinder(instance, share)
          .catch((e: unknown) => {
            setNotice({
              tone: "error",
              title: t("files.finder.failed"),
              detail: errorMessage(e),
            })
          })
          .finally(() => {
            setFinding(null)
          })
      },
    })
    popupActions([
      { kind: "action", label: t("files.menu.window"), run: filesWindow },
      { kind: "separator" },
      finder(t("files.finder.home"), t("files.finder.homePlace"), "home"),
      finder(t("files.finder.drive", { drive: "C:\\" }), "C:\\", "c"),
    ]).catch((e: unknown) => {
      setNotice({
        tone: "error",
        title: t("files.openFailed"),
        detail: errorMessage(e),
      })
    })
  }

  const togglePanel = (id: PanelId, anchor: HTMLElement): void => {
    if (id === "files") filesWindow()
    else setOpen((cur) => (cur?.id === id ? null : { id, anchor }))
  }
  const closePanel = useCallback(() => {
    setOpen(null)
  }, [])

  const changeClosePolicy = (policy: ClosePolicy): void => {
    const target = w.name
    if (target === null || settingClosePolicy) return
    setClosePolicyError(null)
    setSettingClosePolicy(true)
    void w.setClosePolicy(policy).then((why) => {
      setSettingClosePolicy(false)
      setClosePolicyError(why === null ? null : { name: target, text: why })
    })
  }

  const frame = {
    "--display-ratio": String(display.width / display.height),
    "--display-width": `${String(display.width)}px`,
  } as CSSProperties

  return (
    <div
      className="viewer"
      data-busy={operating}
      {...(checkpoints ? { inert: "" } : {})}
    >
      <div className="busybar" aria-hidden="true" />
      <Toolbar
        picker={{
          names: w.names,
          name: w.name,
          titles,
          phases: w.phases,
          phase,
          renaming,
          onRenamed: renamed,
          onSelect: w.select,
          onNew: openNew,
          onRename: () => {
            setRenaming(true)
          },
          onDelete: () => {
            if (w.name === null || title === null) return
            setKeepSaves(false)
            setDeleting({ name: w.name, title, live: machineLive(phase) })
          },
        }}
        phase={phase}
        activity={activity}
        controls={c}
        guestReady={guestReady}
        terminalBlocked={blocked}
        canCheckpoints={
          w.name !== null && phase !== null && phase !== "missing"
        }
        checkpointsOpen={checkpoints}
        canShare={phase !== null && phase !== "missing"}
        sharing={share !== null}
        actualSize={actualSize}
        canActualSize={!resizable}
        open={open?.id ?? null}
        detailsOpen={detailsOpen}
        keyboardCaptured={keyboardCaptured}
        input={input}
        keyboardReleased={released}
        systemKeys={systemKeys}
        onStart={() => {
          run("start")
        }}
        onShutDown={() => {
          setConfirm({ kind: "stop" })
        }}
        onRestart={() => {
          setConfirm({ kind: "reboot" })
        }}
        onPause={() => {
          run("pause")
        }}
        onResume={() => {
          run(phase === "asleep" ? "wake" : "resume")
        }}
        onPauseMenu={openPauseMenu}
        onOpen={togglePanel}
        onTerminal={() => {
          terminal(null)
        }}
        onTerminalMenu={terminalMenu}
        onFilesMenu={filesMenu}
        onCheckpoints={openCheckpoints}
        onCheckpointsMenu={checkpointsMenu}
        onActualSize={() => {
          setActualSize((a) => !a)
        }}
        onScreenSharing={() => void w.openScreenSharing()}
        onDetails={() => {
          setDetailsOpen((o) => !o)
        }}
        onKeyboardCapture={() => {
          if (keyboardCaptured) setKeyboardCaptured(false)
          else requestCapture()
        }}
      />

      <div className="stage">
        <div className="display-area">
          {(w.failure !== null ||
            closeFailed !== null ||
            sessionEnd !== null ||
            notice !== null ||
            copyNotice ||
            (w.checks !== null && !w.checks.ready) ||
            w.statusError !== null) && (
            <div className="notices">
              {w.failure !== null && (
                <Callout
                  tone={w.failure.code === RESTORED_BUSY ? "notice" : "error"}
                  title={
                    w.failure.code === RESTORED_BUSY
                      ? t("notice.restoredBusy")
                      : t(`error.${w.failure.verb}`)
                  }
                  action={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={w.dismissFailure}
                    >
                      {t("action.dismiss")}
                    </Button>
                  }
                >
                  <pre className="output">{w.failure.output}</pre>
                </Callout>
              )}
              {sessionEnd !== null && (
                <Callout tone="notice" title={t("close.sessionTitle")}>
                  <SessionEndNote session={sessionEnd} />
                </Callout>
              )}
              {closeFailed !== null && (
                <Callout
                  tone="error"
                  title={t("close.failed")}
                  action={
                    <Button size="sm" variant="ghost" onClick={close.cancel}>
                      {t("action.dismiss")}
                    </Button>
                  }
                >
                  {closeFailed.message !== w.failure?.output && (
                    <pre className="output">{closeFailed.message}</pre>
                  )}
                </Callout>
              )}
              {finding !== null && (
                <Callout
                  tone="notice"
                  title={t("files.finder.opening", { place: finding })}
                >
                  <p>{t("files.finder.firstTime")}</p>
                </Callout>
              )}
              {notice !== null && (
                <Callout
                  tone={notice.tone}
                  title={notice.title}
                  action={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setNotice(null)
                      }}
                    >
                      {t("action.dismiss")}
                    </Button>
                  }
                >
                  {notice.detail !== undefined && (
                    <pre className="output">{notice.detail}</pre>
                  )}
                </Callout>
              )}
              {copyNotice && copies.job !== null && (
                <Callout
                  tone="notice"
                  title={t("files.copying", { name: copies.job.name })}
                >
                  {copies.job.total > 1 && (
                    <p>
                      {t("files.ofTotal", {
                        done: copies.job.done + 1,
                        total: copies.job.total,
                      })}
                    </p>
                  )}
                </Callout>
              )}
              {copyNotice && copies.job === null && copies.result !== null && (
                <Callout
                  tone={copies.result.ok ? "notice" : "error"}
                  title={copies.result.title}
                  action={
                    copies.result.reveal !== undefined ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void revealInFinder(copies.result?.reveal ?? "")
                        }
                      >
                        {t("files.reveal")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={copies.dismiss}
                      >
                        {t("action.dismiss")}
                      </Button>
                    )
                  }
                >
                  {copies.result.detail !== undefined && (
                    <pre className="output">{copies.result.detail}</pre>
                  )}
                </Callout>
              )}
              {w.checks !== null && !w.checks.ready && (
                <Callout
                  tone="error"
                  title={t("host.notReady")}
                  action={
                    runtimeMissing ? (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={operating}
                        onClick={() => {
                          run("setup")
                        }}
                      >
                        {t("action.setup")}
                      </Button>
                    ) : undefined
                  }
                >
                  {missing.map((x) =>
                    x.hint === "winvm setup" ? (
                      <p key={x.label}>{t("host.runtimeMissing")}</p>
                    ) : (
                      <p key={x.label}>
                        {x.label} <span className="mono">{x.hint}</span>
                      </p>
                    ),
                  )}
                </Callout>
              )}
              {w.statusError !== null && (
                <Callout tone="error" title={t("error.status")}>
                  <pre className="output">{w.statusError}</pre>
                </Callout>
              )}
            </div>
          )}

          <div className="display-fit">
            <div
              className={cx(
                "display",
                actualSize && !resizable && "display--actual",
                resizable && showScreen && "display--live",
                !showScreen && "display--fill",
                showScreen && "display--on",
                dropping && "display--drop",
              )}
              style={frame}
            >
              {showScreen ? (
                <Screen
                  ref={screen}
                  connection={w.connection}
                  keyboardCaptured={keyboardCaptured}
                  onKeyboardCaptured={(next) => {
                    if (next) requestCapture()
                    else setKeyboardCaptured(false)
                  }}
                  onSystemKeys={noteSystemKeys}
                  forwardInput={input.forward && !settingsOpen && !checkpoints}
                  resizable={resizable}
                  onGuestSize={resizeGuest}
                  frozen={frozen}
                  ready={guestReady && !checkpoints}
                  asleep={phase === "asleep"}
                  waking={w.busy === "wake"}
                  onWake={wake}
                  overlay={pauseOverlay}
                />
              ) : (
                <Overview
                  instance={w.name}
                  title={title ?? undefined}
                  hasTitle={w.name !== null && titles[w.name] != null}
                  onRename={w.name === null ? undefined : rename}
                  phase={phase}
                  status={w.status}
                  steps={steps}
                  canStart={c.start}
                  onStart={() => {
                    run("start")
                  }}
                />
              )}
              {dropping && (
                <div className="display__drop" aria-hidden="true">
                  <p>
                    {t("files.dropOn", { folder: t("files.place.desktop") })}
                  </p>
                </div>
              )}
              <OperationOverlay operation={w.operation} />
            </div>
          </div>
        </div>

        {detailsOpen && (
          <Panel
            status={w.status}
            checks={w.checks}
            checksError={w.checksError}
            last={w.last}
            usage={usage}
            usageContext={usageContext}
            held={held}
            canForceStop={live && !operating}
            protecting={operating || w.busy !== null}
            onProtect={() => {
              void protect()
            }}
            sharedFolder={sharedFolder}
            machineInfo={machineInfo}
            guestReady={guestReady}
            closePolicy={w.status?.closePolicy ?? "ask"}
            closePolicyBusy={operating || settingClosePolicy}
            closePolicyError={
              closePolicyError !== null && closePolicyError.name === w.name
                ? closePolicyError.text
                : null
            }
            onClosePolicy={changeClosePolicy}
            onForceStop={() => {
              setConfirm({ kind: "kill" })
            }}
          />
        )}
      </div>

      {open !== null && w.name !== null && (
        <Popover
          anchor={open.anchor}
          label={t(PANEL_LABEL[open.id])}
          onClose={closePanel}
        >
          {open.id === "share" && (
            <SharePanel
              instance={w.name}
              guestReady={guestReady}
              share={share}
              starting={sharing.starting}
              error={sharing.error}
              onStart={startSharing}
              onStop={stopSharing}
            />
          )}
        </Popover>
      )}

      {reference !== null && (
        <ReferenceDialog
          text={reference.text}
          onClose={() => {
            setReference(null)
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          key={w.name}
          instance={w.name}
          title={title ?? t("app.name")}
          machineInfo={machineInfo}
          pauseOverlay={pauseOverlay}
          onPauseOverlay={changePauseOverlay}
          systemKeys={systemKeys}
          onAllowSystemKeys={allowSystemKeys}
          onClose={() => {
            setSettingsOpen(false)
          }}
        />
      )}

      {checkpoints && w.name !== null && (
        <CheckpointCanvas
          instance={w.name}
          machine={title ?? w.name}
          phase={phase}
          busy={operating}
          aspect={display.width / display.height}
          liveSource={liveSource}
          run={(verb, arg, options) => w.act(verb, arg, options)}
          closeRequest={closeCheckpoints}
          onClosed={() => {
            setCheckpoints(false)
          }}
        />
      )}

      <ConfirmDialog
        open={askSystemKeys !== null}
        title={t("systemKeys.title")}
        body={
          <>
            <p>{t("systemKeys.why")}</p>
            <p>{t("systemKeys.without")}</p>
          </>
        }
        confirmLabel={t("systemKeys.open")}
        cancelLabel={t(
          askSystemKeys === "capture" ? "confirm.cancel" : "systemKeys.notNow",
        )}
        {...(askSystemKeys === "capture" && {
          secondaryLabel: t("systemKeys.captureAnyway"),
          onSecondary: () => {
            systemKeysAsked.current = true
            setAskSystemKeys(null)
            setKeyboardCaptured(true)
          },
        })}
        onCancel={() => {
          setAskSystemKeys(null)
        }}
        onConfirm={() => {
          systemKeysAsked.current = true
          setAskSystemKeys(null)
          allowSystemKeys()
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === null ? "" : t(`confirm.${confirm.kind}.title`)}
        body={
          confirm === null ? "" : <p>{t(`confirm.${confirm.kind}.body`)}</p>
        }
        confirmLabel={confirm === null ? "" : t(CONFIRM_ACTION[confirm.kind])}
        cancelLabel={t("confirm.cancel")}
        tone={
          confirm?.kind === "stop" || confirm?.kind === "kill"
            ? "danger"
            : "default"
        }
        onCancel={() => {
          setConfirm(null)
        }}
        onConfirm={() => {
          const chosen = confirm
          setConfirm(null)
          if (chosen === null) return
          setOpen(null)
          run(chosen.kind)
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={
          deleting === null
            ? ""
            : t("machine.deleteTitle", { title: deleting.title })
        }
        body={
          deleting === null ? (
            ""
          ) : (
            <DeleteMachineBody
              deleting={deleting}
              keepSaves={keepSaves}
              busy={deleteBusy}
              onKeepSaves={setKeepSaves}
            />
          )
        }
        confirmLabel={
          deleting?.live === true
            ? t("machine.deleteLive")
            : t("machine.deleteConfirm")
        }
        cancelLabel={t("confirm.cancel")}
        tone="danger"
        busy={deleteBusy}
        onCancel={() => {
          setDeleting(null)
        }}
        onConfirm={() =>
          deleting === null ? undefined : deleteMachine(deleting)
        }
      />

      <NewMachineDialog
        open={newOpen}
        names={w.names}
        images={images}
        busy={creating}
        error={createError}
        onCreate={createMachine}
        onCancel={() => {
          setNewOpen(false)
        }}
      />

      <ClosePolicyDialog
        state={close.state}
        session={close.session}
        onChoose={close.choose}
        onRemember={close.setRemember}
        onCancel={close.cancel}
      />
    </div>
  )
}
