import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react"

import { pickFiles, revealInFinder, winvm } from "../../backend"
import { Button } from "../../components/Button"
import { Callout } from "../../components/Callout"
import { cx } from "../../components/cx"
import { EmptyState } from "../../components/EmptyState"
import { Icon, type IconName } from "../../components/Icon"
import { t } from "../../i18n"
import type { Entry, ListFailure, Listing, Place } from "./files"
import { clickSelect, crumbs, findByPrefix, formatBytes, formatModified, isListing, leafName, parseListing } from "./files"
import type { Copies } from "./useCopies"

interface FilesDialogProps {
  readonly instance: string
  /** What the user calls the instance, which names the sheet. */
  readonly title: string
  /** The folder to open in: where it was last, or null for the Desktop. */
  readonly folder: string | null
  /** Something is being dragged over the window. */
  readonly dropping: boolean
  readonly copies: Copies
  onFolder(path: string, name: string): void
  onClose(): void
}

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

/** What to call the folder a listing is of: a known folder's name, else its own. */
export function folderName(l: Listing): string {
  const place = l.places.find((p) => p.path.toLowerCase() === l.path.toLowerCase() && p.kind !== "home")
  return place === undefined ? leafName(l.path) : placeName(place)
}

function When({ ms }: { readonly ms: number }): JSX.Element {
  const { day, time } = formatModified(ms)
  return (
    <>
      {day}
      <span className="files__time">{` ${time}`}</span>
    </>
  )
}

const rowId = (i: number): string => `files-row-${String(i)}`
const isMac = (): boolean => typeof navigator === "undefined" || !/win|linux/i.test(navigator.platform)
const mod = (e: { metaKey: boolean; ctrlKey: boolean }): boolean => (isMac() ? e.metaKey : e.ctrlKey)

/**
 * The guest's files, in a sheet over the window: known folders at the side, a
 * path bar, and the folder's entries. Copies go out through the native save
 * or folder panel and come in through the open panel or a drop on the window,
 * into the folder shown here.
 */
export function FilesDialog({ instance, title, folder, dropping, copies, onFolder, onClose }: FilesDialogProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  const [listing, setListing] = useState<Listing | null>(null)
  const [failure, setFailure] = useState<ListFailure | null>(null)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] })
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const [draft, setDraft] = useState<string | null>(null)
  const request = useRef(0)
  /** The folder on screen, for history without reading state inside an update. */
  const shown = useRef<string | null>(null)
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 })

  useEffect(() => {
    const el = dialog.current
    if (el !== null && !el.open) el.showModal()
  }, [])

  /** Open `path` (null: the Desktop). `how` says what it does to back and forward. */
  const load = useCallback(
    async (path: string | null, how: "go" | "back" | "forward" | "stay"): Promise<void> => {
      const id = (request.current += 1)
      setLoading(true)
      const out = await winvm("dir", "-i", instance, ...(path === null ? [] : [path]), "--json").catch((e: unknown) => ({
        code: 1,
        stdout: "",
        stderr: String(e),
      }))
      if (id !== request.current) return
      setLoading(false)
      const got = parseListing(out.stdout, out.stderr)
      if (!isListing(got)) {
        setFailure(got)
        return
      }
      setFailure(null)
      const prev = shown.current
      if (prev !== null && prev !== got.path) {
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
      setListing(got)
      if (how !== "stay") {
        setSelected(new Set())
        setAnchor(null)
        setActive(0)
        list.current?.scrollTo({ top: 0 })
      }
      onFolder(got.path, folderName(got))
    },
    [instance, onFolder],
  )

  // First the folder it was left in (else the Desktop); again whenever files land in Windows.
  const first = useRef(folder)
  useEffect(() => {
    void load(shown.current ?? first.current, "stay")
  }, [load, copies.landed])

  useEffect(() => {
    list.current?.focus()
  }, [])

  useEffect(() => {
    document.getElementById(rowId(active))?.scrollIntoView({ block: "nearest" })
  }, [active])

  const entries = listing?.entries ?? []
  const chosen = [...selected].sort((a, b) => a - b).flatMap((i) => (entries[i] === undefined ? [] : [entries[i]]))
  const here = listing === null ? "" : folderName(listing)

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
  const refresh = (): void => void load(listing?.path ?? folder, "stay")
  const openEntry = (e: Entry | undefined): void => {
    if (e?.dir === true && listing !== null) go(`${listing.path.replace(/\\$/, "")}\\${e.name}`)
  }

  const copyOut = (): void => {
    if (listing !== null && chosen.length > 0) copies.copyOut(listing.path, chosen)
  }
  const copyIn = (): void => {
    pickFiles(t("files.pickTitle"))
      .then((paths) => {
        if (paths.length > 0) copies.copyIn(paths, listing?.path ?? folder)
      })
      .catch(() => undefined)
  }

  const moveTo = (i: number, extend: boolean): void => {
    if (entries.length === 0) return
    const next = Math.max(0, Math.min(entries.length - 1, i))
    setActive(next)
    const r = clickSelect(selected, anchor ?? active, next, { toggle: false, range: extend })
    setSelected(r.selected)
    setAnchor(extend ? r.anchor : next)
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const cmd = mod(e)
    if (e.key === "ArrowDown" && cmd) openEntry(entries[active])
    else if (e.key === "ArrowUp" && cmd) goUp()
    else if (e.key === "ArrowDown") moveTo(selected.size === 0 ? 0 : active + 1, e.shiftKey)
    else if (e.key === "ArrowUp") moveTo(selected.size === 0 ? 0 : active - 1, e.shiftKey)
    else if (e.key === "Home") moveTo(0, e.shiftKey)
    else if (e.key === "End") moveTo(entries.length - 1, e.shiftKey)
    else if (e.key === "Enter") openEntry(entries[active])
    else if (e.key === "a" && cmd) setSelected(new Set(entries.map((_, i) => i)))
    else if (e.key.length === 1 && !cmd && !e.altKey) {
      const now = Date.now()
      const text = (now - typed.current.at < 800 ? typed.current.text : "") + e.key
      typed.current = { text, at: now }
      const hit = findByPrefix(
        entries.map((x) => x.name),
        text,
        text.length === 1 ? active + 1 : active,
      )
      if (hit !== null) moveTo(hit, false)
    } else return
    e.preventDefault()
  }

  const onDialogKey = (e: KeyboardEvent<HTMLDialogElement>): void => {
    if (!mod(e)) return
    const k = e.key.toLowerCase()
    if (k === "[") goBack()
    else if (k === "]") goForward()
    else if (k === "r") refresh()
    else if (k === "l" || (k === "g" && e.shiftKey)) setDraft(listing?.path ?? "")
    else if (e.key === "ArrowUp" && e.target === e.currentTarget) goUp()
    else return
    e.preventDefault()
  }

  const job = copies.job
  const result = copies.result

  return (
    <dialog
      ref={dialog}
      className="files"
      aria-label={t("files.windowTitle", { title })}
      onKeyDown={onDialogKey}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === dialog.current) onClose()
      }}
    >
      <div className="files__bar">
        <div className="files__nav">
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
          // Like Explorer's address bar: a click beside the folder names edits the path.
          <nav
            className="files__crumbs"
            aria-label={t("files.path")}
            title={t("files.goToKeys")}
            onClick={(e) => {
              if (e.target === e.currentTarget) setDraft(listing?.path ?? "")
            }}
          >
            {crumbs(listing?.path ?? "").map((c, i, all) => (
              <span key={c.path} className="files__crumb">
                {i > 0 && (
                  <span className="files__sep" aria-hidden="true">
                    ›
                  </span>
                )}
                <button type="button" className="files__crumb-btn" aria-current={i === all.length - 1 ? "location" : undefined} onClick={() => go(c.path)}>
                  {c.name}
                </button>
              </span>
            ))}
          </nav>
        ) : (
          <form
            className="files__goto"
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
        <button type="button" className="btn btn--ghost btn--icon" aria-label={t("files.refresh")} title={t("files.refresh")} onClick={refresh}>
          <Icon name="refresh" />
        </button>
      </div>

      <div className="files__body">
        <nav className="files__places" aria-label={t("files.places")}>
          <ul>
            {(listing?.places ?? []).map((p, i, all) => (
              <li key={p.path} className={cx(p.kind === "drive" && all[i - 1]?.kind !== "drive" && "files__place--first-drive")}>
                <button
                  type="button"
                  className="files__place"
                  aria-current={listing?.path.toLowerCase() === p.path.toLowerCase() ? "location" : undefined}
                  title={p.path}
                  onClick={() => go(p.path)}
                >
                  <Icon name={PLACE_ICON[p.kind]} />
                  <span className="files__place-name">{placeName(p)}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className={cx("files__main", dropping && "files__main--drop")} aria-busy={loading}>
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
          <div className="files__table">
            <div className="files__head" aria-hidden="true">
              <span>{t("files.name")}</span>
              <span className="files__size">{t("files.size")}</span>
              <span className="files__date">{t("files.modified")}</span>
            </div>
            <div
              ref={list}
              className="files__list"
              role="listbox"
              aria-multiselectable="true"
              aria-label={here}
              aria-activedescendant={entries.length > 0 ? rowId(active) : undefined}
              tabIndex={0}
              onKeyDown={onListKey}
            >
              {listing !== null && entries.length === 0 && (
                <div className="files__empty">
                  <EmptyState compact title={t("files.empty")} />
                </div>
              )}
              {listing === null && failure === null && <p className="files__loading">{t("state.loading")}</p>}
              {entries.map((e, i) => (
                <div
                  key={e.name}
                  id={rowId(i)}
                  role="option"
                  aria-selected={selected.has(i)}
                  className={cx("files__row", i === active && "files__row--active")}
                  title={e.name}
                  onClick={(ev) => {
                    const r = clickSelect(selected, anchor, i, { toggle: mod(ev), range: ev.shiftKey })
                    setSelected(r.selected)
                    setAnchor(r.anchor)
                    setActive(i)
                  }}
                  onDoubleClick={() => openEntry(e)}
                >
                  <span className={cx("files__name", e.dir && "files__name--dir")}>
                    <Icon name={e.dir ? "folder" : "file"} />
                    <span className="files__label">{e.name}</span>
                  </span>
                  <span className="files__size">{e.size === null ? "" : formatBytes(e.size)}</span>
                  <span className="files__date">{e.modified === null ? "" : <When ms={e.modified} />}</span>
                </div>
              ))}
              {listing !== null && listing.total > entries.length && (
                <p className="files__more">{t("files.more", { shown: entries.length, total: listing.total })}</p>
              )}
            </div>
          </div>
          {dropping && (
            <div className="files__drop" aria-hidden="true">
              <p>{t("files.dropOn", { folder: here })}</p>
            </div>
          )}
        </div>
      </div>

      <div className="files__foot">
        <div className="files__status" role="status">
          {job !== null ? (
            <>
              <span className="files__progress" aria-hidden="true">
                <span style={{ width: `${String(Math.round((job.done / job.total) * 100))}%` }} />
              </span>
              <span className="files__status-text">
                {job.total > 1 ? t("files.copyingOf", { name: job.name, done: job.done + 1, total: job.total }) : t("files.copying", { name: job.name })}
              </span>
            </>
          ) : result?.ok === true ? (
            <>
              <Icon name="check" />
              <span className="files__status-text">{result.title}</span>
              {result.reveal !== undefined && (
                <Button size="sm" variant="ghost" onClick={() => void revealInFinder(result.reveal ?? "")}>
                  {t("files.reveal")}
                </Button>
              )}
            </>
          ) : (
            <span className="files__status-text files__hint">{here === "" ? "" : t("files.dropHint", { folder: here })}</span>
          )}
        </div>
        <div className="files__actions">
          <Button onClick={copyIn} disabled={listing === null}>
            {t("files.copyIn")}
          </Button>
          <Button variant="primary" onClick={copyOut} disabled={chosen.length === 0}>
            {t("files.copyOut")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t("files.done")}
          </Button>
        </div>
      </div>
    </dialog>
  )
}
