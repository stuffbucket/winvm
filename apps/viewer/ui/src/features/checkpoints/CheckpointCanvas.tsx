/**
 * Checkpoints: every checkpoint of a Windows machine on an infinite canvas,
 * as Time Machine shows backups. The window's own screen shrinks into the
 * "Now" card at the front, the checkpoints recede up the canvas a day at a
 * time, and the timeline on the right flies through them. Pinch, ⌘-scroll or
 * ⌘+ / ⌘− zoom; dragging, two-finger scrolling or the arrow keys pan; every
 * camera move eases in and out (and jumps, with reduced motion).
 *
 * A card selected comes up close with its notes, Go Back to This and
 * Delete…. New Checkpoint takes one and flies it out of Now into the stack.
 * Done (Esc) flies back into the live screen. Going back flies the chosen
 * checkpoint into the screen once Windows is back at that moment.
 *
 * The rules (layout, timeline, search, confirmations) are in checkpoints.ts;
 * the canvas and its camera are @winvm/canvas.
 */
import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  type Camera,
  CanvasGlyph,
  CanvasIconButton,
  cameraForScreenRect,
  centreOf,
  centreOn,
  clampCamera,
  clampZoom,
  editableTarget,
  fitRect,
  GLYPHS,
  type Rect,
  type Size,
  SpatialCanvas,
  SpatialCanvasCorner,
  SpatialCanvasFloatingPanel,
  SpatialCanvasLabel,
  SpatialCanvasNode,
  SpatialCanvasScene,
  SpatialCanvasSearchResult,
  SpatialCanvasSearchResults,
  type SpatialCanvasSurfacePhase,
  SpatialCanvasSurface,
  SpatialCanvasTopBar,
  SpatialCanvasViewport,
  SpatialCanvasZoomControls,
  rectsIntersect,
  useCanvasCamera,
  visibleWorld,
  wheelZoomFactor,
  zoomAround,
} from "@winvm/canvas"

import { outputText, winvm } from "../../backend"
import { Button } from "../../components/Button"
import { ConfirmDialog } from "../../components/ConfirmDialog"
import { t } from "../../i18n"
import { type Phase, parseNote, parseSaves } from "../../model"
import type { Ran } from "../winvm/useWinvm"
import {
  type Checkpoint,
  type CardBox,
  DAY_GAP,
  dayKey,
  dayNearest,
  deleteBlocked,
  frameOf,
  goBackConfirm,
  goBackSteps,
  isAutomatic,
  layoutTimeline,
  openingView,
  saveNameFor,
  searchCheckpoints,
  shownName,
  stepThrough,
  type Tick,
  type TimelineLayout,
  timelineTicks,
  union,
  withLabel,
} from "./checkpoints"
import { CheckpointCard, MONITOR, Picture, takenAt } from "./CheckpointCard"
import { CheckpointDetails, type NoteDraft, tagsOf } from "./CheckpointDetails"
import { LiveFrame } from "./LiveFrame"
import { forgetPictures } from "./pictures"
import { type CheckpointSettings, DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings"
import { Timeline } from "./Timeline"

export interface CheckpointCanvasProps {
  readonly instance: string
  /** What the person calls this Windows machine. */
  readonly machine: string
  readonly phase: Phase | null
  /** Something the main window started is running. */
  readonly busy: boolean
  /** The live screen's width over its height. */
  readonly aspect: number
  /** Where the live screen is in the window, to fly into and out of. */
  displayRect(): Rect | null
  /** noVNC's canvas, to show live in the Now card. */
  liveSource(): HTMLCanvasElement | null
  /** Runs `save` or `load` the way the main window does (its busy state, its failure callout). */
  run(verb: "save" | "load", arg: string): Promise<Ran | null>
  /** Bumped by the main window (⌘⇧T, the menu) to leave. */
  readonly closeRequest: number
  onClosed(): void
}

/** Room the details panel and the timeline take at the right, so a selected card centres in what is left. */
const PANEL_SPACE = 400
const TIMELINE_SPACE = 132
const PAN_STEP = 80
const ZOOM_STEP = 1.25
const ENTER_WAIT_MS = 450
/** Below this zoom, captions are too small to read: cards draw pictures only. */
const FAR_ZOOM = 0.42

type Confirm = { readonly kind: "go-back"; readonly name: string } | { readonly kind: "delete"; readonly name: string }

/** A day's date, in world units, smaller for older days, never under DAY_LABEL_MIN on screen. */
const DAY_LABEL = 24
const DAY_LABEL_MIN = 12
/** When the gap above a day is less than this on screen, there is no room for dates: only months are named. */
const DAY_LABEL_ROOM = 30

const viewSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight })

export function CheckpointCanvas(p: CheckpointCanvasProps): JSX.Element {
  const live = p.phase === "running" || p.phase === "paused"
  const [list, setList] = useState<Checkpoint[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [settings, setSettings] = useState<CheckpointSettings>(DEFAULT_SETTINGS)
  const [phase, setPhase] = useState<SpatialCanvasSurfacePhase>("entering")
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [activeResult, setActiveResult] = useState(0)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState("")
  const [working, setWorking] = useState<{ readonly on: string; readonly label: string } | null>(null)
  const [status, setStatus] = useState<{ readonly tone: "info" | "error"; readonly text: string } | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [arriving, setArriving] = useState<{ readonly name: string; readonly dx: number; readonly dy: number; readonly scale: number } | null>(null)
  const [leaving, setLeaving] = useState<string | null>(null)
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const [size, setSize] = useState(viewSize)
  const [panning, setPanning] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // Quick Look: the selected checkpoint's screenshot over everything.
  const [looking, setLooking] = useState(false)

  const viewport = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const props = useRef(p)
  props.current = p

  // ---- Data -------------------------------------------------------------

  /** Read the list again; `landing` sees it first, so what it sets is drawn in the same frame as the list. */
  const reload = useCallback(async (landing?: (got: Checkpoint[]) => void): Promise<Checkpoint[] | null> => {
    try {
      const out = await winvm("saves", "-i", props.current.instance, "--json")
      const got = parseSaves(out.stdout)
      if (got === null) {
        setListError(outputText(out) || t("checkpoints.listFailed"))
        setList((l) => l ?? [])
        return null
      }
      landing?.(got)
      setListError(null)
      setList(got)
      setNowMs(Date.now())
      return got
    } catch (e) {
      setListError(String(e))
      setList((l) => l ?? [])
      return null
    }
  }, [])

  useEffect(() => {
    void reload()
    loadSettings()
      .then(setSettings)
      .catch(() => undefined)
  }, [reload])

  useEffect(() => {
    const resize = (): void => setSize(viewSize())
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])

  const shown = useMemo(() => (list ?? []).filter((c) => settings.showAutomatic || !isAutomatic(c) || c.name === selected), [list, settings.showAutomatic, selected])
  const byName = useMemo(() => new Map((list ?? []).map((c) => [c.name, c])), [list])
  const layout = useMemo(() => layoutTimeline(shown, p.aspect), [shown, p.aspect])
  const ticks = useMemo(
    () => timelineTicks(layout.days, new Date(nowMs), { now: t("checkpoints.now"), today: t("checkpoints.today"), yesterday: t("checkpoints.yesterday") }),
    [layout.days, nowMs],
  )

  // ---- Camera -----------------------------------------------------------

  const content = useMemo<Rect>(() => {
    const b = layout.bounds
    return { x: b.x - 120, y: b.y - 120, width: b.width + 240, height: b.height + 240 }
  }, [layout.bounds])
  const limits = useMemo(() => {
    const fit = fitRect(content, size, 48).zoom
    return { min: Math.max(0.04, Math.min(0.3, fit * 0.85)), max: 3 }
  }, [content, size])

  const nowCamera = useCallback((): Camera => {
    const rect = props.current.displayRect()
    const frame = frameOf(layout.now)
    return rect === null || rect.width < 8 ? fitRect(frame, viewSize(), 0) : cameraForScreenRect(frame, rect)
  }, [layout.now])

  const cam = useCanvasCamera(nowCamera(), viewSize)
  const { fly: flyCamera, set: setCamera, current: cameraNow } = cam
  const camera = cam.camera
  // What the timeline (and, with a card selected, the details panel) cover on the right: the stack is kept in reach of the rest.
  const reserve = useRef(TIMELINE_SPACE)
  reserve.current = selected === null ? TIMELINE_SPACE : PANEL_SPACE + TIMELINE_SPACE
  const clamp = useCallback(
    (c: Camera, right: number = reserve.current): Camera =>
      clampCamera(c, content, { width: Math.max(320, viewSize().width - right), height: viewSize().height }, 96, limits),
    [content, limits],
  )

  /** Centred in the part of the window the panel and timeline leave free. */
  const centreIn = (world: { x: number; y: number }, zoom: number, reserve: number): Camera => {
    const c = centreOn(world, zoom, viewSize())
    return { ...c, x: c.x - reserve / 2 }
  }

  const overview = useCallback((): Camera => {
    const view = openingView(layout)
    const fit = fitRect(view, { width: viewSize().width - TIMELINE_SPACE, height: viewSize().height }, 72, limits)
    const zoom = clampZoom(Math.min(1.1, settings.zoom ?? fit.zoom), limits)
    return clamp(centreIn({ x: view.x + view.width / 2, y: view.y + view.height / 2 }, zoom, TIMELINE_SPACE), TIMELINE_SPACE)
  }, [layout, limits, settings.zoom, clamp])

  const focusOn = useCallback(
    (box: Rect): Camera => {
      const v = viewSize()
      const free = Math.max(320, v.width - PANEL_SPACE - TIMELINE_SPACE)
      // Up close, but with its neighbours still in sight: about 380 px wide on screen.
      const zoom = clampZoom(Math.min(Math.min(free * 0.55, 380) / box.width, (v.height * 0.55) / box.height), limits)
      return centreIn({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, zoom, PANEL_SPACE + TIMELINE_SPACE)
    },
    [limits],
  )

  // In: the screen becomes the Now card, the view pulls back to show the newest checkpoints.
  const entered = useRef(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPhase("open"))
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    if (entered.current) return
    const go = (): void => {
      if (entered.current) return
      entered.current = true
      void flyCamera(overview(), { duration: 760 })
    }
    if (list !== null) {
      go()
      return
    }
    const timer = setTimeout(go, ENTER_WAIT_MS)
    return () => clearTimeout(timer)
  }, [list, overview, flyCamera])

  // Out: back into the live screen, or the chosen checkpoint into it.
  const leavingNow = useRef(false)
  const leave = useCallback(
    async (into?: Rect): Promise<void> => {
      if (leavingNow.current) return
      leavingNow.current = true
      setSelected(null)
      setSearchOpen(false)
      if (selected === null) void saveSettings({ ...settings, zoom: cameraNow().zoom })
      setPhase("leaving")
      const rect = props.current.displayRect()
      const target = into !== undefined && rect !== null ? cameraForScreenRect(into, rect) : nowCamera()
      await flyCamera(target, { duration: 620 })
      props.current.onClosed()
    },
    [flyCamera, cameraNow, nowCamera, selected, settings],
  )

  const closeRequest = useRef(p.closeRequest)
  useEffect(() => {
    if (p.closeRequest !== closeRequest.current) {
      closeRequest.current = p.closeRequest
      void leave()
    }
  }, [p.closeRequest, leave])

  const fly = useCallback(
    (to: Camera, duration?: number, right?: number) => void flyCamera(clamp(to, right), duration === undefined ? {} : { duration }),
    [flyCamera, clamp],
  )

  const select = useCallback(
    (name: string | null) => {
      setSelected(name)
      setNoteState("idle")
      if (name === null) return
      const box = layout.cards.get(name)
      if (box !== undefined) fly(focusOn(box), undefined, PANEL_SPACE + TIMELINE_SPACE)
    },
    [layout.cards, fly, focusOn],
  )

  const zoomBy = (factor: number, anchor?: { x: number; y: number }): void => {
    const v = viewSize()
    fly(zoomAround(cameraNow(), factor, anchor ?? { x: v.width / 2, y: v.height / 2 }, limits), 260)
  }
  const fitAll = (): void => fly(fitRect(layout.bounds, { width: viewSize().width - TIMELINE_SPACE, height: viewSize().height }, 72, limits))

  // ---- Pointer, wheel and pinch -----------------------------------------

  const press = useRef<{ id: number; x: number; y: number; from: Camera; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  const pointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if ((e.button !== 0 && e.button !== 1) || editableTarget(e.target)) return
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: cameraNow(), moved: false }
  }
  const pointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const pr = press.current
    if (pr === null || pr.id !== e.pointerId) return
    const dx = e.clientX - pr.x
    const dy = e.clientY - pr.y
    if (!pr.moved) {
      if (Math.hypot(dx, dy) < 4) return
      pr.moved = true
      setPanning(true)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    setCamera(clamp({ ...pr.from, x: pr.from.x + dx, y: pr.from.y + dy }))
  }
  const pointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const pr = press.current
    if (pr === null || pr.id !== e.pointerId) return
    press.current = null
    if (pr.moved) {
      setPanning(false)
      suppressClick.current = true
      setTimeout(() => {
        suppressClick.current = false
      }, 0)
    } else if (e.target === e.currentTarget) {
      // A click on empty canvas lets go of the selection.
      select(null)
    }
  }

  const onSelectCard = useCallback(
    (name: string) => {
      if (suppressClick.current) return
      select(name)
    },
    [select],
  )

  // Wheel and pinch need non-passive listeners to keep the page from scrolling or zooming itself.
  const wheelState = useRef({ clamp, limits })
  wheelState.current = { clamp, limits }
  useEffect(() => {
    const el = viewport.current
    if (el === null) return
    const wheel = (e: WheelEvent): void => {
      e.preventDefault()
      const { clamp: c, limits: l } = wheelState.current
      const r = el.getBoundingClientRect()
      const lines = e.deltaMode === 1 ? 16 : 1
      if (e.ctrlKey || e.metaKey) {
        setCamera(c(zoomAround(cameraNow(), wheelZoomFactor(e.deltaY * lines), { x: e.clientX - r.left, y: e.clientY - r.top }, l)))
        return
      }
      const now = cameraNow()
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX
      const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY
      setCamera(c({ ...now, x: now.x - dx * lines, y: now.y - dy * lines }))
    }
    // WebKit's own pinch: gesture events, with the scale since the pinch began.
    let pinchFrom: Camera | null = null
    const gestureStart = (e: Event): void => {
      e.preventDefault()
      pinchFrom = cameraNow()
    }
    const gestureChange = (e: Event): void => {
      e.preventDefault()
      const g = e as Event & { scale?: number; clientX?: number; clientY?: number }
      if (pinchFrom === null || g.scale === undefined) return
      const r = el.getBoundingClientRect()
      const { clamp: c, limits: l } = wheelState.current
      setCamera(c(zoomAround(pinchFrom, g.scale, { x: (g.clientX ?? r.width / 2) - r.left, y: (g.clientY ?? r.height / 2) - r.top }, l)))
    }
    el.addEventListener("wheel", wheel, { passive: false })
    el.addEventListener("gesturestart", gestureStart)
    el.addEventListener("gesturechange", gestureChange)
    return () => {
      el.removeEventListener("wheel", wheel)
      el.removeEventListener("gesturestart", gestureStart)
      el.removeEventListener("gesturechange", gestureChange)
    }
  }, [setCamera, cameraNow])

  // ---- Search -----------------------------------------------------------

  const dateWords = useCallback((c: Checkpoint) => takenAt(c, nowMs), [nowMs])
  const results = useMemo(() => searchCheckpoints(list ?? [], query, dateWords), [list, query, dateWords])
  const matches = useMemo(() => (query.trim() === "" ? null : new Set(results.map((c) => c.name))), [results, query])
  const pickResult = (c: Checkpoint): void => {
    searchInput.current?.blur()
    if (!settings.showAutomatic && isAutomatic(c)) {
      // A hidden autosave found by search: show automatic ones so it has a place to fly to.
      setSettings((s) => ({ ...s, showAutomatic: true }))
    }
    setSearchOpen(false)
    // The layout may change with the setting; select once it has.
    setTimeout(() => select(c.name), 0)
  }

  // ---- Timeline ---------------------------------------------------------

  const centre = centreOf(camera, size)
  const nearest = dayNearest(layout, { x: centre.x, y: centre.y })
  const activeTick = nearest === null ? "now" : (layout.days[nearest]?.key ?? "now")
  const dayCamera = (tick: Tick): Camera => {
    if (tick.day === null) return overview()
    const d = layout.days[tick.day]
    if (d === undefined) return overview()
    const block = withLabel(d)
    const fit = fitRect(block, { width: viewSize().width - TIMELINE_SPACE, height: viewSize().height }, 96, limits)
    const zoom = clampZoom(Math.min(fit.zoom, Math.max(cameraNow().zoom, 0.55)), limits)
    return centreIn({ x: block.x + block.width / 2, y: block.y + block.height / 2 }, zoom, TIMELINE_SPACE)
  }
  const step = (direction: -1 | 1): void => {
    const next = stepThrough(layout.order, selected, direction)
    if (next === null) {
      select(null)
      fly(overview())
    } else select(next)
  }

  // ---- Actions ----------------------------------------------------------

  const taken = useMemo(() => new Set((list ?? []).map((c) => c.name)), [list])

  const writeTitle = async (name: string, title: string): Promise<void> => {
    if (title.trim() === "" || title.trim() === name) return
    await winvm("saves", "note", "-i", props.current.instance, name, `--title=${title.trim()}`, "--json").catch(() => undefined)
  }

  /** Take a checkpoint of now; resolves with its name, or null when it failed (and says why). */
  const takeCheckpoint = async (title: string, label: string): Promise<string | null> => {
    const name = saveNameFor(title, taken, new Date())
    setWorking({ on: "now", label })
    // Watch it happen: Now, and today's checkpoints above it, where the new one will land.
    setSelected(null)
    const today = layout.days.at(-1)
    const isToday = today !== undefined && today.key === dayKey(new Date())
    void flyCamera(clamp(fitRect(union([layout.now, ...(isToday ? [withLabel(today)] : [])]), { width: viewSize().width - TIMELINE_SPACE, height: viewSize().height }, 96, limits), TIMELINE_SPACE))
    setStatus(null)
    try {
      const ran = await props.current.run("save", name)
      if (ran === null || ran.code !== 0) {
        setStatus({ tone: "error", text: ran?.output || t("checkpoints.saveFailed") })
        return null
      }
      await writeTitle(name, title)
      const before = new Set(taken)
      // The new card flies out of Now into its place: set up in the same frame it first appears.
      let landed: TimelineLayout | null = null
      await reload((got) => {
        if (!got.some((c) => c.name === name) || before.has(name)) return
        const after = layoutTimeline(
          got.filter((c) => settings.showAutomatic || !isAutomatic(c)),
          props.current.aspect,
        )
        const box = after.cards.get(name)
        if (box === undefined) return
        landed = after
        setArriving({ name, dx: after.now.x - box.x, dy: after.now.y - box.y, scale: after.now.width / box.width })
        setTimeout(() => setArriving((a) => (a?.name === name ? null : a)), 1100)
      })
      const after = landed as TimelineLayout | null
      const today = after?.days.at(-1)
      if (after !== null) void flyCamera(clamp(fitRect(union([after.now, ...(today === undefined ? [] : [withLabel(today)])]), { width: viewSize().width - TIMELINE_SPACE, height: viewSize().height }, 96, limits), TIMELINE_SPACE))
      return name
    } finally {
      setWorking(null)
    }
  }

  const submitNew = (): void => {
    const title = newTitle.trim()
    setCreating(false)
    setNewTitle("")
    void takeCheckpoint(title, t("checkpoints.taking"))
  }

  const goBack = async (name: string, saveFirst: boolean): Promise<void> => {
    setConfirm(null)
    const target = byName.get(name)
    const steps = goBackSteps(name, saveFirst, {
      live,
      now: new Date(),
      taken,
      keepTitle: t("checkpoints.keepTitle", { name: target === undefined ? name : shownName(target) }),
    })
    for (const s of steps) {
      if (s.verb === "save") {
        const made = await takeCheckpoint(s.title ?? "", t("checkpoints.keeping"))
        if (made === null) return
        continue
      }
      setWorking({ on: name, label: t("checkpoints.goingBack") })
      setStatus(null)
      const ran = await props.current.run("load", s.name)
      setWorking(null)
      if (ran === null || ran.code !== 0) {
        setStatus({ tone: "error", text: ran?.output || t("checkpoints.loadFailed") })
        await reload()
        return
      }
      const box = layout.cards.get(name)
      void leave(box === undefined ? undefined : frameOf(box))
    }
  }

  const remove = async (name: string): Promise<void> => {
    setConfirm(null)
    const c = byName.get(name)
    setWorking({ on: name, label: t("checkpoints.deleting") })
    try {
      const out = await winvm("saves", "-i", props.current.instance, "rm", name)
      if (out.code !== 0) {
        setStatus({ tone: "error", text: outputText(out) || t("checkpoints.deleteFailed") })
        return
      }
      setLeaving(name)
      if (selected === name) setSelected(null)
      await new Promise((r) => setTimeout(r, 260))
      if (c !== undefined) forgetPictures([c.thumbnail, c.screenshot])
      await reload()
      setStatus({ tone: "info", text: t("checkpoints.deleted", { name: c === undefined ? name : shownName(c) }) })
    } catch (e) {
      setStatus({ tone: "error", text: String(e) })
    } finally {
      setLeaving(null)
      setWorking(null)
    }
  }

  // Notes are written one at a time, in order, so a fast typist's last word wins.
  const noteQueue = useRef<Promise<void>>(Promise.resolve())
  const writeNote = (name: string, d: NoteDraft): void => {
    setNoteState("saving")
    // A note that is just "-" would read standard input; nobody means that.
    const text = d.text.trim() === "-" ? `${d.text} ` : d.text
    noteQueue.current = noteQueue.current.then(async () => {
      try {
        const out = await winvm("saves", "note", "-i", props.current.instance, name, `--title=${d.title.trim()}`, `--text=${text}`, `--tags=${tagsOf(d.tags).join(",")}`, "--json")
        const note = parseNote(out.stdout)
        if (out.code !== 0 || note === undefined) {
          setNoteState("failed")
          return
        }
        setList((l) => l?.map((c) => (c.name === name ? { ...c, notes: note, title: note?.title ?? null } : c)) ?? l)
        setNoteState("saved")
      } catch {
        setNoteState("failed")
      }
    })
  }

  const toggleAutomatic = (): void => {
    setSettings((s) => {
      const next = { ...s, showAutomatic: !s.showAutomatic }
      void saveSettings(next)
      return next
    })
  }

  // ---- Keys -------------------------------------------------------------

  // On the window, not the surface: keys still work when focus has fallen to the page (after a confirmation closes).
  const onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target instanceof Element ? e.target : document.body
    if (target.closest("dialog") !== null || e.defaultPrevented) return
    const cmd = e.metaKey || e.ctrlKey
    if (e.key === "Escape") {
      e.preventDefault()
      if (editableTarget(e.target)) {
        if (target === searchInput.current && query !== "") setQuery("")
        else (e.target as HTMLElement).blur()
        setSearchOpen(false)
        return
      }
      if (looking) setLooking(false)
      else if (creating) setCreating(false)
      else if (searchOpen) setSearchOpen(false)
      else if (selected !== null) select(null)
      else void leave()
      return
    }
    if (cmd && e.key.toLowerCase() === "f") {
      e.preventDefault()
      setSearchOpen(true)
      searchInput.current?.focus()
      searchInput.current?.select()
      return
    }
    if (editableTarget(e.target)) return
    if (cmd && (e.key === "=" || e.key === "+")) {
      e.preventDefault()
      zoomBy(ZOOM_STEP)
    } else if (cmd && e.key === "-") {
      e.preventDefault()
      zoomBy(1 / ZOOM_STEP)
    } else if (cmd && e.key === "0") {
      e.preventDefault()
      fitAll()
    } else if (cmd && e.key === "ArrowUp") {
      e.preventDefault()
      step(-1)
    } else if (cmd && e.key === "ArrowDown") {
      e.preventDefault()
      step(1)
    } else if (cmd && e.key === "Backspace" && selected !== null) {
      e.preventDefault()
      const c = byName.get(selected)
      if (c !== undefined && deleteBlocked(c) === null) setConfirm({ kind: "delete", name: selected })
    } else if (!cmd && e.key.startsWith("Arrow")) {
      e.preventDefault()
      const d = (e.shiftKey ? 4 : 1) * PAN_STEP
      const now = cameraNow()
      const dx = e.key === "ArrowLeft" ? d : e.key === "ArrowRight" ? -d : 0
      const dy = e.key === "ArrowUp" ? d : e.key === "ArrowDown" ? -d : 0
      fly({ ...now, x: now.x + dx, y: now.y + dy }, 180)
    } else if (!cmd && e.key === " " && selected !== null) {
      // Quick Look, as in Finder: the screenshot, as big as the window allows.
      e.preventDefault()
      setLooking((l) => !l)
    } else if (!cmd && (e.key === "+" || e.key === "=")) {
      zoomBy(ZOOM_STEP)
    } else if (!cmd && e.key === "-") {
      zoomBy(1 / ZOOM_STEP)
    }
  }

  const keys = useRef(onKeyDown)
  keys.current = onKeyDown
  useEffect(() => {
    const handle = (e: KeyboardEvent): void => keys.current(e)
    window.addEventListener("keydown", handle)
    return () => window.removeEventListener("keydown", handle)
  }, [])

  // ---- Drawing ----------------------------------------------------------

  const seen = visibleWorld(camera, size, 360)
  const far = camera.zoom < FAR_ZOOM
  const selectedCheckpoint = selected === null ? undefined : byName.get(selected)
  const busy = p.busy || working !== null
  const confirming = confirm === null ? undefined : byName.get(confirm.name)
  const goBackCopy = goBackConfirm({ live })
  const nowWorking = working?.on === "now" ? working.label : null

  return (
    <SpatialCanvasSurface
      open
      title={t("checkpoints.title", { machine: p.machine })}
      description={t("checkpoints.description")}
      phase={phase}
      className="checkpoints"
    >
      <div className="checkpoints__backdrop" aria-hidden="true">
        {live && <LiveFrame source={p.liveSource} className="checkpoints__backdrop-screen" interval={400} maxWidth={640} />}
      </div>
      <SpatialCanvas className="checkpoints__canvas">
        <div className="checkpoints__drag" data-tauri-drag-region aria-hidden="true" />
        <SpatialCanvasViewport
          ref={viewport}
          camera={camera}
          tool="select"
          data-panning={panning}
          data-far={far}
          tabIndex={0}
          aria-label={t("checkpoints.canvas")}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
        >
          <SpatialCanvasScene {...camera}>
            {layout.days.map((d, i) => {
              if (!rectsIntersect(withLabel(d), seen)) return null
              const tick = ticks[i]
              // Too far away for a date over every day: the months, beside the stack, are enough.
              const near = DAY_GAP * d.scale * camera.zoom >= DAY_LABEL_ROOM
              if (!near && tick?.month == null) return null
              return (
                <SpatialCanvasLabel key={d.key} x={near ? d.label.x : d.x - 24 * d.scale} y={near ? d.label.y : d.y + d.height / 2} className="checkpoints__day" data-far={!near}>
                  <span style={{ fontSize: `${String(Math.max(near ? DAY_LABEL * d.scale : 0, DAY_LABEL_MIN / camera.zoom))}px` }}>{near ? (tick?.label ?? d.key) : tick?.month}</span>
                </SpatialCanvasLabel>
              )
            })}
            {shown.map((c) => {
              const box: CardBox | undefined = layout.cards.get(c.name)
              if (box === undefined || !rectsIntersect(box, seen)) return null
              return (
                <CheckpointCard
                  key={`${c.name}#${c.createdAt}`}
                  c={c}
                  box={box}
                  selected={c.name === selected}
                  screenWidth={box.width * camera.zoom}
                  now={nowMs}
                  dimmed={searchOpen && matches !== null && !matches.has(c.name)}
                  arriving={arriving?.name === c.name ? arriving : null}
                  leaving={leaving === c.name}
                  working={working?.on === c.name ? working.label : null}
                  onSelect={onSelectCard}
                />
              )
            })}
            <SpatialCanvasNode x={layout.now.x} y={layout.now.y} width={layout.now.width} height={layout.now.height} className="checkpoint checkpoint--now" data-live={live}>
              <button type="button" className="checkpoint__hit" aria-label={t("checkpoints.nowLabel", { machine: p.machine })} onClick={() => !suppressClick.current && void leave()}>
                <span className="checkpoint__frame" style={{ height: layout.now.frame }}>
                  <span className="checkpoint__placeholder">
                    {MONITOR}
                    <span>{t(live ? "checkpoints.nowLive" : `checkpoints.nowState.${p.phase ?? "missing"}`)}</span>
                  </span>
                  {live && <LiveFrame source={p.liveSource} className="checkpoint__live" />}
                  {nowWorking !== null && <span className="checkpoint__working">{nowWorking}</span>}
                </span>
                <span className="checkpoint__caption">
                  <span className="checkpoint__title">
                    <span className="checkpoint__name">{t("checkpoints.now")}</span>
                  </span>
                  <span className="checkpoint__when">{p.machine}</span>
                </span>
              </button>
            </SpatialCanvasNode>
          </SpatialCanvasScene>
        </SpatialCanvasViewport>

        <SpatialCanvasTopBar>
          <SpatialCanvasCorner className="checkpoints__heading">
            <strong>{t("checkpoints.heading")}</strong>
            <span>{list === null ? t("state.loading") : t("checkpoints.count", { count: list.length, machine: p.machine })}</span>
          </SpatialCanvasCorner>
          <SpatialCanvasCorner className="checkpoints__actions">
            <label className="checkpoints__search">
              <CanvasGlyph>{GLYPHS.search}</CanvasGlyph>
              <input
                ref={searchInput}
                type="search"
                value={query}
                placeholder={t("checkpoints.searchPlaceholder")}
                aria-label={t("checkpoints.search")}
                aria-controls="checkpoint-results"
                autoComplete="off"
                spellCheck={false}
                onFocus={() => setSearchOpen(true)}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActiveResult(0)
                  setSearchOpen(true)
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault()
                    setActiveResult((i) => Math.max(0, Math.min(results.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))))
                  } else if (e.key === "Enter") {
                    const c = results[activeResult]
                    if (c !== undefined) pickResult(c)
                  }
                }}
              />
            </label>
            <button type="button" className="spatial-canvas__button" aria-pressed={settings.showAutomatic} title={t("checkpoints.automaticTip")} onClick={toggleAutomatic}>
              {t("checkpoints.automatic")}
            </button>
            <span className="checkpoints__divider" aria-hidden="true" />
            <Button
              size="sm"
              variant="secondary"
              disabled={!live || busy}
              title={live ? t("checkpoints.newTip") : t("checkpoints.needsRunning")}
              aria-expanded={creating}
              onClick={() => setCreating((o) => !o)}
            >
              {t("checkpoints.new")}
            </Button>
            <Button size="sm" variant="primary" title={t("checkpoints.doneTip")} onClick={() => void leave()}>
              {t("checkpoints.done")}
            </Button>
          </SpatialCanvasCorner>
        </SpatialCanvasTopBar>

        {searchOpen && query.trim() !== "" && (
          <SpatialCanvasFloatingPanel label={t("checkpoints.results")} className="checkpoints__results">
            <SpatialCanvasSearchResults label={t("checkpoints.results")} emptyMessage={t("checkpoints.noMatches")}>
              {results.slice(0, 50).map((c, i) => (
                <SpatialCanvasSearchResult
                  key={c.name}
                  id={i === activeResult ? "checkpoint-result-active" : undefined}
                  title={shownName(c)}
                  description={takenAt(c, nowMs)}
                  active={i === activeResult}
                  onSelect={() => pickResult(c)}
                />
              ))}
            </SpatialCanvasSearchResults>
          </SpatialCanvasFloatingPanel>
        )}

        {creating && (
          <SpatialCanvasFloatingPanel label={t("checkpoints.new")} className="checkpoints__new">
            <form
              onSubmit={(e) => {
                e.preventDefault()
                submitNew()
              }}
            >
              <label className="checkpoint-details__label" htmlFor="checkpoint-new-title">
                {t("checkpoints.newName")}
              </label>
              <input
                id="checkpoint-new-title"
                className="input"
                autoFocus
                value={newTitle}
                placeholder={t("checkpoints.newPlaceholder")}
                autoComplete="off"
                maxLength={120}
                onChange={(e) => setNewTitle(e.target.value)}
              />
              <p className="checkpoints__hint">{t("checkpoints.newHint")}</p>
              <div className="checkpoints__new-actions">
                <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                  {t("confirm.cancel")}
                </Button>
                <Button size="sm" variant="primary" type="submit" disabled={!live || busy}>
                  {t("checkpoints.take")}
                </Button>
              </div>
            </form>
          </SpatialCanvasFloatingPanel>
        )}

        <Timeline
          ticks={ticks}
          active={activeTick}
          onPick={(tick) => fly(dayCamera(tick))}
          onScrub={(tick) => fly(dayCamera(tick), 200)}
          onOlder={() => step(-1)}
          onNewer={() => step(1)}
          canOlder={layout.order.length > 0 && (selected === null || layout.order[0] !== selected)}
          canNewer={selected !== null}
        />

        <div className="checkpoints__zoom">
          <SpatialCanvasZoomControls
            zoom={camera.zoom}
            labels={{ group: t("checkpoints.zoom"), zoomOut: t("checkpoints.zoomOut"), zoomIn: t("checkpoints.zoomIn"), reset: t("checkpoints.fitAll") }}
            onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
            onReset={fitAll}
            onZoomIn={() => zoomBy(ZOOM_STEP)}
          />
          <CanvasIconButton label={t("checkpoints.toNow")} onClick={() => fly(overview())}>
            <CanvasGlyph>
              <path d="M12 7v5l4 2" />
              <circle cx="12" cy="12" r="10" />
            </CanvasGlyph>
          </CanvasIconButton>
        </div>

        {(status !== null || listError !== null || (list !== null && list.length === 0)) && (
          <div className="checkpoints__status" role="status" data-tone={status?.tone ?? (listError !== null ? "error" : "info")}>
            <span>{status?.text ?? listError ?? t(live ? "checkpoints.emptyLive" : "checkpoints.empty")}</span>
            {status !== null && (
              <CanvasIconButton label={t("action.dismiss")} onClick={() => setStatus(null)}>
                <CanvasGlyph>{GLYPHS.close}</CanvasGlyph>
              </CanvasIconButton>
            )}
          </div>
        )}

        {selectedCheckpoint !== undefined && (
          <CheckpointDetails
            c={selectedCheckpoint}
            now={nowMs}
            busy={busy}
            saving={noteState}
            onClose={() => select(null)}
            onLook={() => setLooking(true)}
            onNote={(d) => writeNote(selectedCheckpoint.name, d)}
            onGoBack={() => setConfirm({ kind: "go-back", name: selectedCheckpoint.name })}
            onDelete={() => setConfirm({ kind: "delete", name: selectedCheckpoint.name })}
          />
        )}
      </SpatialCanvas>

      {looking && selectedCheckpoint !== undefined && (
        <div className="checkpoints__look" role="dialog" aria-label={t("checkpoints.look", { name: shownName(selectedCheckpoint) })} onClick={() => setLooking(false)}>
          <Picture c={selectedCheckpoint} sharp wanted />
          <p>
            <strong>{shownName(selectedCheckpoint)}</strong> {takenAt(selectedCheckpoint, nowMs)}
          </p>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === null
            ? ""
            : t(confirm.kind === "go-back" ? "checkpoints.goBack.title" : "checkpoints.delete.title", { name: confirming === undefined ? confirm.name : shownName(confirming) })
        }
        body={
          confirm === null ? (
            ""
          ) : confirm.kind === "go-back" ? (
            <p>{t(goBackCopy.body, { machine: p.machine })}</p>
          ) : (
            <p>{t("checkpoints.delete.body")}</p>
          )
        }
        confirmLabel={confirm?.kind === "delete" ? t("checkpoints.delete.confirm") : t("checkpoints.goBack.confirm")}
        cancelLabel={t("confirm.cancel")}
        tone={confirm?.kind === "delete" ? "danger" : "default"}
        {...(confirm?.kind === "go-back" && goBackCopy.offerSaveFirst
          ? { secondaryLabel: t("checkpoints.goBack.saveFirst"), onSecondary: () => void goBack(confirm.name, true) }
          : {})}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm === null) return
          if (confirm.kind === "delete") void remove(confirm.name)
          else void goBack(confirm.name, false)
        }}
      />
    </SpatialCanvasSurface>
  )
}
