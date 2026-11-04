/**
 * The picture behind a suspended machine's screen: the screenshot taken when
 * it was put away, else the newest one any checkpoint has. A machine with none
 * gets the drawn backdrop (Backdrop.tsx).
 *
 * The picture comes from the same place the Checkpoints view's cards do
 * (`winvm saves --json`, then `checkpoint_image` as a blob: URL, cached), and
 * the small thumbnail is enough: it is shown blurred.
 */
import { useEffect, useState } from "react"

import { winvm } from "../../backend"
import type { SaveEntry } from "../../model"
import { parseSaves } from "../../model"
import { pictureUrl } from "../checkpoints/pictures"

export interface BackdropPicture {
  /** A file `checkpoint_image` serves. */
  readonly path: string
  /** When the save was taken: a save replaced under the same name is fetched again. */
  readonly version: string
}

/** The most recent put-away's picture, else the most recent picture; null when no checkpoint has one. */
export function pickPicture(saves: readonly SaveEntry[]): BackdropPicture | null {
  const withPicture = saves.filter((s) => (s.thumbnail ?? s.screenshot) !== null)
  const newest = (list: readonly SaveEntry[]): SaveEntry | undefined => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const best = newest(withPicture.filter((s) => s.kind === "stow")) ?? newest(withPicture)
  const path = best === undefined ? null : (best.thumbnail ?? best.screenshot)
  return best === undefined || path === null ? null : { path, version: best.createdAt }
}

async function find(instance: string): Promise<BackdropPicture | null> {
  try {
    const out = await winvm("saves", "-i", instance, "--json")
    const saves = out.code === 0 ? parseSaves(out.stdout) : null
    return saves === null ? null : pickPicture(saves)
  } catch {
    return null
  }
}

/** A blob: URL for the machine's picture once it is read; null until then, and for a machine with none. */
export function useBackdropPicture(instance: string | null, active: boolean): string | null {
  const [got, setGot] = useState<{ readonly instance: string; readonly url: string } | null>(null)
  useEffect(() => {
    if (instance === null || !active) return
    let live = true
    void (async () => {
      const pic = await find(instance)
      if (pic === null) return live ? setGot(null) : undefined
      try {
        const url = await pictureUrl(pic.path, pic.version)
        if (live) setGot({ instance, url })
      } catch {
        if (live) setGot(null)
      }
    })()
    return () => {
      live = false
    }
  }, [instance, active])
  // Another machine's picture is never shown, not even for a frame.
  return got !== null && got.instance === instance ? got.url : null
}
