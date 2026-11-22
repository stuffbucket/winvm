import type { OpenRequest } from "./shells"

export type TabState =
  | { readonly kind: "connecting" }
  | { readonly kind: "open" }
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "lost"; readonly message: string | null }
  | { readonly kind: "failed"; readonly message: string }

export interface Tab extends OpenRequest {
  readonly id: string
  readonly title: string | null
  readonly customTitle: string | null
  readonly state: TabState
}

export interface Tabs {
  readonly tabs: readonly Tab[]
  readonly active: string | null
}

export type TabAction =
  | {
      readonly type: "open"
      readonly id: string
      readonly request: OpenRequest
    }
  | { readonly type: "close"; readonly id: string }
  | { readonly type: "activate"; readonly id: string }
  | { readonly type: "step"; readonly by: 1 | -1 }
  | {
      readonly type: "title"
      readonly id: string
      readonly title: string | null
    }
  | { readonly type: "state"; readonly id: string; readonly state: TabState }
  | { readonly type: "reopen"; readonly id: string; readonly newId: string }
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
      return {
        tabs: [
          ...s.tabs,
          {
            ...a.request,
            id: a.id,
            title: null,
            customTitle: null,
            state: { kind: "connecting" },
          },
        ],
        active: a.id,
      }
    case "close":
      return close(s, a.id)
    case "closeOthers":
      return s.tabs.some((t) => t.id === a.id)
        ? { tabs: s.tabs.filter((t) => t.id === a.id), active: a.id }
        : s
    case "rename": {
      const title = a.title.trim()
      return update(s, a.id, (t) => ({
        ...t,
        customTitle: title === "" ? null : title,
      }))
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
        if (t.state.kind === "exited") return t
        return { ...t, state: a.state }
      })
    case "reopen": {
      if (s.tabs.some((t) => t.id === a.newId)) return s
      const tabs = s.tabs.map((t) =>
        t.id === a.id
          ? {
              ...t,
              id: a.newId,
              title: null,
              state: { kind: "connecting" } as const,
            }
          : t,
      )
      return { tabs, active: s.active === a.id ? a.newId : s.active }
    }
  }
}

export const tabName = (tab: Tab, shellName: string): string =>
  tab.customTitle ?? tab.title ?? shellName

export const activeTab = (s: Tabs): Tab | null =>
  s.tabs.find((t) => t.id === s.active) ?? null
