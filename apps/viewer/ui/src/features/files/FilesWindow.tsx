/**
 * The Files window: one instance's files in Windows, as Finder shows a Mac's.
 *
 * The title bar is an overlay: the traffic lights sit over the sidebar (the
 * known folders, then the drives), and back, forward, up, the path and
 * refresh make the toolbar beside them, which is also the drag region. Below,
 * the folder's entries in sortable columns, and a status bar saying how many
 * there are, what is selected and what a copy is doing.
 *
 * Items move by dragging them onto a folder row or a place (copied with
 * Option held), leave for the Mac by dragging them out of the window (file
 * promises, written only when Finder asks), and arrive by dropping Mac files
 * anywhere on the window. A right-click or Option-click shows a native menu.
 */
import { type KeyboardEvent, type MouseEvent, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  copyText,
  dragOut,
  installedShells,
  onHostDrag,
  onInstanceTitle,
  openTerminal,
  pickFiles,
  popupActions,
  revealInFinder,
  setWindowTitle,
  showWindow,

  type Action,
} from "../../backend"
import { Button } from "../../components/Button"
import { Callout } from "../../components/Callout"
import { ConfirmDialog } from "../../components/ConfirmDialog"
import { cx } from "../../components/cx"
import { Icon, type IconName } from "../../components/Icon"
import { t } from "../../i18n"
import { defaultShell, installedList, runnable } from "../terminal/shells"
import { FileList, type Renaming, rowHeight, rowId } from "./FileList"
import type { Entry, ListFailure, Listing, Place, Sort, SortKey } from "./files"
import { childPath, clickSelect, crumbs, findByPrefix, freeName, isListing, isWithin, leafName, nameProblem, samePath, sortEntries } from "./files"
import { glyphOf, kindLabel } from "./kinds"
import { copy, listFolder, makeFolder, move, type OpCode, remove } from "./ops"
import { useCopies } from "./useCopies"

const PLACE_ICON: Record<Place["kind"], IconName> = {
  desktop: "monitor",
  documents: "fileText",
  downloads: "download",
  home: "home",
  work: "folder",
  drive: "hardDrive",
}

/** Desktop, Documents and Downloads in the reader's words; the profile, C:\work and drives by their own names. */
const placeName = (p: Place): string => (p.kind === "desktop" || p.kind === "documents" || p.kind === "downloads" ? t(`files.place.${p.kind}`) : p.name)

/** What to call a folder: a known folder's name, else its own. */
export function folderName(path: string, places: readonly Place[]): string {
  const place = places.find((p) => samePath(p.path, path) && p.kind !== "home")
  return place === undefined ? leafName(path) : placeName(place)
}

const isMac = (): boolean => typeof navigator === "undefined" || !/win|linux/i.test(navigator.platform)
const mod = (e: { metaKey: boolean; ctrlKey: boolean }): boolean => (isMac() ? e.metaKey : e.ctrlKey)

/** Asking for confirmation from this many items on: fewer go straight to the Recycle Bin, which can undo. */
const CONFIRM_FROM = 10
/** How far the pointer moves before a press becomes a drag, in CSS pixels. */
const DRAG_SLOP = 4

/** Per-viewer conveniences: the sort and the last folder. Losing them loses nothing. */
const remember = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`winvm.files.${key}`)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`winvm.files.${key}`, value)
    } catch {
      // private mode or blocked storage: not remembered
    }
  },
}

const SORT_KEYS: readonly SortKey[] = ["name", "modified", "size", "kind"]

function savedSort(): Sort {
  const [key, dir] = (remember.get("sort") ?? "").split(":")
  return SORT_KEYS.includes(key as SortKey) ? { key: key as SortKey, descending: dir === "desc" } : { key: "name", descending: false }
}

/** Where a drag would land: a folder row, a place, or the folder shown. */
type Target = { readonly kind: "row"; readonly name: string; readonly path: string } | { readonly kind: "place"; readonly path: string } | { readonly kind: "here"; readonly path: string }

interface Drag {
  readonly names: readonly string[]
  readonly x: number
  readonly y: number
  readonly target: Target | null
  readonly copy: boolean
}

interface Press {
  readonly x: number
  readonly y: number
  readonly name: string
  readonly alt: boolean
  /** Pressed on a selected row with no modifier: it becomes the only selection on release, unless dragged. */
  readonly collapse: boolean
}

const why = (code: OpCode): string => t(`files.why.${code}`)

export function FilesWindow({ instance, initialTitle }: { readonly instance: string; readonly initialTitle: string | null }): JSX.Element {
  // What the instance is called: given when the window opened, then kept up to date by the main window.
  const [title, setTitle] = useState<string | null>(initialTitle)
  useEffect(() => onInstanceTitle((e) => (e.instance === instance ? setTitle(e.title) : undefined)), [instance])
  const list = useRef<HTMLDivElement | null>(null)
  const [listing, setListing] = useState<Listing | null>(null)
  const [failure, setFailure] = useState<ListFailure | null>(null)
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [history, setHistory] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] })
  const [sort, setSort] = useState<Sort>(savedSort)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<Renaming | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<readonly string[] | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [hostTarget, setHostTarget] = useState<Target | null>(null)
  const copies = useCopies(instance)
  const request = useRef(0)
  const shown = useRef<string | null>(null)
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 })
  const press = useRef<Press | null>(null)
  const afterLoad = useRef<((l: Listing) => void) | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => showWindow(), [])

  // The webview's own menu (Reload, Inspect) is no use here; text fields keep theirs for cut and paste.
  useEffect(() => {
    const quiet = (e: globalThis.MouseEvent): void => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault()
    }
    window.addEventListener("contextmenu", quiet)
    return () => window.removeEventListener("contextmenu", quiet)
  }, [])

  /** Open `path` (null: the Desktop). `how` says what it does to back and forward. */
  const load = useCallback(
    async (path: string | null, how: "go" | "back" | "forward" | "stay"): Promise<void> => {
      const id = (request.current += 1)
      setLoading(true)
      const got = await listFolder(instance, path)
      if (id !== request.current) return
      setLoading(false)
      if (!isListing(got)) {
        setFailure(got)
        // A remembered folder that has gone: the Desktop instead.
        if (how === "stay" && shown.current === null && path !== null && got.code !== "notrunning") void load(null, "stay")
        return
      }
      setFailure(null)
      setNow(Date.now())
      const prev = shown.current
      const moved = prev === null || !samePath(prev, got.path)
      if (prev !== null && moved) {
        setHistory((h) =>
          how === "go"
            ? { back: [...h.back, prev], forward: [] }
            : how === "back"
              ? { back: h.back.slice(0, -1), forward: [prev, ...h.forward] }
              : how === "forward"
                ? { back: [...h.back, prev], forward: h.forward.slice(1) }
                : h,
        )
      }
      shown.current = got.path
      remember.set(`folder.${instance}`, got.path)
      setListing(got)
      const names = new Set(got.entries.map((e) => e.name))
      if (moved) {
        setSelected(new Set())
        setAnchor(null)
        setActive(null)
        setRenaming(null)
        list.current?.scrollTo({ top: 0 })
      } else {
        // The same folder read again: keep what is still there selected.
        setSelected((s) => new Set([...s].filter((n) => names.has(n))))
        setActive((a) => (a !== null && names.has(a) ? a : null))
      }
      const then = afterLoad.current
      afterLoad.current = null
      then?.(got)
    },
    [instance],
  )

  // First the folder it was left in (else the Desktop); again whenever files land in Windows.
  useEffect(() => {
    void load(shown.current ?? remember.get(`folder.${instance}`), "stay")
  }, [load, instance, copies.landed])

  useEffect(() => {
    list.current?.focus()
  }, [])

  const here = listing === null ? "" : folderName(listing.path, listing.places)
  useEffect(() => {
    setWindowTitle(here === "" ? t("files.title") : t("files.windowTitle", { folder: here, instance: title ?? instance }))
  }, [here, instance, title])

  const entries = useMemo(() => {
    const raw = listing?.entries ?? []
    const kinds = new Map(raw.map((e) => [e.name, kindLabel(e.name, e.dir, t)]))
    return sortEntries(raw, sort, (e) => kinds.get(e.name) ?? "")
  }, [listing, sort])
  const index = useMemo(() => new Map(entries.map((e, i) => [e.name, i])), [entries])
  const chosen = useMemo(() => entries.filter((e) => selected.has(e.name)), [entries, selected])

  // Live values for handlers that outlive a render (window listeners, menus).
  const live = useRef({ listing, entries, index, selected, chosen, renaming, drag })
  live.current = { listing, entries, index, selected, chosen, renaming, drag }

  // Keep the active row in view.
  useEffect(() => {
    const el = list.current
    const i = active === null ? undefined : index.get(active)
    if (el === null || i === undefined) return
    const row = rowHeight(el)
    const top = i * row
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + row > el.scrollTop + el.clientHeight) el.scrollTop = top + row - el.clientHeight
  }, [active, index])

  const go = (path: string): void => void load(path, "go")
  const goUp = (): void => {
    if (listing?.parent != null) go(listing.parent)
  }
  const goBack = (): void => {
    const to = history.back[history.back.length - 1]
    if (to !== undefined) void load(to, "back")
  }
  const goForward = (): void => {
    const to = history.forward[0]
    if (to !== undefined) void load(to, "forward")
  }
  const refresh = (): void => void load(listing?.path ?? null, "stay")
  const pathOf = (name: string): string => childPath(live.current.listing?.path ?? "", name)

  const select = (names: readonly string[], focus: string | null = names[names.length - 1] ?? null): void => {
    setSelected(new Set(names))
    setAnchor(focus)
    setActive(focus)
  }

  const openEntry = (e: Entry | undefined): void => {
    if (e?.dir === true && listing !== null) go(childPath(listing.path, e.name))
  }

  /** One operation at a time, in the order asked for; the folder is read again after each. */
  const enqueue = (work: () => Promise<void>): void => {
    queue.current = queue.current.then(work).catch((error: unknown) => copies.report({ ok: false, title: t("files.failed"), detail: String(error) }))
  }

  const fail = (title: string, code: OpCode, detail: string): void =>
    copies.report({ ok: false, title, detail: code === "other" ? detail : why(code) })

  // ---- Operations ----

  const newFolder = (): void => {
    const l = live.current.listing
    if (l === null) return
    const name = freeName(t("files.newFolderName"), new Set(l.entries.map((e) => e.name)), true)
    enqueue(async () => {
      const r = await makeFolder(instance, childPath(l.path, name))
      if (!r.ok) {
        fail(t("files.failedNewFolder"), r.code, r.detail)
        return
      }
      afterLoad.current = (got) => {
        if (!got.entries.some((e) => e.name === name)) return
        select([name])
        setRenaming({ name, draft: name })
      }
      await load(l.path, "stay")
    })
  }

  const startRename = (): void => {
    const only = live.current.chosen
    if (only.length !== 1 || only[0] === undefined) return
    setRenaming({ name: only[0].name, draft: only[0].name })
  }

  const finishRename = (commit: boolean): void => {
    const r = live.current.renaming
    if (r === null) return
    // Return ends the field, whose blur then asks again: answer once.
    live.current = { ...live.current, renaming: null }
    setRenaming(null)
    list.current?.focus()
    const name = r.draft
    if (!commit || name === r.name) return
    const problem = nameProblem(name)
    if (problem !== null) {
      copies.report({ ok: false, title: t("files.failedRename", { name: r.name }), detail: t(`files.badName.${problem}`) })
      return
    }
    const clash = live.current.entries.some((e) => e.name.toLowerCase() === name.toLowerCase() && e.name !== r.name)
    if (clash) {
      copies.report({ ok: false, title: t("files.failedRename", { name: r.name }), detail: t("files.badName.taken", { name }) })
      return
    }
    const folder = live.current.listing?.path ?? ""
    enqueue(async () => {
      const done = await move(instance, childPath(folder, r.name), childPath(folder, name))
      if (!done.ok) fail(t("files.failedRename", { name: r.name }), done.code, done.detail)
      else afterLoad.current = () => select([name])
      await load(folder, "stay")
    })
  }

  const trash = (names: readonly string[]): void => {
    if (names.length === 0) return
    if (names.length >= CONFIRM_FROM) setConfirm(names)
    else recycle(names)
  }

  const recycle = (names: readonly string[]): void => {
    const folder = live.current.listing?.path ?? ""
    enqueue(async () => {
      const r = await remove(
        instance,
        names.map((n) => childPath(folder, n)),
      )
      if (!r.ok) fail(t("files.failedTrash"), r.code, r.detail)
      else copies.report({ ok: true, title: t("files.recycled", { count: names.length, name: names[0] ?? "" }) })
      await load(folder, "stay")
    })
  }

  /** Move (or copy) items of the folder shown into `to`, under names free there. */
  const transfer = (names: readonly string[], to: string, asCopy: boolean): void => {
    const l = live.current.listing
    if (l === null || names.length === 0) return
    const from = l.path
    if (!asCopy && samePath(to, from)) return
    const items = names.flatMap((n) => l.entries.filter((e) => e.name === n))
    if (items.some((e) => e.dir && isWithin(to, childPath(from, e.name)))) {
      copies.report({ ok: false, title: asCopy ? t("files.failedCopy") : t("files.failedMove"), detail: why("into") })
      return
    }
    enqueue(async () => {
      const there = await listFolder(instance, to, { hidden: true })
      if (!isListing(there)) {
        copies.report({ ok: false, title: asCopy ? t("files.failedCopy") : t("files.failedMove"), detail: there.detail })
        return
      }
      const taken = new Set(there.entries.map((e) => e.name))
      const failed: string[] = []
      for (const e of items) {
        const name = freeName(e.name, taken, e.dir)
        taken.add(name)
        const r = await (asCopy ? copy : move)(instance, childPath(from, e.name), childPath(there.path, name))
        if (!r.ok) failed.push(`${e.name}: ${r.code === "other" ? r.detail : why(r.code)}`)
      }
      const folder = folderName(there.path, l.places)
      if (failed.length > 0) copies.report({ ok: false, title: t("files.notDone", { count: failed.length }), detail: failed.join("\n") })
      else
        copies.report({
          ok: true,
          title: t(asCopy ? "files.copiedHere" : "files.moved", { count: items.length, name: items[0]?.name ?? "", folder }),
        })
      await load(from, "stay")
    })
  }

  const copyPaths = (names: readonly string[]): void => {
    const paths = names.length === 0 ? [live.current.listing?.path ?? ""] : names.map(pathOf)
    copyText(paths.join("\n"))
      .then(() => copies.report({ ok: true, title: t("files.copiedPath", { count: paths.length }) }))
      .catch((e: unknown) => copies.report({ ok: false, title: t("files.failed"), detail: String(e) }))
  }

  const terminalIn = (cwd: string): void => {
    installedShells(instance)
      .then((installed) =>
        openTerminal({
          instance,
          ...runnable({ shell: defaultShell(installed), cwd }, installed),
          installed: installedList(installed),
          title,
        }),
      )
      .catch((e: unknown) => copies.report({ ok: false, title: t("terminal.failed"), detail: String(e) }))
  }

  const copyOut = (): void => {
    const l = live.current.listing
    if (l !== null && live.current.chosen.length > 0) copies.copyOut(l.path, live.current.chosen)
  }

  const copyIn = (to?: string): void => {
    const folder = to ?? live.current.listing?.path ?? null
    pickFiles(t("files.pickTitle"))
      .then((paths) => {
        if (paths.length > 0) copies.copyIn(paths, folder)
      })
      .catch(() => undefined)
  }

  // ---- Menus ----

  const itemMenu = (): Action[] => {
    const sel = live.current.chosen
    const one = sel.length === 1 ? sel[0] : undefined
    const folder = live.current.listing?.path ?? ""
    const names = sel.map((e) => e.name)
    return [
      { kind: "action", label: t("files.menu.open"), enabled: one?.dir === true, accelerator: "CmdOrCtrl+O", run: () => openEntry(one) },
      { kind: "separator" },
      { kind: "action", label: t("files.copyOut"), run: copyOut },
      { kind: "separator" },
      { kind: "action", label: t("files.menu.rename"), enabled: one !== undefined, run: startRename },
      { kind: "action", label: t("files.menu.trash"), accelerator: "CmdOrCtrl+Backspace", run: () => trash(names) },
      { kind: "separator" },
      { kind: "action", label: t("files.menu.copyPath", { count: names.length }), accelerator: "CmdOrCtrl+Alt+C", run: () => copyPaths(names) },
      { kind: "action", label: t("files.menu.terminal"), run: () => terminalIn(one?.dir === true ? childPath(folder, one.name) : folder) },
      { kind: "separator" },
      { kind: "action", label: t("files.menu.newFolder"), accelerator: "CmdOrCtrl+Shift+N", run: newFolder },
    ]
  }

  const folderMenu = (): Action[] => {
    const folder = live.current.listing?.path ?? ""
    return [
      { kind: "action", label: t("files.menu.newFolder"), accelerator: "CmdOrCtrl+Shift+N", run: newFolder },
      { kind: "action", label: t("files.copyIn"), run: () => copyIn() },
      { kind: "separator" },
      { kind: "action", label: t("files.menu.terminalHere"), run: () => terminalIn(folder) },
      { kind: "action", label: t("files.menu.copyPath", { count: 1 }), run: () => copyPaths([]) },
      { kind: "separator" },
      { kind: "action", label: t("files.refresh.menu"), accelerator: "CmdOrCtrl+R", run: refresh },
    ]
  }

  const showMenu = (nodes: Action[]): void => {
    popupActions(nodes).catch((e: unknown) => copies.report({ ok: false, title: t("files.failed"), detail: String(e) }))
  }

  const onContextMenu = (e: MouseEvent<HTMLDivElement>, entry: Entry | null): void => {
    e.preventDefault()
    if (live.current.listing === null) return
    if (entry === null) {
      select([], null)
      showMenu(folderMenu())
      return
    }
    if (!live.current.selected.has(entry.name)) select([entry.name])
    // The selection above lands before the menu reads it.
    setTimeout(() => showMenu(itemMenu()), 0)
  }

  // ---- Pointer: selection, drags inside the window, and handing a drag to the Mac ----

  /** What is under the pointer that a drag could land on, leaving out what is being dragged. */
  const targetAt = (x: number, y: number, carried: ReadonlySet<string>): Target | null => {
    const l = live.current.listing
    if (l === null) return null
    const el = document.elementFromPoint(x, y)
    const place = el?.closest<HTMLElement>("[data-place]")
    if (place != null) {
      const path = place.dataset["place"] ?? ""
      return samePath(path, l.path) ? null : { kind: "place", path }
    }
    const row = el?.closest<HTMLElement>(".files__row[data-dir]")
    const name = row?.dataset["name"]
    if (name !== undefined && !carried.has(name)) return { kind: "row", name, path: childPath(l.path, name) }
    if (el?.closest(".files__list") != null) return { kind: "here", path: l.path }
    return null
  }

  const onRowPointerDown = (e: PointerEvent<HTMLDivElement>, entry: Entry): void => {
    if (e.button !== 0 || (isMac() && e.ctrlKey)) return
    if (live.current.renaming !== null) return
    list.current?.focus()
    const toggle = mod(e)
    const range = e.shiftKey
    const has = live.current.selected.has(entry.name)
    if (!has || toggle || range) {
      const order = live.current.entries
      const idx = live.current.index
      const at = idx.get(entry.name) ?? 0
      const from = anchor === null ? null : (idx.get(anchor) ?? null)
      const now = new Set([...live.current.selected].flatMap((n) => (idx.has(n) ? [idx.get(n) ?? 0] : [])))
      const r = clickSelect(now, from, at, { toggle, range })
      setSelected(new Set([...r.selected].map((i) => order[i]?.name ?? "")))
      setAnchor(order[r.anchor]?.name ?? null)
      setActive(entry.name)
    }
    press.current = { x: e.clientX, y: e.clientY, name: entry.name, alt: e.altKey, collapse: has && !toggle && !range }
  }

  const onBackgroundPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || live.current.renaming !== null) return
    if (!mod(e) && !e.shiftKey) select([], null)
  }

  useEffect(() => {
    const move = (e: globalThis.PointerEvent): void => {
      const p = press.current
      if (p === null) return
      const d = live.current.drag
      if (d === null) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_SLOP) return
        const names = live.current.chosen.map((x) => x.name)
        if (names.length === 0) return
        setDrag({ names, x: e.clientX, y: e.clientY, target: null, copy: e.altKey })
        return
      }
      const outside = e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight
      if (outside) {
        // Out of the window: macOS carries it on, as promises Finder redeems on drop.
        const l = live.current.listing
        press.current = null
        setDrag(null)
        if (l === null) return
        const items = d.names.flatMap((n) => l.entries.filter((x) => x.name === n)).map((x) => ({ path: childPath(l.path, x.name), name: x.name, dir: x.dir }))
        copies.expectPromises(items.length)
        // A rejection means macOS never started the drag (the button was already up): nothing to say.
        dragOut(instance, items).catch((error: unknown) => console.warn("the drag out of the window did not start", error))
        return
      }
      setDrag({ ...d, x: e.clientX, y: e.clientY, target: targetAt(e.clientX, e.clientY, new Set(d.names)), copy: e.altKey })
    }
    const up = (e: globalThis.PointerEvent): void => {
      const p = press.current
      press.current = null
      const d = live.current.drag
      if (d !== null) {
        setDrag(null)
        if (d.target !== null) transfer(d.names, d.target.path, e.altKey)
        return
      }
      if (p === null) return
      if (p.alt) {
        // Option-click: the item's menu, as a right-click.
        showMenu(itemMenu())
        return
      }
      if (p.collapse) select([p.name])
    }
    const key = (e: globalThis.KeyboardEvent): void => {
      const d = live.current.drag
      if (d === null) return
      if (e.key === "Escape") {
        press.current = null
        setDrag(null)
      } else if (e.key === "Alt") setDrag({ ...d, copy: e.type === "keydown" })
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("keydown", key)
    window.addEventListener("keyup", key)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("keydown", key)
      window.removeEventListener("keyup", key)
    }
  })

  // ---- Mac files dragged in: copied into the folder under the pointer, else the one shown ----

  const copyInto = copies.copyIn
  useEffect(
    () =>
      onHostDrag((e) => {
        if (e.type === "leave") {
          setHostTarget(null)
          return
        }
        // A drag of our own coming back carries promises, not paths: not a drop here.
        if (e.type === "enter" && e.paths.length === 0) return
        const at = e.at
        const target = at === null ? null : targetAt(at.x, at.y, new Set())
        const l = live.current.listing
        const into = target ?? (l === null ? null : { kind: "here" as const, path: l.path })
        if (e.type === "drop") {
          setHostTarget(null)
          if (e.paths.length > 0 && into !== null) copyInto(e.paths, into.path)
          return
        }
        setHostTarget((cur) => (e.type === "over" && cur === null ? null : into))
      }),
    // targetAt reads live values only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [copyInto],
  )

  // ---- Keys ----

  const moveTo = (i: number, extend: boolean): void => {
    const all = live.current.entries
    if (all.length === 0) return
    const next = Math.max(0, Math.min(all.length - 1, i))
    const name = all[next]?.name ?? null
    if (name === null) return
    setActive(name)
    if (extend && anchor !== null) {
      const from = live.current.index.get(anchor) ?? next
      const [a, b] = from < next ? [from, next] : [next, from]
      setSelected(new Set(all.slice(a, b + 1).map((e) => e.name)))
    } else select([name])
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const cmd = mod(e)
    const at = active === null ? -1 : (index.get(active) ?? -1)
    const page = Math.max(1, Math.floor((list.current?.clientHeight ?? 240) / rowHeight(list.current)) - 1)
    if ((e.key === "ArrowDown" && cmd) || (e.key.toLowerCase() === "o" && cmd)) {
      const one = chosen.length === 1 ? chosen[0] : undefined
      openEntry(one)
    } else if (e.key === "ArrowUp" && cmd) goUp()
    else if (e.key === "ArrowDown") moveTo(at < 0 ? 0 : at + 1, e.shiftKey)
    else if (e.key === "ArrowUp") moveTo(at < 0 ? 0 : at - 1, e.shiftKey)
    else if (e.key === "Home") moveTo(0, e.shiftKey)
    else if (e.key === "End") moveTo(entries.length - 1, e.shiftKey)
    else if (e.key === "PageDown") moveTo(at + page, e.shiftKey)
    else if (e.key === "PageUp") moveTo(at - page, e.shiftKey)
    else if (e.key === "Enter") startRename()
    else if (e.key === "Backspace" && cmd) trash(chosen.map((x) => x.name))
    else if (e.key.toLowerCase() === "a" && cmd) select(entries.map((x) => x.name), active)
    else if (e.key.toLowerCase() === "c" && cmd && e.altKey) copyPaths(chosen.map((x) => x.name))
    else if (e.key === "Escape" && selected.size > 0) select([], null)
    else if (e.key.length === 1 && !cmd && !e.altKey && !e.ctrlKey) {
      const tnow = Date.now()
      const text = (tnow - typed.current.at < 800 ? typed.current.text : "") + e.key
      typed.current = { text, at: tnow }
      const hit = findByPrefix(
        entries.map((x) => x.name),
        text,
        text.length === 1 ? at + 1 : Math.max(0, at),
      )
      if (hit !== null) moveTo(hit, false)
    } else return
    e.preventDefault()
  }

  const onWindowKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    // The list has answered it already (⌘↑ there is the enclosing folder too).
    if (e.defaultPrevented || !mod(e)) return
    const k = e.key.toLowerCase()
    if (k === "[") goBack()
    else if (k === "]") goForward()
    else if (k === "r") refresh()
    else if (k === "n" && e.shiftKey) newFolder()
    else if (k === "l" || (k === "g" && e.shiftKey)) setDraft(listing?.path ?? "")
    else if (e.key === "ArrowUp") goUp()
    else return
    e.preventDefault()
  }

  const onSort = (key: SortKey): void => {
    setSort((s) => {
      // A new column starts the way Finder starts it: names A to Z, dates and sizes biggest first.
      const next = s.key === key ? { key, descending: !s.descending } : { key, descending: key === "modified" || key === "size" }
      remember.set("sort", `${next.key}:${next.descending ? "desc" : "asc"}`)
      return next
    })
  }

  // ---- What the status bar says ----

  const job = copies.job
  const result = copies.result
  const total = listing?.total ?? 0
  const count =
    listing === null
      ? ""
      : selected.size > 0
        ? t("files.selectedOf", { selected: selected.size, count: entries.length })
        : t("files.items", { count: total })
  const carried = useMemo(() => new Set(drag?.names ?? []), [drag])
  const dropTarget = drag?.target ?? hostTarget
  const dropName = dropTarget === null || listing === null ? "" : folderName(dropTarget.path, listing.places)

  return (
    <div className="fw" onKeyDown={onWindowKey}>
      <aside className="fw__side">
        <div className="fw__lights" data-tauri-drag-region />
        <nav className="fw__places" aria-label={t("files.places")}>
          {(["places", "drives"] as const).map((group) => {
            const items = (listing?.places ?? []).filter((p) => (group === "drives") === (p.kind === "drive"))
            if (items.length === 0) return null
            return (
              <section key={group}>
                <h2 className="fw__group">{t(`files.${group}`)}</h2>
                <ul>
                  {items.map((p) => (
                    <li key={p.path}>
                      <button
                        type="button"
                        className={cx("fw__place", dropTarget?.kind === "place" && samePath(dropTarget.path, p.path) && "fw__place--target")}
                        aria-current={listing !== null && samePath(listing.path, p.path) ? "location" : undefined}
                        title={p.path}
                        data-place={p.path}
                        onClick={() => go(p.path)}
                      >
                        <Icon name={PLACE_ICON[p.kind]} />
                        <span className="fw__place-name">{placeName(p)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </nav>
      </aside>

      <section className="fw__main">
        <header className="fw__bar" data-tauri-drag-region>
          <div className="fw__nav">
            <button type="button" className="btn btn--ghost btn--icon" aria-label={t("files.back")} title={t("files.back")} disabled={history.back.length === 0} onClick={goBack}>
              <Icon name="back" />
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              aria-label={t("files.forward")}
              title={t("files.forward")}
              disabled={history.forward.length === 0}
              onClick={goForward}
            >
              <Icon name="forward" />
            </button>
            <button type="button" className="btn btn--ghost btn--icon" aria-label={t("files.up")} title={t("files.up")} disabled={listing?.parent == null} onClick={goUp}>
              <Icon name="up" />
            </button>
          </div>
          {draft === null ? (
            <nav className="fw__crumbs" aria-label={t("files.path")}>
              {crumbs(listing?.path ?? "").map((c, i, all) => (
                <span key={c.path} className={cx("fw__crumb", i === all.length - 1 && "fw__crumb--here")}>
                  {i > 0 && (
                    <span className="fw__sep" aria-hidden="true">
                      ›
                    </span>
                  )}
                  <button
                    type="button"
                    className="fw__crumb-btn"
                    aria-current={i === all.length - 1 ? "location" : undefined}
                    title={c.path}
                    data-place={i === all.length - 1 ? undefined : c.path}
                    onClick={() => go(c.path)}
                  >
                    {i === all.length - 1 ? here : c.name}
                  </button>
                </span>
              ))}
            </nav>
          ) : (
            <form
              className="fw__goto"
              onSubmit={(e) => {
                e.preventDefault()
                if (draft.trim() !== "") go(draft.trim())
                setDraft(null)
                list.current?.focus()
              }}
            >
              <input
                className="input mono"
                aria-label={t("files.goTo")}
                value={draft}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => setDraft(null)}
                onKeyDown={(e) => {
                  if (e.key !== "Escape") return
                  e.preventDefault()
                  setDraft(null)
                  list.current?.focus()
                }}
              />
            </form>
          )}
          <div className="fw__drag" data-tauri-drag-region />
          <button type="button" className="btn btn--ghost btn--icon" aria-label={t("files.refresh")} title={t("files.refresh")} onClick={refresh}>
            <Icon name="refresh" />
          </button>
        </header>

        {(failure !== null || (result !== null && !result.ok)) && (
          <div className="fw__notices">
            {failure !== null && (
              <Callout tone="error" title={t(`files.error.${failure.code}`)}>
                {failure.code === "other" && <pre className="output">{failure.detail}</pre>}
              </Callout>
            )}
            {result !== null && !result.ok && (
              <Callout
                tone="error"
                title={result.title}
                action={
                  <Button size="sm" variant="ghost" onClick={copies.dismiss}>
                    {t("action.dismiss")}
                  </Button>
                }
              >
                {result.detail !== undefined && <pre className="output">{result.detail}</pre>}
              </Callout>
            )}
          </div>
        )}

        <div className={cx("fw__body", hostTarget?.kind === "here" && "fw__body--target")}>
          <FileList
            list={list}
            label={here}
            entries={entries}
            sort={sort}
            selected={selected}
            active={active}
            renaming={renaming}
            target={dropTarget?.kind === "row" ? dropTarget.name : null}
            carried={carried}
            now={now}
            empty={listing !== null && entries.length === 0 && !loading}
            loading={loading}
            more={listing !== null && listing.total > listing.entries.length ? t("files.more", { shown: listing.entries.length, total: listing.total }) : null}
            onSort={onSort}
            onKeyDown={onListKey}
            onRowPointerDown={onRowPointerDown}
            onRowDoubleClick={openEntry}
            onContextMenu={onContextMenu}
            onBackgroundPointerDown={onBackgroundPointerDown}
            onDraft={(d) => setRenaming((r) => (r === null ? r : { ...r, draft: d }))}
            onRenameDone={finishRename}
          />
        </div>

        <footer className="fw__status" role="status">
          <span className="fw__count">{count}</span>
          <span className="fw__activity">
            {dropTarget !== null && (drag !== null || hostTarget !== null) ? (
              <span className="fw__status-text">{t(drag?.copy === true || hostTarget !== null ? "files.dropCopy" : "files.dropMove", { folder: dropName })}</span>
            ) : job !== null ? (
              <>
                <span className="fw__progress" aria-hidden="true">
                  <span style={{ width: `${String(Math.round(((job.done + 0.5) / Math.max(1, job.total)) * 100))}%` }} />
                </span>
                <span className="fw__status-text">
                  {job.total > 1 ? t("files.copyingOf", { name: job.name, done: job.done + 1, total: job.total }) : t("files.copying", { name: job.name })}
                </span>
              </>
            ) : result?.ok === true ? (
              <>
                <Icon name="check" />
                <span className="fw__status-text">{result.title}</span>
                {result.reveal !== undefined && (
                  <button type="button" className="fw__link" onClick={() => void revealInFinder(result.reveal ?? "")}>
                    {t("files.reveal")}
                  </button>
                )}
              </>
            ) : null}
          </span>
        </footer>
      </section>

      {drag !== null && (
        <div className={cx("fw__ghost", drag.copy && "fw__ghost--copy")} style={{ transform: `translate(${String(drag.x + 12)}px, ${String(drag.y + 8)}px)` }} aria-hidden="true">
          <span className="files__glyph">{glyphOf(drag.names[0] ?? "", entries.find((x) => x.name === drag.names[0])?.dir ?? false)}</span>
          <span className="fw__ghost-name">{drag.names.length === 1 ? drag.names[0] : t("files.dragCount", { count: drag.names.length })}</span>
          {drag.copy && <span className="fw__ghost-badge">+</span>}
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={t("files.confirmTrash.title", { count: confirm?.length ?? 0 })}
        body={<p>{t("files.confirmTrash.body")}</p>}
        confirmLabel={t("files.menu.trash")}
        cancelLabel={t("confirm.cancel")}
        tone="danger"
        onCancel={() => {
          setConfirm(null)
          list.current?.focus()
        }}
        onConfirm={() => {
          const names = confirm ?? []
          setConfirm(null)
          list.current?.focus()
          recycle(names)
        }}
      />
    </div>
  )
}

export { rowId }
