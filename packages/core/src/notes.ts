import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"

import { nameError } from "./savename"
import { dataDir } from "./xdg"

export interface Note {
  readonly title: string | null
  readonly text: string
  readonly tags: readonly string[]
  readonly updatedAt: string
}

export interface NotePatch {
  readonly title?: string | null
  readonly text?: string
  readonly tags?: readonly string[]
}

function checkInstance(instance: string): void {
  if (
    instance === "" ||
    instance.includes("/") ||
    instance.includes("\\") ||
    instance.startsWith(".")
  ) {
    throw new Error(`"${instance}" is not a valid instance name`)
  }
}

function checkSave(save: string): void {
  const err = nameError(save)
  if (err !== null) throw new Error(err)
}

export function notesDir(
  instance: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  checkInstance(instance)
  return resolve(dataDir(env), "notes", instance)
}

export function notePath(
  instance: string,
  save: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  checkSave(save)
  return resolve(notesDir(instance, env), `${save}.json`)
}

const EMPTY = { title: null, text: "", tags: [] } as const

export const cleanTags = (tags: readonly string[]): string[] => [
  ...new Set(tags.map((t) => t.trim()).filter((t) => t !== "")),
]

export function readNote(
  instance: string,
  save: string,
  env: NodeJS.ProcessEnv = process.env,
): Note | null {
  let path: string
  let raw: unknown
  try {
    path = notePath(instance, save, env)
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const title =
    typeof r["title"] === "string" && r["title"].trim() !== ""
      ? r["title"]
      : null
  const text = typeof r["text"] === "string" ? r["text"] : ""
  const tags = Array.isArray(r["tags"])
    ? cleanTags(r["tags"].filter((t): t is string => typeof t === "string"))
    : []
  let updatedAt = typeof r["updatedAt"] === "string" ? r["updatedAt"] : ""
  if (Number.isNaN(Date.parse(updatedAt))) {
    try {
      updatedAt = statSync(path).mtime.toISOString()
    } catch {
      updatedAt = new Date(0).toISOString()
    }
  }
  return { title, text, tags, updatedAt }
}

export const isEmptyNote = (
  n: Pick<Note, "title" | "text" | "tags">,
): boolean => n.title === null && n.text.trim() === "" && n.tags.length === 0

function writeAtomic(path: string, text: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true })
  const tmp = `${path}.tmp-${String(process.pid)}`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function pruneDir(instance: string, env: NodeJS.ProcessEnv): void {
  try {
    rmdirSync(notesDir(instance, env))
  } catch {}
}

export function writeNote(
  instance: string,
  save: string,
  patch: NotePatch,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Note {
  const path = notePath(instance, save, env)
  const old = readNote(instance, save, env) ?? EMPTY
  const title =
    patch.title === undefined
      ? old.title
      : patch.title === null || patch.title.trim() === ""
        ? null
        : patch.title.trim()
  const rawText = patch.text ?? old.text
  const note: Note = {
    title,
    text: rawText.trim() === "" ? "" : rawText,
    tags: cleanTags(patch.tags ?? old.tags),
    updatedAt: now.toISOString(),
  }
  if (isEmptyNote(note)) {
    removeNote(instance, save, env)
    return note
  }
  writeAtomic(path, `${JSON.stringify(note, null, 2)}\n`)
  return note
}

export function removeNote(
  instance: string,
  save: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  rmSync(notePath(instance, save, env), { force: true })
  pruneDir(instance, env)
}

export function removeNotes(
  instance: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  rmSync(notesDir(instance, env), { recursive: true, force: true })
}

export function copyNote(
  fromInstance: string,
  toInstance: string,
  save: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const src = notePath(fromInstance, save, env)
  const dst = notePath(toInstance, save, env)
  if (src === dst) return
  if (!existsSync(src)) {
    removeNote(toInstance, save, env)
    return
  }
  writeAtomic(dst, readFileSync(src, "utf8"))
}
