import {
  type Camera,
  CanvasGlyph,
  CanvasIconButton,
  centreOf,
  centreOn,
  clampCamera,
  clampZoom,
  editableTarget,
  fitRect,
  GLYPHS,
  type Rect,
  rectsIntersect,
  type Size,
  SpatialCanvas,
  SpatialCanvasFloatingPanel,
  SpatialCanvasLabel,
  SpatialCanvasNode,
  SpatialCanvasScene,
  SpatialCanvasSearchResult,
  SpatialCanvasSearchResults,
  SpatialCanvasSurface,
  type SpatialCanvasSurfacePhase,
  SpatialCanvasViewport,
  useCanvasCamera,
  visibleWorld,
  wheelZoomFactor,
  zoomAround,
} from "@winvm/canvas"
import {
  type CSSProperties,
  type JSX,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { outputText, showCheckpointInFinder, winvm } from "../../backend"
import { ConfirmDialog } from "../../components/ConfirmDialog"
import { t } from "../../i18n"
import { type Phase, parseNote, parseSaves } from "../../model"
import {
  checkpointLayout,
  motion,
  ms,
  px,
  rem,
  spacing,
  text,
} from "../../styles/theme"
import type { Ran, RunOptions } from "../winvm/useWinvm"
import { CheckpointCard, takenAt, textScale } from "./CheckpointCard"
import {
  CheckpointDetailsLayer,
  type NoteDraft,
  tagsOf,
} from "./CheckpointDetails"
import { CheckpointLook } from "./CheckpointLook"
import { ControlBar } from "./ControlBar"
import {
  CAPTION_ROOM,
  type CardBox,
  type Checkpoint,
  type CheckpointFormat,
  DAY_GAP,
  dayGroup,
  dayKey,
  dayNearest,
  deleteBlocked,
  frameOf,
  goBackConfirm,
  goBackSteps,
  isAutomatic,
  layoutTimeline,
  type Moves,
  openingView,
  placeCards,
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
import { LiveFrame } from "./LiveFrame"
import { NewCheckpointForm } from "./NewCheckpoint"
import { forgetPictures } from "./pictures"
import { checkpointPresentation } from "./presentation"
import { SectionDraft, SectionGrid, SectionView } from "./Section"
import {
  type Arrangement,
  centreOfCard,
  dropCard,
  GRID,
  looseNames,
  normalizeSections,
  placeMembers,
  readingOrder,
  sectionAt,
  sectionRect,
} from "./sections"
import {
  type CheckpointSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "./settings"
import { Timeline } from "./Timeline"
import { type SectionsHost, useSections, withCaption } from "./useSections"
import { Wallpaper } from "./Wallpaper"
import { ZoomControl } from "./ZoomControl"

export interface CheckpointCanvasProps {
  readonly instance: string
  readonly machine: string
  readonly phase: Phase | null
  readonly busy: boolean
  readonly aspect: number
  liveSource: () => HTMLCanvasElement | null
  run: (
    verb: "save" | "load",
    arg: string,
    options?: RunOptions,
  ) => Promise<Ran | null>
  readonly closeRequest: number
  onClosed: () => void
}

const PANEL_WIDTH = px(checkpointLayout.panel)
const PANEL_MIN = px(checkpointLayout.panelMin)
const TIMELINE_SPACE = px(checkpointLayout.timelineSpace)
const CANVAS_MIN = px(checkpointLayout.canvasMin)
const BAR_SPACE = 88
const READABLE_FIT = 0.4
const PAN_STEP = 80
const NUDGE_STEP = px(spacing[4])
const ZOOM_STEP = 1.25
const ENTER_WAIT_MS = 450
const SURFACE_FADE_MS = ms(motion.duration.xl)
const LEAVE_SLACK_MS = 40
const LEAVE_WAIT_MS = ms(motion.duration["2xl"]) + LEAVE_SLACK_MS
const ARRIVE_SLACK_MS = 200
const ARRIVE_WAIT_MS = ms(motion.duration["4xl"]) + ARRIVE_SLACK_MS
const surfaceFadeMs = (): number =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0
    : SURFACE_FADE_MS
const FAR_ZOOM = 0.3
const NOW_TEXT = 1.25

type Confirm =
  | { readonly kind: "go-back"; readonly name: string }
  | { readonly kind: "delete"; readonly name: string }

const DAY_LABEL = rem(text.xl)
const DAY_LABEL_MIN = rem(text.xs)
const DAY_LABEL_ROOM = 30

const viewSize = (): Size => ({
  width: window.innerWidth,
  height: window.innerHeight,
})
const panelSpace = (): number =>
  Math.max(
    PANEL_MIN,
    Math.min(PANEL_WIDTH, viewSize().width - TIMELINE_SPACE - CANVAS_MIN),
  )

export function CheckpointCanvas(p: CheckpointCanvasProps): JSX.Element {
  const live = p.phase === "running" || p.phase === "paused"
  const [list, setList] = useState<Checkpoint[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [settings, setSettings] = useState<CheckpointSettings>(DEFAULT_SETTINGS)
  const [phase, setPhase] = useState<SpatialCanvasSurfacePhase>("entering")
  const [presented, setPresented] = useState(false)
  const [surfaceReady, setSurfaceReady] = useState(false)
  const finishLeaving = useRef<(() => void) | null>(null)
  useEffect(() => {
    let mounted = true
    void checkpointPresentation
      .set(true)
      .catch((error: unknown) => {
        console.warn("opening checkpoint fullscreen failed", error)
      })
      .then(() => {
        if (mounted) {
          setSize(viewSize())
          setPresented(true)
        }
      })
    return () => {
      mounted = false
      finishLeaving.current?.()
      void checkpointPresentation.set(false).catch((error: unknown) => {
        console.warn("restoring the checkpoint window failed", error)
      })
    }
  }, [])
  const [selected, setSelectedState] = useState<string | null>(null)
  const leftSpace = useRef(0)
  const setSelected = useCallback((name: string | null) => {
    leftSpace.current = name === null ? 0 : panelSpace()
    setSelectedState(name)
  }, [])
  const [query, setQuery] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [autoHint, setAutoHint] = useState(false)
  const [hoverDay, setHoverDay] = useState<string | null>(null)
  const [activeResult, setActiveResult] = useState(0)
  const [creating, setCreating] = useState(false)
  const [working, setWorking] = useState<{
    readonly on: string
    readonly label: string
  } | null>(null)
  const [status, setStatus] = useState<{
    readonly tone: "info" | "error"
    readonly text: string
  } | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [arriving, setArriving] = useState<{
    readonly name: string
    readonly dx: number
    readonly dy: number
    readonly scale: number
  } | null>(null)
  const [leaving, setLeaving] = useState<string | null>(null)
  const [noteState, setNoteState] = useState<
    "idle" | "saving" | "saved" | "failed"
  >("idle")
  const [size, setSize] = useState(viewSize)
  const [panning, setPanning] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [looking, setLooking] = useState(false)
  const [lookOpener, setLookOpener] = useState<HTMLElement | null>(null)

  const viewport = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const props = useRef(p)
  props.current = p

  const reload = useCallback(
    async (
      landing?: (got: Checkpoint[]) => void,
    ): Promise<Checkpoint[] | null> => {
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
    },
    [],
  )

  useEffect(() => {
    void reload()
    loadSettings()
      .then(setSettings)
      .catch(() => undefined)
  }, [reload])

  useEffect(() => {
    const resize = (): void => {
      setSize(viewSize())
    }
    window.addEventListener("resize", resize)
    return () => {
      window.removeEventListener("resize", resize)
    }
  }, [])

  const shown = useMemo(
    () =>
      (list ?? []).filter(
        (c) =>
          settings.showAutomatic ||
          !isAutomatic(c) ||
          c.protected === true ||
          c.name === selected,
      ),
    [list, settings.showAutomatic, selected],
  )
  const byName = useMemo(
    () => new Map((list ?? []).map((c) => [c.name, c])),
    [list],
  )
  const moves = useMemo<Moves>(
    () => settings.layouts[p.instance] ?? {},
    [settings.layouts, p.instance],
  )
  const slots = useMemo(
    () => layoutTimeline(shown, p.aspect),
    [shown, p.aspect],
  )
  const base = useMemo(() => placeCards(slots, moves), [slots, moves])
  const stored = settings.sections?.[p.instance]
  const storedSections = useMemo(
    () =>
      normalizeSections(
        stored?.list ?? [],
        [{ rect: withCaption(slots.now), gap: GRID }],
        t("checkpoints.section.default"),
      ),
    [stored, slots.now],
  )
  const members = useMemo(() => stored?.members ?? {}, [stored])
  const sectionsHost = useRef<SectionsHost | null>(null)
  const sec = useSections(sectionsHost, storedSections, members)
  const layout = useMemo(
    () => ({
      ...base,
      cards: placeMembers(base.cards, sec.sections, sec.members),
    }),
    [base, sec.sections, sec.members],
  )
  const layoutNow = useRef(layout)
  layoutNow.current = layout
  const listNow = useRef<Checkpoint[]>([])
  listNow.current = list ?? []
  const ticks = useMemo(
    () =>
      timelineTicks(layout.days, new Date(nowMs), {
        now: t("checkpoints.now"),
        today: t("checkpoints.today"),
        yesterday: t("checkpoints.yesterday"),
      }),
    [layout.days, nowMs],
  )

  const content = useMemo<Rect>(() => {
    const b =
      storedSections.length === 0
        ? layout.bounds
        : union([
            layout.bounds,
            ...storedSections.map((s) => ({
              ...sectionRect(s),
              y: s.y - 48,
              height: s.h + 48,
            })),
          ])
    return {
      x: b.x - 120,
      y: b.y - 120,
      width: b.width + 240,
      height: b.height + 240,
    }
  }, [layout.bounds, storedSections])
  const limits = useMemo(() => {
    const fit = fitRect(content, size, 48).zoom
    return { min: Math.max(0.04, Math.min(0.3, fit * 0.85)), max: 3 }
  }, [content, size])

  const limitsNow = useRef(limits)
  limitsNow.current = limits

  const cam = useCanvasCamera(
    fitRect(frameOf(layout.now), viewSize(), 0),
    viewSize,
  )
  const { fly: flyCamera, set: setCamera, current: cameraNow } = cam
  const camera = cam.camera
  leftSpace.current = selected === null ? 0 : panelSpace()
  const clamp = useCallback(
    (
      c: Camera,
      right: number = TIMELINE_SPACE,
      left: number = leftSpace.current,
    ): Camera => {
      const free = clampCamera(
        { ...c, x: c.x - left },
        content,
        {
          width: Math.max(320, viewSize().width - right - left),
          height: viewSize().height,
        },
        96,
        limits,
      )
      return { ...free, x: free.x + left }
    },
    [content, limits],
  )
  const freeView = useCallback(
    (): Size => ({
      width: viewSize().width - TIMELINE_SPACE - leftSpace.current,
      height: viewSize().height - BAR_SPACE,
    }),
    [],
  )

  const fitIn = useCallback(
    (rect: Rect, padding: number): Camera => {
      const f = fitRect(rect, freeView(), padding, limits)
      return { ...f, x: f.x + leftSpace.current / 2 }
    },
    [freeView, limits],
  )

  const centreIn = useCallback(
    (
      world: { x: number; y: number },
      zoom: number,
      right: number = TIMELINE_SPACE,
      left: number = leftSpace.current,
    ): Camera => {
      const c = centreOn(world, zoom, viewSize())
      return { ...c, x: c.x + (left - right) / 2, y: c.y - BAR_SPACE / 2 }
    },
    [],
  )

  const newest = useCallback((): Camera => {
    const view = openingView(layout)
    const fit = fitIn(view, 72)
    const zoom = clampZoom(Math.min(1.1, fit.zoom), limits)
    return clamp(
      centreIn(
        { x: view.x + view.width / 2, y: view.y + view.height / 2 },
        zoom,
      ),
    )
  }, [layout, limits, clamp, fitIn, centreIn])

  const overview = useCallback((): Camera => {
    const all = fitIn(layout.bounds, 56)
    if (settings.zoom === null && all.zoom >= READABLE_FIT) return clamp(all)
    const view = openingView(layout)
    const fit = fitIn(view, 72)
    const zoom = clampZoom(Math.min(1.1, settings.zoom ?? fit.zoom), limits)
    return clamp(
      centreIn(
        { x: view.x + view.width / 2, y: view.y + view.height / 2 },
        zoom,
      ),
    )
  }, [layout, limits, settings.zoom, clamp, fitIn, centreIn])

  const focusOn = useCallback(
    (box: Rect): Camera => {
      const v = viewSize()
      const free = Math.max(320, v.width - panelSpace() - TIMELINE_SPACE)
      const zoom = clampZoom(
        Math.min(
          Math.min(free * 0.5, 320) / box.width,
          (v.height * 0.45) / box.height,
        ),
        limits,
      )
      return centreIn(
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        zoom,
        TIMELINE_SPACE,
        panelSpace(),
      )
    },
    [limits, centreIn],
  )

  const entered = useRef(false)
  useEffect(() => {
    if (entered.current || !presented) return
    const go = (): void => {
      if (entered.current) return
      entered.current = true
      setCamera(overview())
    }
    if (list !== null) {
      go()
      return
    }
    const timer = setTimeout(go, ENTER_WAIT_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [list, overview, setCamera, presented])

  useEffect(() => {
    if (entered.current && presented && camera === cameraNow())
      setSurfaceReady(true)
  }, [camera, cameraNow, presented])

  useEffect(() => {
    if (!surfaceReady || phase !== "entering") return
    if (surfaceFadeMs() === 0) {
      setPhase("open")
      return
    }
    const timer = setTimeout(() => {
      setPhase("open")
    }, ENTER_WAIT_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [surfaceReady, phase])

  const leavingNow = useRef(false)
  const leave = useCallback(async (): Promise<void> => {
    if (leavingNow.current) return
    leavingNow.current = true
    setCamera(cameraNow())
    if (selected === null) {
      const zoom = cameraNow().zoom
      const all = fitRect(
        layoutNow.current.bounds,
        freeView(),
        56,
        limitsNow.current,
      ).zoom
      void saveSettings({
        ...settings,
        zoom: Math.abs(zoom / all - 1) < 0.04 ? null : zoom,
      })
    }
    await new Promise<void>((done) => {
      const motion =
        typeof matchMedia === "function"
          ? matchMedia("(prefers-reduced-motion: reduce)")
          : null
      const finish = (): void => {
        clearTimeout(timer)
        motion?.removeEventListener("change", preferenceChanged)
        finishLeaving.current = null
        done()
      }
      const preferenceChanged = (): void => {
        if (motion?.matches) finish()
      }
      const timer = setTimeout(
        finish,
        surfaceFadeMs() === 0 ? 0 : ENTER_WAIT_MS,
      )
      finishLeaving.current = finish
      motion?.addEventListener("change", preferenceChanged)
      setPhase("leaving")
    })
    try {
      await checkpointPresentation.set(false)
      props.current.onClosed()
    } catch (error) {
      console.warn("restoring the checkpoint window failed", error)
      leavingNow.current = false
      setPhase("open")
    }
  }, [cameraNow, setCamera, selected, settings, freeView])

  const closeRequest = useRef(p.closeRequest)
  useEffect(() => {
    if (p.closeRequest !== closeRequest.current) {
      closeRequest.current = p.closeRequest
      void leave()
    }
  }, [p.closeRequest, leave])

  const fly = useCallback(
    (to: Camera, duration?: number, right?: number, left?: number) =>
      void flyCamera(
        clamp(to, right, left),
        duration === undefined ? {} : { duration },
      ),
    [flyCamera, clamp],
  )

  const select = useCallback(
    (name: string | null) => {
      setSelected(name)
      setNoteState("idle")
      if (name === null) return
      sec.select(null)
      const box = layout.cards.get(name)
      if (box !== undefined)
        fly(focusOn(box), undefined, TIMELINE_SPACE, panelSpace())
    },
    [layout.cards, fly, focusOn, sec.select, setSelected],
  )

  const zoomBy = (factor: number, anchor?: { x: number; y: number }): void => {
    const v = viewSize()
    fly(
      zoomAround(
        cameraNow(),
        factor,
        anchor ?? { x: v.width / 2, y: v.height / 2 },
        limits,
      ),
      260,
    )
  }
  const fitAll = (): void => {
    fly(fitIn(layout.bounds, 72))
  }

  const press = useRef<{
    id: number
    x: number
    y: number
    from: Camera
    moved: boolean
    card: string | null
    was: { x: number; y: number }
  } | null>(null)
  const suppressClick = useRef(false)
  const [dragging, setDragging] = useState<{
    readonly name: string
    readonly x: number
    readonly y: number
  } | null>(null)

  const commit = useCallback((next: Arrangement): void => {
    const known = new Set(listNow.current.map((c) => c.name))
    const kept = Object.fromEntries(
      Object.entries(next.moves).filter(
        ([n, by]) => known.has(n) && (by.x !== 0 || by.y !== 0),
      ),
    )
    const inside = Object.fromEntries(
      Object.entries(next.members).filter(([n]) => known.has(n)),
    )
    setSettings((s) => {
      const layouts = { ...s.layouts }
      if (Object.keys(kept).length === 0) delete layouts[props.current.instance]
      else layouts[props.current.instance] = kept
      const sections = { ...s.sections }
      if (next.sections.length === 0) delete sections[props.current.instance]
      else
        sections[props.current.instance] = {
          list: next.sections,
          members: inside,
        }
      const out = {
        ...s,
        layouts,
        sections: Object.keys(sections).length === 0 ? undefined : sections,
      }
      void saveSettings(out)
      return out
    })
  }, [])
  const arrangement: Arrangement = { sections: storedSections, members, moves }
  sectionsHost.current = {
    viewport,
    camera: cameraNow,
    placed: () => layout.cards,
    slots: () => slots.cards,
    names: () => new Set(shown.map((c) => c.name)),
    now: () => withCaption(layout.now),
    railX: () => viewSize().width - TIMELINE_SPACE,
    arrangement: () => arrangement,
    commit,
    onChosen: () => {
      setSelected(null)
      setNoteState("idle")
    },
  }
  const keepMoves = (next: Moves): void => {
    commit({ ...arrangement, moves: next })
  }
  const offsetOf = (name: string): { x: number; y: number } => {
    const at = layout.cards.get(name)
    const slot = slots.cards.get(name)
    if (members[name] === undefined || at === undefined || slot === undefined)
      return moves[name] ?? { x: 0, y: 0 }
    return { x: at.x - slot.x, y: at.y - slot.y }
  }
  const putCard = (name: string, to: { x: number; y: number }): void => {
    const slot = slots.cards.get(name)
    if (slot !== undefined) commit(dropCard(arrangement, name, slot, to))
  }

  const pointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (
      (e.button !== 0 && e.button !== 1) ||
      editableTarget(e.target) ||
      sec.down(e)
    )
      return
    const card =
      e.button === 0 && e.target instanceof Element
        ? (e.target.closest<HTMLElement>(".checkpoint[data-name]")?.dataset
            .name ?? null)
        : null
    press.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      from: cameraNow(),
      moved: false,
      card,
      was: card === null ? { x: 0, y: 0 } : offsetOf(card),
    }
  }
  const pointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (sec.move(e)) return
    const pr = press.current
    if (pr === null || pr.id !== e.pointerId) return
    const dx = e.clientX - pr.x
    const dy = e.clientY - pr.y
    if (!pr.moved) {
      if (Math.hypot(dx, dy) < 4) return
      pr.moved = true
      if (pr.card === null) setPanning(true)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    if (pr.card !== null) {
      setDragging({
        name: pr.card,
        x: pr.was.x + dx / pr.from.zoom,
        y: pr.was.y + dy / pr.from.zoom,
      })
      return
    }
    setCamera(clamp({ ...pr.from, x: pr.from.x + dx, y: pr.from.y + dy }))
  }
  const pointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (sec.up(e)) return
    const pr = press.current
    if (pr === null || pr.id !== e.pointerId) return
    press.current = null
    if (pr.moved) {
      setPanning(false)
      if (pr.card !== null) {
        putCard(pr.card, {
          x: pr.was.x + (e.clientX - pr.x) / pr.from.zoom,
          y: pr.was.y + (e.clientY - pr.y) / pr.from.zoom,
        })
        setDragging(null)
      }
      suppressClick.current = true
      setTimeout(() => {
        suppressClick.current = false
      }, 0)
    } else if (e.target === e.currentTarget) {
      select(null)
      sec.select(null)
    }
  }

  const onSelectCard = useCallback(
    (name: string) => {
      if (suppressClick.current) return
      select(name)
    },
    [select],
  )

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
        setCamera(
          c(
            zoomAround(
              cameraNow(),
              wheelZoomFactor(e.deltaY * lines),
              { x: e.clientX - r.left, y: e.clientY - r.top },
              l,
            ),
          ),
        )
        return
      }
      const now = cameraNow()
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX
      const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY
      setCamera(c({ ...now, x: now.x - dx * lines, y: now.y - dy * lines }))
    }
    let pinchFrom: Camera | null = null
    const gestureStart = (e: Event): void => {
      e.preventDefault()
      pinchFrom = cameraNow()
    }
    const gestureChange = (e: Event): void => {
      e.preventDefault()
      const g = e as Event & {
        scale?: number
        clientX?: number
        clientY?: number
      }
      if (pinchFrom === null || g.scale === undefined) return
      const r = el.getBoundingClientRect()
      const { clamp: c, limits: l } = wheelState.current
      setCamera(
        c(
          zoomAround(
            pinchFrom,
            g.scale,
            {
              x: (g.clientX ?? r.width / 2) - r.left,
              y: (g.clientY ?? r.height / 2) - r.top,
            },
            l,
          ),
        ),
      )
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

  const dateWords = useCallback((c: Checkpoint) => takenAt(c, nowMs), [nowMs])
  const results = useMemo(
    () => searchCheckpoints(list ?? [], query, dateWords),
    [list, query, dateWords],
  )
  const matches = useMemo(
    () => (query.trim() === "" ? null : new Set(results.map((c) => c.name))),
    [results, query],
  )
  const pickResult = (c: Checkpoint): void => {
    searchInput.current?.blur()
    if (!settings.showAutomatic && isAutomatic(c)) {
      setSettings((s) => ({ ...s, showAutomatic: true }))
    }
    setQuery("")
    setSearchOpen(false)
    setTimeout(() => {
      select(c.name)
    }, 0)
  }

  const closeSearch = (): void => {
    setQuery("")
    setSearchOpen(false)
    searchInput.current?.blur()
  }
  useEffect(() => {
    if (searchOpen && document.activeElement !== searchInput.current)
      searchInput.current?.focus()
  }, [searchOpen])

  const centre = centreOf(camera, size)
  const nearest = dayNearest(layout, { x: centre.x, y: centre.y })
  const activeTick =
    nearest === null ? "now" : (layout.days[nearest]?.key ?? "now")
  const dayCamera = (tick: Tick): Camera => {
    if (tick.day === null) return overview()
    const d = layout.days[tick.day]
    if (d === undefined) return overview()
    const block = withLabel(d)
    const fit = fitIn(block, 96)
    const zoom = clampZoom(
      Math.min(fit.zoom, Math.max(cameraNow().zoom, 0.55)),
      limits,
    )
    return centreIn(
      { x: block.x + block.width / 2, y: block.y + block.height / 2 },
      zoom,
    )
  }
  const step = (direction: -1 | 1): void => {
    const next = stepThrough(layout.order, selected, direction)
    if (next === null) {
      select(null)
      fly(overview())
    } else select(next)
  }

  const taken = useMemo(() => new Set((list ?? []).map((c) => c.name)), [list])

  const writeTitle = async (name: string, title: string): Promise<void> => {
    if (title.trim() === "" || title.trim() === name) return
    await winvm(
      "saves",
      "note",
      "-i",
      props.current.instance,
      name,
      `--title=${title.trim()}`,
      "--json",
    ).catch(() => undefined)
  }

  const takeCheckpoint = async (
    title: string,
    label: string,
    storedTitle: string = title,
    format?: CheckpointFormat,
  ): Promise<string | null> => {
    const name = saveNameFor(title, taken, new Date())
    setWorking({ on: "now", label })
    setSelected(null)
    const today = layout.days.at(-1)
    const isToday = today !== undefined && today.key === dayKey(new Date())
    void flyCamera(
      clamp(
        fitIn(union([layout.now, ...(isToday ? [withLabel(today)] : [])]), 96),
      ),
    )
    setStatus(null)
    try {
      const ran = await props.current.run(
        "save",
        name,
        format === undefined ? undefined : { format },
      )
      if (ran === null || ran.code !== 0) {
        setStatus({
          tone: "error",
          text: ran?.output || t("checkpoints.saveFailed"),
        })
        return null
      }
      await writeTitle(name, storedTitle)
      const before = new Set(taken)
      let landed: TimelineLayout | null = null
      await reload((got) => {
        if (!got.some((c) => c.name === name) || before.has(name)) return
        const after = layoutTimeline(
          got.filter(
            (c) =>
              settings.showAutomatic || !isAutomatic(c) || c.protected === true,
          ),
          props.current.aspect,
        )
        const box = after.cards.get(name)
        if (box === undefined) return
        landed = after
        setArriving({
          name,
          dx: after.now.x - box.x,
          dy: after.now.y - box.y,
          scale: after.now.width / box.width,
        })
        setTimeout(() => {
          setArriving((a) => (a?.name === name ? null : a))
        }, ARRIVE_WAIT_MS)
      })
      const after = landed as TimelineLayout | null
      const today = after?.days.at(-1)
      if (after !== null)
        void flyCamera(
          clamp(
            fitIn(
              union([
                after.now,
                ...(today === undefined ? [] : [withLabel(today)]),
              ]),
              96,
            ),
          ),
        )
      return name
    } finally {
      setWorking(null)
    }
  }

  const submitNew = (
    title: string,
    unnamed: string,
    format: CheckpointFormat,
  ): void => {
    setCreating(false)
    void takeCheckpoint(
      title,
      t("checkpoints.taking"),
      title === "" ? unnamed : title,
      format,
    )
  }

  const goBack = async (name: string, saveFirst: boolean): Promise<void> => {
    setConfirm(null)
    const target = byName.get(name)
    const steps = goBackSteps(name, saveFirst, {
      live,
      now: new Date(),
      taken,
      keepTitle: t("checkpoints.keepTitle", {
        name: target === undefined ? name : shownName(target),
      }),
    })
    for (const s of steps) {
      if (s.verb === "save") {
        const made = await takeCheckpoint(
          s.title ?? "",
          t("checkpoints.keeping"),
        )
        if (made === null) return
        continue
      }
      setWorking({ on: name, label: t("checkpoints.goingBack") })
      setStatus(null)
      const ran = await props.current.run("load", s.name)
      setWorking(null)
      if (ran === null || ran.code !== 0) {
        setStatus({
          tone: "error",
          text: ran?.output || t("checkpoints.loadFailed"),
        })
        await reload()
        return
      }
      void leave()
    }
  }

  const remove = async (name: string): Promise<void> => {
    setConfirm(null)
    const c = byName.get(name)
    if (
      p.busy ||
      working !== null ||
      (c !== undefined && deleteBlocked(c) !== null)
    )
      return
    setWorking({ on: name, label: t("checkpoints.deleting") })
    try {
      const out = await winvm("saves", "-i", props.current.instance, "rm", name)
      if (out.code !== 0) {
        setStatus({
          tone: "error",
          text: outputText(out) || t("checkpoints.deleteFailed"),
        })
        return
      }
      setLeaving(name)
      if (selected === name) setSelected(null)
      await new Promise((r) => setTimeout(r, LEAVE_WAIT_MS))
      if (c !== undefined) forgetPictures([c.thumbnail, c.screenshot])
      await reload()
      setStatus({
        tone: "info",
        text: t("checkpoints.deleted", {
          name: c === undefined ? name : shownName(c),
        }),
      })
    } catch (e) {
      setStatus({ tone: "error", text: String(e) })
    } finally {
      setLeaving(null)
      setWorking(null)
    }
  }

  const protect = async (name: string, value: boolean): Promise<void> => {
    if (p.busy || working !== null) return
    setWorking({
      on: name,
      label: t(value ? "checkpoints.protect" : "checkpoints.unprotect"),
    })
    setStatus(null)
    try {
      const out = await winvm(
        "saves",
        value ? "protect" : "unprotect",
        "-i",
        props.current.instance,
        name,
      )
      if (out.code !== 0) {
        setStatus({
          tone: "error",
          text: outputText(out) || t("checkpoints.protectFailed"),
        })
        return
      }
      await reload()
    } catch (e) {
      setStatus({ tone: "error", text: String(e) })
    } finally {
      setWorking(null)
    }
  }

  const noteQueue = useRef<Promise<void>>(Promise.resolve())
  const writeNote = (name: string, d: NoteDraft): void => {
    setNoteState("saving")
    const text = d.text.trim() === "-" ? `${d.text} ` : d.text
    noteQueue.current = noteQueue.current.then(async () => {
      try {
        const out = await winvm(
          "saves",
          "note",
          "-i",
          props.current.instance,
          name,
          `--title=${d.title.trim()}`,
          `--text=${text}`,
          `--tags=${tagsOf(d.tags).join(",")}`,
          "--json",
        )
        const note = parseNote(out.stdout)
        if (out.code !== 0 || note === undefined) {
          setNoteState("failed")
          return
        }
        setList(
          (l) =>
            l?.map((c) =>
              c.name === name
                ? { ...c, notes: note, title: note?.title ?? null }
                : c,
            ) ?? l,
        )
        setNoteState("saved")
      } catch {
        setNoteState("failed")
      }
    })
  }

  const resetLayout = (): void => {
    setSelected(null)
    keepMoves({})
  }

  const toggleAutomatic = (): void => {
    setSettings((s) => {
      const next = { ...s, showAutomatic: !s.showAutomatic }
      void saveSettings(next)
      return next
    })
  }

  const openLook = (opener: Element | null): void => {
    setLookOpener(opener instanceof HTMLElement ? opener : null)
    setLooking(true)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target instanceof Element ? e.target : document.body
    if (target.closest("dialog") !== null || e.defaultPrevented) return
    const cmd = e.metaKey || e.ctrlKey
    if (e.key === "Escape") {
      e.preventDefault()
      if (editableTarget(e.target)) {
        if (target === searchInput.current && query !== "") setQuery("")
        if (e.target instanceof HTMLElement) e.target.blur()
        setSearchOpen(false)
        return
      }
      if (press.current?.card != null && press.current.moved) {
        press.current = null
        setDragging(null)
      } else if (sec.escape()) {
      } else if (creating) setCreating(false)
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
    if (!cmd && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault()
      sec.setTool(!sec.tool)
    } else if (
      !cmd &&
      (e.key === "Delete" || e.key === "Backspace") &&
      sec.selected !== null
    ) {
      e.preventDefault()
      sec.remove(sec.selected)
    } else if (cmd && (e.key === "=" || e.key === "+")) {
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
      if (c !== undefined && deleteBlocked(c) === null)
        setConfirm({ kind: "delete", name: selected })
    } else if (
      e.altKey &&
      !cmd &&
      e.key.startsWith("Arrow") &&
      selected !== null &&
      layout.cards.has(selected)
    ) {
      e.preventDefault()
      const d = (e.shiftKey ? 4 : 1) * NUDGE_STEP
      const by = offsetOf(selected)
      const next = {
        x: by.x + (e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0),
        y: by.y + (e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0),
      }
      putCard(selected, next)
    } else if (!cmd && e.key.startsWith("Arrow")) {
      e.preventDefault()
      const d = (e.shiftKey ? 4 : 1) * PAN_STEP
      const now = cameraNow()
      const dx = e.key === "ArrowLeft" ? d : e.key === "ArrowRight" ? -d : 0
      const dy = e.key === "ArrowUp" ? d : e.key === "ArrowDown" ? -d : 0
      fly({ ...now, x: now.x + dx, y: now.y + dy }, 180)
    } else if (
      !cmd &&
      e.key === " " &&
      selected !== null &&
      (target.closest("button, a, [role=slider]") === null ||
        target.closest(".checkpoint__hit") !== null)
    ) {
      e.preventDefault()
      openLook(document.activeElement)
    } else if (!cmd && (e.key === "+" || e.key === "=")) {
      zoomBy(ZOOM_STEP)
    } else if (!cmd && e.key === "-") {
      zoomBy(1 / ZOOM_STEP)
    }
  }

  const keys = useRef(onKeyDown)
  keys.current = onKeyDown
  useEffect(() => {
    const handle = (e: KeyboardEvent): void => {
      keys.current(e)
    }
    window.addEventListener("keydown", handle)
    return () => {
      window.removeEventListener("keydown", handle)
    }
  }, [])

  const seen = visibleWorld(camera, size, 360)
  const cardsNow = useMemo(() => {
    const carried =
      dragging === null ? undefined : layout.cards.get(dragging.name)
    if (dragging === null || carried === undefined) return layout.cards
    const slot = slots.cards.get(dragging.name)
    const was =
      members[dragging.name] === undefined || slot === undefined
        ? (moves[dragging.name] ?? { x: 0, y: 0 })
        : { x: carried.x - slot.x, y: carried.y - slot.y }
    return new Map(layout.cards).set(dragging.name, {
      ...carried,
      x: carried.x + dragging.x - was.x,
      y: carried.y + dragging.y - was.y,
    })
  }, [layout.cards, slots.cards, dragging, moves, members])
  const carriedBox = dragging === null ? undefined : cardsNow.get(dragging.name)
  const overSection =
    carriedBox === undefined
      ? null
      : (sectionAt(sec.sections, centreOfCard(carriedBox))?.id ?? null)
  const counts = useMemo(() => {
    const out = new Map<string, number>()
    for (const [name, m] of Object.entries(sec.members))
      if (byName.has(name)) out.set(m.section, (out.get(m.section) ?? 0) + 1)
    return out
  }, [sec.members, byName])
  const far = camera.zoom < FAR_ZOOM
  const selectedCheckpoint =
    selected === null ? undefined : byName.get(selected)
  const busy = p.busy || working !== null
  const isLit = (c: Checkpoint): boolean =>
    (autoHint && isAutomatic(c)) ||
    (hoverDay !== null && dayKey(new Date(c.createdAt)) === hoverDay)
  const picking = autoHint || hoverDay !== null
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
      data-ready={surfaceReady}
    >
      <div className="checkpoints__backdrop" aria-hidden="true" />
      <SpatialCanvas
        className="checkpoints__canvas"
        {...(phase !== "open" ? { inert: "" } : {})}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return
          if (phase === "entering") setPhase("open")
          else if (phase === "leaving") finishLeaving.current?.()
        }}
      >
        <div
          className="checkpoints__drag"
          data-tauri-drag-region
          aria-hidden="true"
        />
        <SpatialCanvasViewport
          ref={viewport}
          camera={camera}
          tool={sec.tool ? "section" : "select"}
          plain
          data-panning={panning}
          data-far={far}
          data-picking={picking}
          tabIndex={0}
          aria-label={t("checkpoints.canvas")}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
        >
          <SectionGrid camera={camera} grid={GRID} on={sec.working} />
          <SpatialCanvasScene {...camera}>
            {layout.days.map((d, i) => {
              const loose = looseNames(d.names, sec.members)
              if (d.names.length > 0 && loose.length === 0) return null
              const group = dayGroup(
                loose.length === d.names.length ? d : { ...d, names: loose },
                cardsNow,
              )
              if (
                !rectsIntersect(
                  withLabel({ ...group.rect, scale: d.scale }),
                  seen,
                )
              )
                return null
              const tick = ticks[i]
              const near = DAY_GAP * d.scale * camera.zoom >= DAY_LABEL_ROOM
              if (!near && tick?.month == null) return null
              return (
                <SpatialCanvasLabel
                  key={d.key}
                  x={near ? group.label.x : group.rect.x - 24 * d.scale}
                  y={
                    near ? group.label.y : group.rect.y + group.rect.height / 2
                  }
                  className="checkpoints__day"
                  data-far={!near}
                  data-day={d.key}
                >
                  <span
                    style={{
                      fontSize: `${String(Math.max(near ? DAY_LABEL * d.scale : 0, DAY_LABEL_MIN / camera.zoom))}px`,
                    }}
                  >
                    {near ? (tick?.label ?? d.key) : tick?.month}
                  </span>
                </SpatialCanvasLabel>
              )
            })}
            {readingOrder(sec.sections).map((s) => (
              <SectionView
                key={s.id}
                s={s}
                count={counts.get(s.id) ?? 0}
                zoom={camera.zoom}
                selected={sec.selected === s.id}
                editing={sec.editing === s.id}
                target={overSection === s.id}
                moving={sec.moving === s.id}
                onRename={sec.rename}
                onRemove={sec.remove}
                onKeyDown={sec.key}
              />
            ))}
            {sec.draft?.box != null && (
              <SectionDraft box={sec.draft.box} ok={sec.draft.ok} />
            )}
            {shown.map((c) => {
              const placed: CardBox | undefined = layout.cards.get(c.name)
              if (placed === undefined) return null
              const carried = dragging?.name === c.name ? dragging : null
              const was = carried === null ? null : offsetOf(c.name)
              const box =
                carried === null || was === null
                  ? placed
                  : {
                      ...placed,
                      x: placed.x + carried.x - was.x,
                      y: placed.y + carried.y - was.y,
                    }
              if (
                !rectsIntersect(
                  { ...box, height: box.height + CAPTION_ROOM },
                  seen,
                )
              )
                return null
              return (
                <CheckpointCard
                  key={`${c.name}#${c.createdAt}`}
                  c={c}
                  box={box}
                  selected={c.name === selected}
                  zoom={camera.zoom}
                  now={nowMs}
                  dimmed={
                    searchOpen && matches !== null && !matches.has(c.name)
                  }
                  lit={isLit(c)}
                  carried={carried !== null}
                  arriving={arriving?.name === c.name ? arriving : null}
                  leaving={leaving === c.name}
                  working={working?.on === c.name ? working.label : null}
                  onSelect={onSelectCard}
                />
              )
            })}
            <SpatialCanvasNode
              x={layout.now.x}
              y={layout.now.y}
              width={layout.now.width}
              height={layout.now.height}
              className="checkpoint checkpoint--now"
              data-live={live}
            >
              <button
                type="button"
                className="checkpoint__hit"
                style={
                  {
                    "--card-scale": NOW_TEXT,
                    "--m": textScale(NOW_TEXT, camera.zoom),
                    "--frame-h": `${String(layout.now.frame)}px`,
                  } as CSSProperties
                }
                aria-label={t("checkpoints.nowLabel", { machine: p.machine })}
                onClick={() => !suppressClick.current && void leave()}
              >
                <span className="checkpoint__frame">
                  <Wallpaper />
                  {live && (
                    <LiveFrame
                      source={p.liveSource}
                      className="checkpoint__live"
                    />
                  )}
                  {nowWorking !== null && (
                    <span className="checkpoint__fit checkpoint__fit--frame">
                      <span className="checkpoint__working">{nowWorking}</span>
                    </span>
                  )}
                </span>
                <span className="checkpoint__caption">
                  <span className="checkpoint__name">
                    {t("checkpoints.now")}
                  </span>
                  <span className="checkpoint__when">{p.machine}</span>
                </span>
              </button>
            </SpatialCanvasNode>
          </SpatialCanvasScene>
        </SpatialCanvasViewport>

        {searchOpen && query.trim() !== "" && (
          <SpatialCanvasFloatingPanel
            label={t("checkpoints.results")}
            className="checkpoints__results"
          >
            <SpatialCanvasSearchResults
              label={t("checkpoints.results")}
              emptyMessage={t("checkpoints.noMatches")}
            >
              {results.slice(0, 50).map((c, i) => (
                <SpatialCanvasSearchResult
                  key={c.name}
                  id={
                    i === activeResult ? "checkpoint-result-active" : undefined
                  }
                  title={shownName(c)}
                  description={takenAt(c, nowMs)}
                  active={i === activeResult}
                  onSelect={() => {
                    pickResult(c)
                  }}
                />
              ))}
            </SpatialCanvasSearchResults>
          </SpatialCanvasFloatingPanel>
        )}

        {creating && (
          <SpatialCanvasFloatingPanel
            label={t("checkpoints.new")}
            className="checkpoints__new"
          >
            <NewCheckpointForm
              live={live}
              busy={busy}
              onCancel={() => {
                setCreating(false)
              }}
              onSubmit={submitNew}
            />
          </SpatialCanvasFloatingPanel>
        )}

        <Timeline
          ticks={ticks}
          active={activeTick}
          onPick={(tick) => {
            fly(dayCamera(tick))
          }}
          onScrub={(tick) => {
            fly(dayCamera(tick), 200)
          }}
          onOlder={() => {
            step(-1)
          }}
          onNewer={() => {
            step(1)
          }}
          onHover={(tick) => {
            setHoverDay(tick?.kind === "day" ? tick.key : null)
          }}
          canOlder={
            layout.order.length > 0 &&
            (selected === null || layout.order[0] !== selected)
          }
          canNewer={selected !== null}
        />

        <ControlBar
          live={live}
          busy={busy}
          creating={creating}
          showAutomatic={settings.showAutomatic}
          searchOpen={searchOpen}
          query={query}
          inputRef={searchInput}
          matchCount={results.length}
          onNew={() => {
            setCreating((o) => !o)
          }}
          onNewest={() => {
            fly(newest())
          }}
          onToggleAutomatic={toggleAutomatic}
          onAutomaticHint={setAutoHint}
          onSearchToggle={() => {
            if (searchOpen || query !== "") closeSearch()
            else setSearchOpen(true)
          }}
          onSearchFocus={() => {
            setSearchOpen(true)
          }}
          onSearchBlur={() => {
            if (query === "") setSearchOpen(false)
          }}
          onQuery={(v) => {
            setQuery(v)
            setActiveResult(0)
            setSearchOpen(true)
          }}
          onSearchKey={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              setActiveResult((i) =>
                Math.max(
                  0,
                  Math.min(
                    results.length - 1,
                    i + (e.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              )
            } else if (e.key === "Enter") {
              const c = results[activeResult]
              if (c !== undefined) pickResult(c)
            }
          }}
          sectionTool={sec.tool}
          onSectionTool={() => {
            sec.setTool(!sec.tool)
          }}
          arranged={Object.keys(moves).length > 0}
          onReset={resetLayout}
          onDone={() => void leave()}
        />

        <span className="checkpoints__sr" role="status" aria-live="polite">
          {sec.said}
        </span>

        <ZoomControl
          zoom={camera.zoom}
          onZoomOut={() => {
            zoomBy(1 / ZOOM_STEP)
          }}
          onZoomIn={() => {
            zoomBy(ZOOM_STEP)
          }}
          onFit={fitAll}
        />

        {(status !== null ||
          listError !== null ||
          (list !== null && list.length === 0)) && (
          <div
            className="checkpoints__status"
            role="status"
            data-tone={status?.tone ?? (listError !== null ? "error" : "info")}
          >
            <span>
              {status?.text ??
                listError ??
                t(live ? "checkpoints.emptyLive" : "checkpoints.empty")}
            </span>
            {status !== null && (
              <CanvasIconButton
                label={t("action.dismiss")}
                onClick={() => {
                  setStatus(null)
                }}
              >
                <CanvasGlyph>{GLYPHS.close}</CanvasGlyph>
              </CanvasIconButton>
            )}
          </div>
        )}

        <CheckpointDetailsLayer
          c={selectedCheckpoint}
          now={nowMs}
          busy={busy}
          saving={noteState}
          onClose={() => {
            select(null)
          }}
          onLook={openLook}
          onNote={writeNote}
          onGoBack={(name) => {
            setConfirm({ kind: "go-back", name })
          }}
          onReveal={(name) => {
            showCheckpointInFinder(props.current.instance, name).catch(
              (e: unknown) => {
                setStatus({ tone: "error", text: String(e) })
              },
            )
          }}
          onDelete={(name) => {
            setConfirm({ kind: "delete", name })
          }}
          onProtect={(name, value) => void protect(name, value)}
        />
      </SpatialCanvas>

      {looking && selectedCheckpoint !== undefined && (
        <CheckpointLook
          c={selectedCheckpoint}
          now={nowMs}
          opener={lookOpener}
          onClose={() => {
            setLooking(false)
          }}
        />
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === null
            ? ""
            : t(
                confirm.kind === "go-back"
                  ? "checkpoints.goBack.title"
                  : "checkpoints.delete.title",
                {
                  name:
                    confirming === undefined
                      ? confirm.name
                      : shownName(confirming),
                },
              )
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
        confirmLabel={
          confirm?.kind === "delete"
            ? t("checkpoints.delete.confirm")
            : t("checkpoints.goBack.confirm")
        }
        cancelLabel={t("confirm.cancel")}
        tone={confirm?.kind === "delete" ? "danger" : "default"}
        {...(confirm?.kind === "go-back" && goBackCopy.offerSaveFirst
          ? {
              secondaryLabel: t("checkpoints.goBack.saveFirst"),
              onSecondary: () => void goBack(confirm.name, true),
            }
          : {})}
        onCancel={() => {
          setConfirm(null)
        }}
        onConfirm={() => {
          if (confirm === null) return
          if (confirm.kind === "delete") void remove(confirm.name)
          else void goBack(confirm.name, false)
        }}
      />
    </SpatialCanvasSurface>
  )
}
