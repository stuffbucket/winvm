/**
 * The Terminal window: tabs of shells in Windows, beside the screen.
 *
 * Tabs arrive from the app (`terminal_open` queues them; this window takes
 * them when it opens and whenever it is rung) and from inside the window
 * (Cmd-T, the + button and its menu). Each tab is a TerminalView on the
 * guest's terminal WebSocket. Closing the last tab closes the window.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"

import { TerminalView, terminalProcessTitle } from "@winvm/terminal"

import {
  closeWindow,
  installedShells,
  onInstanceTitle,
  onTerminalMenu,
  onTerminalOpen,
  popupActions,
  popupMenu,
  setWindowTitle,
  showWindow,
  takeTerminalRequests,
  winvm,
} from "../../backend"
import { Button } from "../../components/Button"
import { Icon } from "../../components/Icon"
import { InlineRename } from "../../components/InlineRename"
import { cx } from "../../components/cx"
import { t } from "../../i18n"
import { TITLE_MAX } from "../../model"
import { terminalTheme, terminalTypography, useDark } from "./appearance"
import {
  connectArgs,
  defaultShell,
  failureText,
  fromList,
  type Launch,
  parseEndpoint,
  runnable,
  shellCache,
  shellMenu,
  shellTitle,
} from "./shells"
import { createSocketTransport, type SessionStatus } from "./socket"
import { activeTab, noTabs, type Tab, tabName, type TabState, tabsReducer } from "./tabs"

const newId = (): string => crypto.randomUUID()

export const tabTitle = (tab: Tab): string => tabName(tab, t(`shell.${tab.shell}`))

function stateOf(status: SessionStatus): TabState | null {
  switch (status.kind) {
    case "open":
      return { kind: "open" }
    case "exit":
      return { kind: "exited", code: status.code }
    case "lost":
      return { kind: "lost", message: status.message }
    case "error":
      return null
  }
}

function ended(state: TabState): string | null {
  if (state.kind === "exited") return t("terminal.exited", { code: state.code })
  if (state.kind === "lost") return state.message === null ? t("terminal.lost") : `${t("terminal.lost")} ${state.message}`
  if (state.kind === "failed") return state.message
  return null
}

export function TerminalWindow(): JSX.Element {
  const [s, dispatch] = useReducer(tabsReducer, noTabs)
  const current = useRef(s)
  current.current = s
  const dark = useDark()
  const theme = useMemo(() => terminalTheme(dark), [dark])
  const active = activeTab(s)
  /** The tab whose name is being edited. */
  const [editing, setEditing] = useState<string | null>(null)
  /** Each instance's title, from the app (null: its name). */
  const [titles, setTitles] = useState<Readonly<Record<string, string | null>>>({})
  useEffect(() => onInstanceTitle(({ instance, title }) => setTitles((was) => ({ ...was, [instance]: title }))), [])
  // Which shells each instance has: from the app with its first tab, or asked here.
  const shells = useMemo(() => shellCache(installedShells), [])

  const transport = useMemo(
    () =>
      createSocketTransport({
        async connect({ id }) {
          const tab = current.current.tabs.find((x) => x.id === id)
          if (tab === undefined) throw new Error("that tab has closed")
          const out = await winvm(...connectArgs(tab))
          const endpoint = out.code === 0 ? parseEndpoint(out.stdout) : null
          if (endpoint === null) throw new Error(failureText(out.stdout, out.stderr) || "winvm terminal didn't say where to connect")
          return endpoint
        },
        onStatus(id, status) {
          const state = stateOf(status)
          if (state !== null) dispatch({ type: "state", id, state })
          // Lost: Windows may have restarted, and may have other shells now.
          const tab = current.current.tabs.find((x) => x.id === id)
          if (status.kind === "lost" && tab !== undefined) shells.forget(tab.instance)
        },
      }),
    [shells],
  )

  // A hidden window gets no animation frames, so show it straight after the first commit.
  useEffect(() => showWindow(), [])

  useEffect(() => {
    const take = (): void => {
      takeTerminalRequests()
        .then((requests) => {
          for (const { installed, title, ...request } of requests) {
            if (installed !== null) shells.seed(request.instance, fromList(installed))
            setTitles((was) => ({ ...was, [request.instance]: title }))
            dispatch({ type: "open", id: newId(), request })
          }
        })
        .catch(() => undefined)
    }
    take()
    return onTerminalOpen(take)
  }, [shells])

  /** A new tab on the active tab's instance: `launch`, or the default shell. */
  const open = useCallback(
    (launch: Launch | null): void => {
      const from = activeTab(current.current) ?? current.current.tabs.at(-1)
      if (from === undefined) return
      const instance = from.instance
      void shells.get(instance).then((installed) => {
        const request = { instance, ...runnable(launch ?? { shell: defaultShell(installed), cwd: null }, installed) }
        dispatch({ type: "open", id: newId(), request })
      })
    },
    [shells],
  )
  const openDefault = useCallback(() => open(null), [open])
  const openMenu = (): void => {
    const from = activeTab(current.current) ?? current.current.tabs.at(-1)
    if (from === undefined) return
    void shells
      .get(from.instance)
      .then((installed) => popupMenu(shellMenu(t, installed), (item) => open(item.launch)))
      .catch(() => undefined)
  }

  useEffect(
    () =>
      onTerminalMenu((id) => {
        if (id === "new-tab") openDefault()
        const at = current.current.active
        if (id === "close-tab" && at !== null) dispatch({ type: "close", id: at })
        if (id === "rename-tab" && at !== null) setEditing(at)
      }),
    [openDefault],
  )

  /** Right-click on a tab: rename it, close it, or close the others. */
  const tabMenu = (tab: Tab): void => {
    void popupActions([
      { kind: "action", label: t("terminal.renameTab"), run: () => setEditing(tab.id) },
      { kind: "separator" },
      { kind: "action", label: t("terminal.closeThisTab"), run: () => dispatch({ type: "close", id: tab.id }) },
      {
        kind: "action",
        label: t("terminal.closeOtherTabs"),
        enabled: current.current.tabs.length > 1,
        run: () => dispatch({ type: "closeOthers", id: tab.id }),
      },
    ]).catch(() => undefined)
  }

  const rename = (tab: Tab, next: string | null): void => {
    setEditing(null)
    // Unchanged is no rename: an automatic name stays automatic.
    if (next === null || next.trim() === tabTitle(tab)) return
    dispatch({ type: "rename", id: tab.id, title: next })
  }

  // Tab switching the way Terminal and Safari do it.
  useEffect(() => {
    const keys = (e: KeyboardEvent): void => {
      const step = (by: 1 | -1): void => {
        e.preventDefault()
        e.stopPropagation()
        dispatch({ type: "step", by })
      }
      if (e.metaKey && e.shiftKey && (e.key === "]" || e.key === "}")) step(1)
      else if (e.metaKey && e.shiftKey && (e.key === "[" || e.key === "{")) step(-1)
      else if (e.ctrlKey && e.key === "Tab") step(e.shiftKey ? -1 : 1)
      else if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const tabs = current.current.tabs
        const tab = e.key === "9" ? tabs.at(-1) : tabs[Number(e.key) - 1]
        if (tab === undefined) return
        e.preventDefault()
        e.stopPropagation()
        dispatch({ type: "activate", id: tab.id })
      }
    }
    window.addEventListener("keydown", keys, { capture: true })
    return () => window.removeEventListener("keydown", keys, { capture: true })
  }, [])

  // The title bar shows tabs, not this; it names the window in the Window menu and Mission Control:
  // the active tab's instance and the tab.
  const title =
    active === null ? t("terminal.title") : t("terminal.windowTitle", { instance: titles[active.instance] ?? active.instance, tab: tabTitle(active) })
  useEffect(() => setWindowTitle(title), [title])

  // The last tab closing closes the window, as in Terminal.
  const hadTabs = useRef(false)
  useEffect(() => {
    if (s.tabs.length > 0) hadTabs.current = true
    else if (hadTabs.current) closeWindow()
  }, [s.tabs.length])

  const end = active === null ? null : ended(active.state)

  return (
    <div className="term">
      {/* The title bar: an overlay, so the strip and the space around its tabs move the window. */}
      <div className="term__bar" data-tauri-drag-region>
        <div className="term__tabs" role="tablist" aria-label={t("terminal.tabs")} data-tauri-drag-region>
          {s.tabs.map((tab) => {
            const name = tabTitle(tab)
            const done = tab.state.kind === "exited" || tab.state.kind === "lost" || tab.state.kind === "failed"
            // Windows' sign for elevated; after the name in the accessible name, before it on screen.
            const shield = (
              <span className="term__tab-admin" role="img" aria-label={t("terminal.runsAsAdmin")} title={t("terminal.runsAsAdmin")}>
                <Icon name="shield" />
              </span>
            )
            return (
              <div
                key={tab.id}
                className={cx("term__tab", tab.id === s.active && "term__tab--active", done && "term__tab--ended")}
                onContextMenu={(e) => {
                  e.preventDefault()
                  tabMenu(tab)
                }}
              >
                {editing === tab.id ? (
                  <div className="term__tab-label">
                    <InlineRename
                      className="term__tab-rename"
                      value={name}
                      label={t("terminal.tabName")}
                      maxLength={TITLE_MAX}
                      onDone={(next) => rename(tab, next)}
                    />
                    {shield}
                  </div>
                ) : (
                  <button
                    type="button"
                    role="tab"
                    className="term__tab-label"
                    aria-selected={tab.id === s.active}
                    onClick={() => dispatch({ type: "activate", id: tab.id })}
                    onDoubleClick={() => setEditing(tab.id)}
                    onAuxClick={(e) => {
                      if (e.button === 1) dispatch({ type: "close", id: tab.id })
                    }}
                  >
                    <span className="term__tab-name" title={t("terminal.tabTip", { name })}>
                      {name}
                    </span>
                    {shield}
                  </button>
                )}
                <button
                  type="button"
                  className="term__tab-close"
                  aria-label={t("terminal.close")}
                  title={t("terminal.closeTab")}
                  onClick={() => dispatch({ type: "close", id: tab.id })}
                >
                  <Icon name="cross" />
                </button>
              </div>
            )
          })}
          <button
            type="button"
            className="btn btn--ghost btn--icon term__new"
            aria-label={t("terminal.newTab")}
            aria-haspopup="menu"
            title={t("terminal.newTab")}
            disabled={s.tabs.length === 0}
            onClick={(e) => (e.altKey ? openMenu() : openDefault())}
            onContextMenu={(e) => {
              e.preventDefault()
              openMenu()
            }}
          >
            <Icon name="plus" />
          </button>
        </div>
      </div>

      <div className="term__panes">
        {s.tabs.length === 0 && <p className="term__none">{t("terminal.none")}</p>}
        {s.tabs.map((tab) => (
          <div key={tab.id} className="term__pane" hidden={tab.id !== s.active}>
            <TerminalView
              id={tab.id}
              shell={tab.shell}
              {...(tab.cwd === null ? {} : { cwd: tab.cwd })}
              ariaLabel={tabTitle(tab)}
              transport={transport}
              theme={theme}
              typography={terminalTypography}
              focused={tab.id === s.active}
              testId={`terminal-${tab.id}`}
              labels={{ startFailed: t("terminal.failed"), retry: t("terminal.retry") }}
              onTitleChange={(raw) => dispatch({ type: "title", id: tab.id, title: shellTitle(terminalProcessTitle(raw)) })}
              onError={(error) =>
                dispatch({ type: "state", id: tab.id, state: { kind: "failed", message: error instanceof Error ? error.message : String(error) } })
              }
            />
          </div>
        ))}
      </div>

      {active !== null && end !== null && (
        <div className="term__status" role="status">
          <p className="term__status-text">{end}</p>
          {active.state.kind !== "failed" && (
            <Button size="sm" variant="secondary" onClick={() => dispatch({ type: "reopen", id: active.id, newId: newId() })}>
              {t("terminal.reopen")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "close", id: active.id })}>
            {t("terminal.close")}
          </Button>
        </div>
      )}
    </div>
  )
}
