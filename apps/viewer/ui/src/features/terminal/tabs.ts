/**
 * The Terminal window's tabs, as a reducer. A tab is one shell session; its
 * id is the session's id, so reopening a tab gives it a new id and a new
 * shell. A shell that exits with 0 closes its tab, as `exit` does in
 * Terminal; any other end keeps the tab, and its scrollback, marked.
 *
 * A tab's name is the one the user gave it, else what its shell set (OSC 0
 * or 2), else the shell's own name: `tabName`.
 */
import type { OpenRequest } from "./shells"

export type TabState =
  | { readonly kind: "connecting" }
  | { readonly kind: "open" }
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "lost"; readonly message: string | null }
  | { readonly kind: "failed"; readonly message: string }

export interface Tab extends OpenRequest {
  readonly id: string
  /** What the shell set as its title, already made presentable; null uses the shell's name. */
  readonly title: string | null
  /** The name the user gave the tab, which wins over the shell's until cleared; null when none. */
  readonly customTitle: string | null
  readonly state: TabState
}

export interface Tabs {
  readonly tabs: readonly Tab[]
  readonly active: string | null
}

export type TabAction =
  | { readonly type: "open"; readonly id: string; readonly request: OpenRequest }
  | { readonly type: "close"; readonly id: string }
  | { readonly type: "activate"; readonly id: string }
  | { readonly type: "step"; readonly by: 1 | -1 }
  | { readonly type: "title"; readonly id: string; readonly title: string | null }
  | { readonly type: "state"; readonly id: string; readonly state: TabState }
  | { readonly type: "reopen"; readonly id: string; readonly newId: string }
  /** The user's name for a tab; empty (or only spaces) goes back to the automatic one. */
  | { readonly type: "rename"; readonly id: string; readonly title: string }
  | { readonly type: "closeOthers"; readonly id: string }

export const noTabs: Tabs = { tabs: [], active: null }

function close(s: Tabs, id: string): Tabs {
  const at = s.tabs.findIndex((t) => t.id === id)
  if (at === -1) return s
  const tabs = s.tabs.filter((t) => t.id !== id)
  if (s.active !== id) return { tabs, active: s.active }
  const next = tabs[Math.min(at, tabs.length - 1)]
  return { tabs, active: next?.id ?? null }
}

const update = (s: Tabs, id: string, change: (t: Tab) => Tab): Tabs => ({
  ...s,
  tabs: s.tabs.map((t) => (t.id === id ? change(t) : t)),
})

export function tabsReducer(s: Tabs, a: TabAction): Tabs {
  switch (a.type) {
    case "open":
      if (s.tabs.some((t) => t.id === a.id)) return s
      return { tabs: [...s.tabs, { ...a.request, id: a.id, title: null, customTitle: null, state: { kind: "connecting" } }], active: a.id }
    case "close":
      return close(s, a.id)
    case "closeOthers":
      return s.tabs.some((t) => t.id === a.id) ? { tabs: s.tabs.filter((t) => t.id === a.id), active: a.id } : s
    case "rename": {
      const title = a.title.trim()
      return update(s, a.id, (t) => ({ ...t, customTitle: title === "" ? null : title }))
    }
    case "activate":
      return s.tabs.some((t) => t.id === a.id) ? { ...s, active: a.id } : s
    case "step": {
      if (s.tabs.length === 0) return s
      const at = s.tabs.findIndex((t) => t.id === s.active)
      const next = s.tabs[(at + a.by + s.tabs.length) % s.tabs.length]
      return next === undefined ? s : { ...s, active: next.id }
    }
    case "title":
      return update(s, a.id, (t) => ({ ...t, title: a.title }))
    case "state":
      if (a.state.kind === "exited" && a.state.code === 0) return close(s, a.id)
      return update(s, a.id, (t) => {
        // An exit is final: the lost connection that follows it says nothing new.
        if (t.state.kind === "exited") return t
        return { ...t, state: a.state }
      })
    case "reopen": {
      if (s.tabs.some((t) => t.id === a.newId)) return s
      const tabs = s.tabs.map((t) => (t.id === a.id ? { ...t, id: a.newId, title: null, state: { kind: "connecting" } as const } : t))
      return { tabs, active: s.active === a.id ? a.newId : s.active }
    }
  }
}

/** A tab's name: the user's, else the shell's title, else `shellName` (the shell's own name). */
export const tabName = (tab: Tab, shellName: string): string => tab.customTitle ?? tab.title ?? shellName

/** The instance a new tab from inside the window opens on: the active tab's. */
export const activeTab = (s: Tabs): Tab | null => s.tabs.find((t) => t.id === s.active) ?? null
