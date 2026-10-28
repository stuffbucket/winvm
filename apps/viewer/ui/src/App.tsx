import type { CSSProperties } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"

import {
  announceTitle,
  installedShells,
  onFileDrop,
  onMenu,
  openTerminal,
  outputText,
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
import { controls, displaySize, parseShare, shownTitle, startSteps, terminalBlocked } from "./model"
import { SavesPanel } from "./features/actions/SavesPanel"
import { SharePanel } from "./features/actions/SharePanel"
import { FilesDialog } from "./features/files/FilesDialog"
import { useCopies } from "./features/files/useCopies"
import { Overview } from "./features/overview/Overview"
import { Panel } from "./features/panel/Panel"
import { ReferenceDialog } from "./features/reference/ReferenceDialog"
import { Screen } from "./features/screen/Screen"
import { defaultShell, installedList, type Launch, runnable, shellCache, shellMenu } from "./features/terminal/shells"
import { type PanelId, Toolbar } from "./features/toolbar/Toolbar"
import type { Verb } from "./features/winvm/useWinvm"
import { useWinvm } from "./features/winvm/useWinvm"

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

/** The Files sheet's folder: where copies in land, the Desktop until the sheet goes elsewhere. */
interface Folder {
  readonly path: string
  readonly name: string
}

const isLive = (p: Phase | null): boolean => p === "running" || p === "starting" || p === "paused"

export function App(): JSX.Element {
  const w = useWinvm()
  const [fit, setFit] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [startedFrom, setStartedFrom] = useState<Phase | null>(null)
  const [open, setOpen] = useState<{ id: PanelId; anchor: HTMLElement } | null>(null)
  const [share, setShare] = useState<Share | null>(null)
  const [sharing, setSharing] = useState<{ starting: boolean; error: string | null }>({ starting: false, error: null })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [reference, setReference] = useState<{ text: string | null } | null>(null)
  const [dropping, setDropping] = useState(false)

  // A hidden window gets no animation frames, so show it straight after the first commit.
  useEffect(() => showWindow(), [])

  const phase = w.phase
  const live = isLive(phase)
  const guestReady = phase === "running" && w.busy === null
  const hostReady = w.checks === null || w.checks.ready
  const c = controls(phase ?? "missing", w.busy !== null || phase === null || !hostReady)
  const blocked = terminalBlocked(phase ?? "missing", w.busy !== null || phase === null || !hostReady)
  const missing = w.checks?.checks.filter((x) => !x.ok) ?? []
  const runtimeMissing = missing.some((x) => x.hint === "winvm setup")
  const display = displaySize(w.status?.screen ?? null)
  const showScreen = live && w.connection !== null
  const steps = w.busy === "start" && !showScreen ? startSteps(startedFrom === "missing", w.status) : null
  const activity = w.busy !== null ? t(`busy.${w.busy}`) : phase === "starting" ? t("state.starting") : null

  const run = (verb: Verb, arg?: string): void => {
    if (verb === "start") setStartedFrom(phase)
    void w.act(verb, arg)
  }

  const copies = useCopies(w.name)
  const [filesOpen, setFilesOpen] = useState(false)
  const [folder, setFolder] = useState<Folder | null>(null)
  const copyIn = copies.copyIn
  const onFolder = useCallback((path: string, name: string) => setFolder({ path, name }), [])
  /** A copy's progress and result go above the display while the Files sheet isn't there to show them. */
  const copyNotice = !filesOpen && (copies.job !== null || copies.result !== null)

  // Another instance has other folders: back to its Desktop.
  useEffect(() => setFolder(null), [w.name])

  useEffect(
    () =>
      onFileDrop(
        (paths) => {
          if (guestReady) copyIn(paths, folder?.path ?? null)
          else if (paths.length > 0) setNotice({ tone: "error", title: t("files.notRunning") })
        },
        (over) => setDropping(over && guestReady),
      ),
    [guestReady, copyIn, folder],
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

  const togglePanel = (id: PanelId, anchor: HTMLElement): void => {
    if (id === "files") {
      setOpen(null)
      setFilesOpen(true)
    } else setOpen((cur) => (cur?.id === id ? null : { id, anchor }))
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
        names={w.names}
        name={w.name}
        titles={titles}
        title={title}
        renaming={renaming}
        onRenameStart={() => setRenaming(true)}
        onRenamed={renamed}
        phase={phase}
        activity={activity}
        controls={c}
        guestReady={guestReady}
        terminalBlocked={blocked}
        canSaves={phase !== null && phase !== "missing"}
        sharing={share !== null}
        fit={fit}
        open={filesOpen ? "files" : (open?.id ?? null)}
        detailsOpen={detailsOpen}
        onSelect={w.select}
        onStart={() => run("start")}
        onShutDown={() => setConfirm({ kind: "stop" })}
        onRestart={() => setConfirm({ kind: "reboot" })}
        onPause={() => run("pause")}
        onResume={() => run("resume")}
        onOpen={togglePanel}
        onTerminal={() => terminal(null)}
        onTerminalMenu={terminalMenu}
        onFit={() => setFit((f) => !f)}
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
            <div className={cx("display", fit && "display--fill", showScreen && "display--on", dropping && "display--drop")} style={frame}>
              {showScreen && w.connection !== null ? (
                <Screen connection={w.connection} />
              ) : (
                <Overview phase={phase} status={w.status} steps={steps} canStart={c.start} onStart={() => run("start")} />
              )}
              {dropping && (
                <div className="display__drop" aria-hidden="true">
                  <p>{t("files.dropOn", { folder: folder?.name ?? t("files.place.desktop") })}</p>
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
            <SharePanel share={share} starting={sharing.starting} error={sharing.error} onStart={startSharing} onStop={stopSharing} />
          )}
        </Popover>
      )}

      {reference !== null && <ReferenceDialog text={reference.text} onClose={() => setReference(null)} />}

      {filesOpen && live && w.name !== null && (
        <FilesDialog
          instance={w.name}
          title={title ?? w.name}
          folder={folder?.path ?? null}
          dropping={dropping}
          copies={copies}
          onFolder={onFolder}
          onClose={() => setFilesOpen(false)}
        />
      )}

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
    </div>
  )
}
