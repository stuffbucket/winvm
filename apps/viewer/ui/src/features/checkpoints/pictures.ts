import { useEffect, useRef, useState } from "react"

import { checkpointImage } from "../../backend"

const CONCURRENCY = 4

const cache = new Map<string, Promise<string>>()
const waiting: (() => void)[] = []
let active = 0

async function turn(): Promise<void> {
  if (active < CONCURRENCY) {
    active += 1
    return
  }
  await new Promise<void>((resolve) => waiting.push(resolve))
  active += 1
}

function done(): void {
  active -= 1
  waiting.shift()?.()
}

const keyOf = (path: string, version: string): string => `${path}#${version}`

export function pictureUrl(
  path: string,
  version: string,
  read: (path: string) => Promise<ArrayBuffer> = checkpointImage,
): Promise<string> {
  const key = keyOf(path, version)
  const had = cache.get(key)
  if (had !== undefined) return had
  const made = (async () => {
    await turn()
    try {
      const bytes = await read(path)
      return URL.createObjectURL(new Blob([bytes], { type: "image/png" }))
    } finally {
      done()
    }
  })()
  made.catch(() => cache.delete(key))
  cache.set(key, made)
  return made
}

export function forgetPictures(paths: readonly (string | null)[]): void {
  for (const [key, url] of cache) {
    if (!paths.some((p) => p !== null && key.startsWith(`${p}#`))) continue
    cache.delete(key)
    void url
      .then((u) => {
        URL.revokeObjectURL(u)
      })
      .catch(() => undefined)
  }
}

export function usePicture(
  path: string | null,
  version: string,
  wanted: boolean,
): string | null {
  const [url, setUrl] = useState<string | null>(null)
  const urlFor = useRef({ path, version })
  useEffect(() => {
    const shown = urlFor.current
    if (shown.path === path && shown.version === version) return
    urlFor.current = { path, version }
    setUrl(null)
  }, [path, version])
  useEffect(() => {
    if (path === null || !wanted) return
    let live = true
    pictureUrl(path, version)
      .then((u) => {
        if (live) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [path, version, wanted])
  return url
}
