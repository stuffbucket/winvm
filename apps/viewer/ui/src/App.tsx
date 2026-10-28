import type { CSSProperties } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { Size } from "@winvm/displayfit"

import {
  type Action,
  agentFetch,
  announceTitle,
  GUEST_FOLDERS_IN_FINDER,
  type GuestShare,
  installedShells,
  onFileDrop,
  onMenu,
  openFiles,
  openShareInFinder,
  openTerminal,
  outputText,
  popupActions,
  popupMenu,
  revealInFinder,
  setWindowTitle,
  shareStart,
  shareStop,
  showWindow,
  winvm,
} from "./backend"
import { Button } from "./components/Button"
import { Callout } from "./components/Callout"
import { ConfirmDialog } from "./components/ConfirmDialog"
import { Popover } from "./components/Popover"
import { cx } from "./components/cx"
import { t } from "./i18n"
import type { Phase, Share } from "./model"
import { controls, displaySize, isFrozen, isLivePhase, parseShare, shownTitle, startSteps, terminalBlocked } from "./model"
import { SavesPanel } from "./features/actions/SavesPanel"
import { SharePanel } from "./features/actions/SharePanel"
import { useCopies } from "./features/files/useCopies"
import { Overview } from "./features/overview/Overview"
import { Panel } from "./features/panel/Panel"
import { ReferenceDialog } from "./features/reference/ReferenceDialog"
import { Screen } from "./features/screen/Screen"
import { defaultShell, installedList, type Launch, runnable, shellCache, shellMenu } from "./features/terminal/shells"
import { type PanelId, Toolbar } from "./features/toolbar/Toolbar"
import type { Verb } from "./features/winvm/useWinvm"
import { useWinvm } from "./features/winvm/useWinvm"
import type { UsageContext } from "./features/usage/Resources"
import { DeleteMachineBody, type Deleting } from "./features/machines/DeleteMachine"
import { createArgs, destroyArgs, isLive as machineLive, nextAfterDelete, parseImages } from "./features/machines/machines"
import { type NewMachine, NewMachineDialog } from "./features/machines/NewMachineDialog"
import { useUsage } from "./features/usage/useUsage"
import { DEFAULT_SETTINGS, loadSettings, savePauseOverlay } from "./features/settings/settings"
import { pauseMenu } from "./features/winvm/pauseMenu"

type Confirm = { kind: "stop" | "reboot" | "kill" } | { kind: "load"; save: string }

interface Notice {
  readonly tone: "notice" | "error"
  readonly title: string
  readonly detail?: string
}

const CONFIRM_ACTION: Record<Confirm["kind"], string> = {
  stop: "action.shutDown",
  reboot: "action.restart",
  kill: "action.forceStop",
  load: "saves.restore",
}

const PANEL_LABEL: Record<PanelId, string> = {
  files: "action.files",
  saves: "action.saves",
  share: "action.share",
}

export function App(): JSX.Element {
  const w = useWinvm()
  const [actualSize, setActualSize] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [startedFrom, setStartedFrom] = useState<Phase | null>(null)
  const [open, setOpen] = useState<{ id: PanelId; anchor: HTMLElement } | null>(null)
  const [share, setShare] = useState<Share | null>(null)
  const [sharing, setSharing] = useState<{ starting: boolean; error: string | null }>({ starting: false, error: null })
  const [notice, setNotice] = useState<Notice | null>(null)
  /** The share being opened in Finder (its menu label), while `winvm files open` runs. */
  const [finding, setFinding] = useState<string | null>(null)
  const [reference, setReference] = useState<{ text: string | null } | null>(null)
  const [dropping, setDropping] = useState(false)

  // A hidden window gets no animation frames, so show it straight after the first commit.
  useEffect(() => showWindow(), [])

  const phase = w.phase
  const live = isLivePhase(phase)
  // Paused or asleep: no input, no resize, no agent calls until it runs again.
  const frozen = isFrozen(phase)
  const held = phase === "paused" || phase === "asleep" ? phase : null
  const guestReady = phase === "running" && w.busy === null
  const hostReady = w.checks === null || w.checks.ready
  const c = controls(phase ?? "missing", w.busy !== null || phase === null || !hostReady)
  const blocked = terminalBlocked(phase ?? "missing", w.busy !== null || phase === null || !hostReady)
  const missing = w.checks?.checks.filter((x) => !x.ok) ?? []
  const runtimeMissing = missing.some((x) => x.hint === "winvm setup")
  const display = displaySize(w.status?.screen ?? null)
  const showScreen = live && w.connection !== null
  // virtio-gpu: the guest's screen follows the window, one guest pixel per
  // device pixel, so there is nothing to fit. ramfb stays a fixed 800x600.
  const resizable = display.device === "virtio-gpu"
  const steps = w.busy === "start" && !showScreen ? startSteps(startedFrom === "missing", w.status) : null
  const activity =
    w.busy !== null ? t(`busy.${w.busy}`) : phase === "starting" ? t("state.starting") : held !== null ? t(`state.${held}`) : null

  // The guest switches to the viewer's size through its agent, called
  // directly (a few ms, not a CLI start per size), once it is up; a size asked
  // for before that waits for it.
  const pendingSize = useRef<{ size: Size; scale: number } | null>(null)
  const resizeGuest = useCallback(
    async (size: Size, scale: number): Promise<void> => {
      if (w.name === null) return
      if (!guestReady) {
        pendingSize.current = { size, scale }
        return
      }
      pendingSize.current = null
      const reply = await agentFetch(w.name, "POST", "/display", { op: "set", width: size.width, height: size.height, waitMs: 2000, scale }, 22_000)
      if (reply.status !== 200) throw new Error(`the agent answered ${String(reply.status)}: ${JSON.stringify(reply.body)}`)
    },
    [w.name, guestReady],
  )
  useEffect(() => {
    const p = pendingSize.current
    if (guestReady && p !== null) resizeGuest(p.size, p.scale).catch((error: unknown) => console.warn("resizing the guest failed", error))
  }, [guestReady, resizeGuest])
  // `ps` keeps reading while held (the history stays); the agent only while Windows is up.
  const metered = live ? (w.status?.pid ?? null) : null
  const usage = useUsage(metered, guestReady ? w.name : null, w.status?.cpus ?? null, w.status?.memoryMiB ?? null)
  const usageContext: UsageContext = { cpus: w.status?.cpus ?? null, overlayBytes: w.status?.overlayBytes ?? null }

  const run = (verb: Verb, arg?: string): void => {
    if (verb === "start") setStartedFrom(phase)
    void w.act(verb, arg)
  }

  // The person's own settings (`winvm settings`): whether a held screen is dimmed.
  const [pauseOverlay, setPauseOverlay] = useState(DEFAULT_SETTINGS.pauseOverlay)
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
      if (why !== null) setNotice({ tone: "error", title: t("settings.failed"), detail: why })
    })
  }
  const openPauseMenu = (): void => {
    popupActions(
      pauseMenu({ t, overlay: pauseOverlay, controls: c, setOverlay: changePauseOverlay, sleep: () => run("sleep"), lock: () => run("lock") }),
    ).catch(() => undefined)
  }
  // A key in an asleep machine's screen wakes it, once.
  const wake = (): void => {
    if (w.busy === null && phase === "asleep") run("wake")
  }

  // Files dropped on the main window go to the Desktop in Windows; the Files window takes them anywhere.
  const copies = useCopies(w.name)
  const copyIn = copies.copyIn
  const copyNotice = copies.job !== null || copies.result !== null

  useEffect(
    () =>
      onFileDrop(
        (paths) => {
          if (guestReady) copyIn(paths, null)
          else if (paths.length > 0) setNotice({ tone: "error", title: t("files.notRunning") })
        },
        (over) => setDropping(over && guestReady),
      ),
    [guestReady, copyIn],
  )

  // The instance's title: the toolbar shows it, the window is named by it, and
  // every window hears it (the Terminal names itself by its tab's instance).
  const titles = w.titles
  const title = w.name === null ? null : shownTitle(w.name, titles[w.name])
  const [renaming, setRenaming] = useState(false)
  useEffect(() => setWindowTitle(title ?? t("app.name")), [title])
  useEffect(() => {
    for (const [instance, set] of Object.entries(titles)) announceTitle({ instance, title: set })
  }, [titles])
  const rename = w.rename
  const renamed = (next: string | null): void => {
    setRenaming(false)
    if (next === null || title === null || next.trim() === title) return
    rename(next)
      .then((why) => {
        if (why !== null) setNotice({ tone: "error", title: t("rename.failed"), detail: why })
      })
      .catch((e: unknown) => setNotice({ tone: "error", title: t("rename.failed"), detail: String(e) }))
  }

  // New Machine…: a name (and, under Advanced, the image and whether to start
  // it), `winvm create`, then this window shows it, starting if asked.
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
      .then((out) => setImages(parseImages(out.stdout)))
      .catch(() => setImages([]))
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
      .catch((e: unknown) => setCreateError(String(e)))
      .finally(() => setCreating(false))
  }
  // Start it once this window has read its (stopped) state.
  useEffect(() => {
    if (startNext !== null && w.name === startNext && phase === "stopped" && w.busy === null) {
      setStartNext(null)
      setStartedFrom("missing")
      void w.act("start")
    }
  }, [startNext, w.name, phase, w.busy, w.act])

  // Delete "<name>"…: what goes, Keep saves, and a running machine turned off first.
  const [deleting, setDeleting] = useState<Deleting | null>(null)
  const [keepSaves, setKeepSaves] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const deleteMachine = async (d: Deleting): Promise<void> => {
    setDeleteBusy(true)
    try {
      if (d.live) await winvm("kill", "-i", d.name)
      const out = await winvm(...destroyArgs(d.name, keepSaves))
      if (out.code !== 0) {
        setNotice({ tone: "error", title: t("machine.deleteFailed", { title: d.title }), detail: outputText(out) })
        return
      }
      const next = nextAfterDelete(w.names, d.name)
      await w.refresh()
      w.select(next ?? "default")
      setNotice({ tone: "notice", title: t(keepSaves ? "machine.deletedKept" : "machine.deleted", { title: d.title }) })
    } catch (e) {
      setNotice({ tone: "error", title: t("machine.deleteFailed", { title: d.title }), detail: String(e) })
    } finally {
      setDeleteBusy(false)
      setDeleting(null)
    }
  }

  // Which shells the guest has: asked once Windows is ready, so the first tab
  // already knows, and asked again after it stops, restarts or is busy.
  const shells = useMemo(() => shellCache(installedShells), [])
  useEffect(() => {
    if (w.name === null) return
    if (guestReady) void shells.get(w.name)
    else shells.forget(w.name)
  }, [shells, w.name, guestReady])

  /** A tab of `launch`, or of the default shell (PowerShell 7 if the guest has it). */
  const terminal = useCallback(
    (launch: Launch | null): void => {
      const instance = w.name
      if (instance === null || !c.terminal) return
      shells
        .get(instance)
        .then((installed) =>
          openTerminal({
            instance,
            ...runnable(launch ?? { shell: defaultShell(installed), cwd: null }, installed),
            installed: installedList(installed),
            title: titles[instance] ?? null,
          }),
        )
        .catch((e: unknown) => setNotice({ tone: "error", title: t("terminal.failed"), detail: String(e) }))
    },
    [shells, w.name, c.terminal, titles],
  )

  const terminalMenu = (): void => {
    const instance = w.name
    if (instance === null) return
    shells
      .get(instance)
      .then((installed) => popupMenu(shellMenu(t, installed), (item) => terminal(item.launch)))
      .catch((e: unknown) => setNotice({ tone: "error", title: t("terminal.failed"), detail: String(e) }))
  }

  const install = w.installCommand
  useEffect(
    () =>
      onMenu((id) => {
        if (id === "new-terminal") terminal(null)
        if (id === "rename-window") setRenaming(true)
        if (id === "install-cli") void install()
        if (id === "reference") {
          setReference({ text: null })
          winvm("help")
            .then((out) => setReference({ text: outputText(out) }))
            .catch((e: unknown) => setReference({ text: String(e) }))
        }
      }),
    [install, terminal],
  )

  useEffect(() => {
    if (w.cliPath !== null) setNotice({ tone: "notice", title: t("cli.done", { path: w.cliPath }) })
  }, [w.cliPath])

  useEffect(() => {
    if (notice?.tone !== "notice") return
    const timer = setTimeout(() => setNotice(null), 8000)
    return () => clearTimeout(timer)
  }, [notice])

  // Sharing ends with the guest.
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
        setSharing({ starting: false, error: got === null ? outputText(out) : null })
      })
      .catch((e: unknown) => setSharing({ starting: false, error: String(e) }))
  }

  const stopSharing = (): void => {
    void shareStop()
    setShare(null)
  }

  const filesWindow = (): void => {
    setOpen(null)
    if (w.name !== null) openFiles(w.name, titles[w.name] ?? null).catch((e: unknown) => setNotice({ tone: "error", title: t("files.openFailed"), detail: String(e) }))
  }

  // The guest's home folder and C:\ in Finder (`winvm files open`). The first
  // time sets Windows up to share, so it says what it is doing meanwhile.
  const filesMenu = (): void => {
    const instance = w.name
    if (instance === null) return
    const finder = (label: string, place: string, share: GuestShare): Action => ({
      kind: "action",
      label: GUEST_FOLDERS_IN_FINDER ? label : t("files.finder.soon", { label }),
      enabled: GUEST_FOLDERS_IN_FINDER && finding === null,
      run: () => {
        setFinding(place)
        openShareInFinder(instance, share)
          .catch((e: unknown) => setNotice({ tone: "error", title: t("files.finder.failed"), detail: e instanceof Error ? e.message : String(e) }))
          .finally(() => setFinding(null))
      },
    })
    popupActions([
      { kind: "action", label: t("files.menu.window"), run: filesWindow },
      { kind: "separator" },
      finder(t("files.finder.home"), t("files.finder.homePlace"), "home"),
      finder(t("files.finder.drive", { drive: "C:\\" }), "C:\\", "c"),
    ]).catch((e: unknown) => setNotice({ tone: "error", title: t("files.openFailed"), detail: String(e) }))
  }

  const togglePanel = (id: PanelId, anchor: HTMLElement): void => {
    if (id === "files") filesWindow()
    else setOpen((cur) => (cur?.id === id ? null : { id, anchor }))
  }
  const closePanel = useCallback(() => setOpen(null), [])

  const frame = {
    "--display-ratio": String(display.width / display.height),
    "--display-width": `${String(display.width)}px`,
  } as CSSProperties

  return (
    <div className="viewer" data-busy={w.busy !== null}>
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
          onRename: () => setRenaming(true),
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
        canSaves={phase !== null && phase !== "missing"}
        canShare={phase !== null && phase !== "missing"}
        sharing={share !== null}
        actualSize={actualSize}
        canActualSize={!resizable}
        open={open?.id ?? null}
        detailsOpen={detailsOpen}
        onStart={() => run("start")}
        onShutDown={() => setConfirm({ kind: "stop" })}
        onRestart={() => setConfirm({ kind: "reboot" })}
        onPause={() => run("pause")}
        onResume={() => run(phase === "asleep" ? "wake" : "resume")}
        onPauseMenu={openPauseMenu}
        onOpen={togglePanel}
        onTerminal={() => terminal(null)}
        onTerminalMenu={terminalMenu}
        onFilesMenu={filesMenu}
        onActualSize={() => setActualSize((a) => !a)}
        onScreenSharing={() => void w.openScreenSharing()}
        onDetails={() => setDetailsOpen((o) => !o)}
      />

      <div className="stage">
        <div className="display-area">
          {(w.failure !== null || notice !== null || copyNotice || (w.checks !== null && !w.checks.ready) || w.statusError !== null) && (
            <div className="notices">
              {w.failure !== null && (
                <Callout
                  tone="error"
                  title={t(`error.${w.failure.verb}`)}
                  action={
                    <Button size="sm" variant="ghost" onClick={w.dismissFailure}>
                      {t("action.dismiss")}
                    </Button>
                  }
                >
                  <pre className="output">{w.failure.output}</pre>
                </Callout>
              )}
              {finding !== null && (
                <Callout tone="notice" title={t("files.finder.opening", { place: finding })}>
                  <p>{t("files.finder.firstTime")}</p>
                </Callout>
              )}
              {notice !== null && (
                <Callout
                  tone={notice.tone}
                  title={notice.title}
                  action={
                    <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
                      {t("action.dismiss")}
                    </Button>
                  }
                >
                  {notice.detail !== undefined && <pre className="output">{notice.detail}</pre>}
                </Callout>
              )}
              {copyNotice && copies.job !== null && (
                <Callout tone="notice" title={t("files.copying", { name: copies.job.name })}>
                  {copies.job.total > 1 && <p>{t("files.ofTotal", { done: copies.job.done + 1, total: copies.job.total })}</p>}
                </Callout>
              )}
              {copyNotice && copies.job === null && copies.result !== null && (
                <Callout
                  tone={copies.result.ok ? "notice" : "error"}
                  title={copies.result.title}
                  action={
                    copies.result.reveal !== undefined ? (
                      <Button size="sm" variant="ghost" onClick={() => void revealInFinder(copies.result?.reveal ?? "")}>
                        {t("files.reveal")}
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={copies.dismiss}>
                        {t("action.dismiss")}
                      </Button>
                    )
                  }
                >
                  {copies.result.detail !== undefined && <pre className="output">{copies.result.detail}</pre>}
                </Callout>
              )}
              {w.checks !== null && !w.checks.ready && (
                <Callout
                  tone="error"
                  title={t("host.notReady")}
                  action={
                    runtimeMissing ? (
                      <Button size="sm" variant="primary" disabled={w.busy !== null} onClick={() => run("setup")}>
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
                showScreen && "display--on",
                dropping && "display--drop",
              )}
              style={frame}
            >
              {showScreen && w.connection !== null ? (
                <Screen
                  connection={w.connection}
                  resizable={resizable}
                  onGuestSize={resizeGuest}
                  frozen={frozen}
                  asleep={phase === "asleep"}
                  waking={w.busy === "wake"}
                  onWake={wake}
                  overlay={pauseOverlay}
                />
              ) : (
                <Overview phase={phase} status={w.status} steps={steps} canStart={c.start} onStart={() => run("start")} />
              )}
              {dropping && (
                <div className="display__drop" aria-hidden="true">
                  <p>{t("files.dropOn", { folder: t("files.place.desktop") })}</p>
                </div>
              )}
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
            canForceStop={live && w.busy === null}
            onForceStop={() => setConfirm({ kind: "kill" })}
          />
        )}
      </div>

      {open !== null && w.name !== null && (
        <Popover anchor={open.anchor} label={t(PANEL_LABEL[open.id])} onClose={closePanel}>
          {open.id === "saves" && (
            <SavesPanel
              instance={w.name}
              canSave={phase === "running" || phase === "paused"}
              busy={w.busy !== null}
              onSave={(name) => run("save", name)}
              onRestore={(save) => setConfirm({ kind: "load", save })}
            />
          )}
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

      {reference !== null && <ReferenceDialog text={reference.text} onClose={() => setReference(null)} />}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === null ? "" : confirm.kind === "load" ? t("confirm.load.title", { name: confirm.save }) : t(`confirm.${confirm.kind}.title`)}
        body={confirm === null ? "" : <p>{t(`confirm.${confirm.kind}.body`)}</p>}
        confirmLabel={confirm === null ? "" : t(CONFIRM_ACTION[confirm.kind])}
        cancelLabel={t("confirm.cancel")}
        tone={confirm?.kind === "stop" || confirm?.kind === "kill" ? "danger" : "default"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const chosen = confirm
          setConfirm(null)
          if (chosen === null) return
          setOpen(null)
          if (chosen.kind === "load") run("load", chosen.save)
          else run(chosen.kind)
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={deleting === null ? "" : t("machine.deleteTitle", { title: deleting.title })}
        body={
          deleting === null ? "" : <DeleteMachineBody deleting={deleting} keepSaves={keepSaves} busy={deleteBusy} onKeepSaves={setKeepSaves} />
        }
        confirmLabel={deleting?.live === true ? t("machine.deleteLive") : t("machine.deleteConfirm")}
        cancelLabel={t("confirm.cancel")}
        tone="danger"
        busy={deleteBusy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => (deleting === null ? undefined : deleteMachine(deleting))}
      />

      <NewMachineDialog
        open={newOpen}
        names={w.names}
        images={images}
        busy={creating}
        error={createError}
        onCreate={createMachine}
        onCancel={() => setNewOpen(false)}
      />
    </div>
  )
}
