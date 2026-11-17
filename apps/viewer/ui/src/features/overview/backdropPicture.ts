import { useEffect, useState } from "react"

import { winvm } from "../../backend"
import type { SaveEntry } from "../../model"
import { parseSaves } from "../../model"
import { pictureUrl } from "../checkpoints/pictures"

export interface BackdropPicture {
  readonly path: string
  readonly version: string
}

export function pickPicture(
  saves: readonly SaveEntry[],
): BackdropPicture | null {
  const withPicture = saves.filter(
    (s) => (s.thumbnail ?? s.screenshot) !== null,
  )
  const newest = (list: readonly SaveEntry[]): SaveEntry | undefined =>
    [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const best =
    newest(withPicture.filter((s) => s.kind === "stow")) ?? newest(withPicture)
  const path = best === undefined ? null : (best.thumbnail ?? best.screenshot)
  return best === undefined || path === null
    ? null
    : { path, version: best.createdAt }
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

export function useBackdropPicture(
  instance: string | null,
  active: boolean,
): string | null {
  const [got, setGot] = useState<{
    readonly instance: string
    readonly url: string
  } | null>(null)
  useEffect(() => {
    if (instance === null || !active) return
    let live = true
    const load = async (): Promise<void> => {
      const pic = await find(instance)
      if (pic === null) {
        if (live) setGot(null)
        return
      }
      try {
        const url = await pictureUrl(pic.path, pic.version)
        if (live) setGot({ instance, url })
      } catch {
        if (live) setGot(null)
      }
    }
    void load()
    return () => {
      live = false
    }
  }, [instance, active])
  return got !== null && got.instance === instance ? got.url : null
}
