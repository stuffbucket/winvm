/**
 * A person's notes on a save: a title, free text and tags, written in the
 * viewer or with `winvm saves note`.
 *
 * They live OUTSIDE the save's directory, in the XDG data dir (xdg.ts):
 *
 *   $XDG_DATA_HOME/winvm/notes/<instance>/<save>.json
 *     { "title": string|null, "text": string, "tags": string[], "updatedAt": ISO }
 *
 * Why not in the save: a save is machine state under WINVM_HOME — gigabytes,
 * rewritten whole by an autosave, and fair game for anyone clearing space.
 * What a person typed about it is theirs, small, and edited long after the save
 * was taken; it should never mean rewriting (or racing) a save's manifest. The
 * save's lifecycle still governs the note: saves.ts deletes it with the save,
 * drops it when a save is replaced by a new one of the same name (it described
 * the old moment), and copies it with a cloned save.
 *
 * Names are checked before they become paths, so nothing can escape notes/.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { nameError } from "./saves"
import { dataDir } from "./xdg"

export interface Note {
  readonly title: string | null
  readonly text: string
  readonly tags: readonly string[]
  /** ISO 8601: when the note was last written. */
  readonly updatedAt: string
}

export interface NotePatch {
  readonly title?: string | null
  readonly text?: string
  readonly tags?: readonly string[]
}

/**
 * Instance names are checked loosely — existing instances keep whatever name
 * they were given — but never a path, and never hidden.
 */
function checkInstance(instance: string): void {
  if (instance === "" || instance.includes("/") || instance.includes("\\") || instance.startsWith(".")) {
    throw new Error(`"${instance}" is not a valid instance name`)
  }
}

function checkSave(save: string): void {
  const err = nameError(save)
  if (err !== null) throw new Error(err)
}

export function notesDir(instance: string, env: NodeJS.ProcessEnv = process.env): string {
  checkInstance(instance)
  return resolve(dataDir(env), "notes", instance)
}

export function notePath(instance: string, save: string, env: NodeJS.ProcessEnv = process.env): string {
  checkSave(save)
  return resolve(notesDir(instance, env), `${save}.json`)
}

const EMPTY = { title: null, text: "", tags: [] } as const

/** Trimmed, without blanks or repeats, in the order first given. */
export const cleanTags = (tags: readonly string[]): string[] => [...new Set(tags.map((t) => t.trim()).filter((t) => t !== ""))]

/** The note on a save; null when there is none, or it cannot be read. */
export function readNote(instance: string, save: string, env: NodeJS.ProcessEnv = process.env): Note | null {
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
  // Lenient: a hand-edited note with a field missing or mistyped still shows.
  const title = typeof r["title"] === "string" && r["title"].trim() !== "" ? r["title"] : null
  const text = typeof r["text"] === "string" ? r["text"] : ""
  const tags = Array.isArray(r["tags"]) ? cleanTags(r["tags"].filter((t): t is string => typeof t === "string")) : []
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

export const isEmptyNote = (n: Pick<Note, "title" | "text" | "tags">): boolean =>
  n.title === null && n.text.trim() === "" && n.tags.length === 0

/** Write to a temporary name and rename over, so a reader never sees half a note. */
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

/** An instance's notes directory goes once its last note does. */
function pruneDir(instance: string, env: NodeJS.ProcessEnv): void {
  try {
    rmdirSync(notesDir(instance, env))
  } catch {
    // not empty, or already gone
  }
}

/**
 * Merge `patch` into the save's note and write it. A title is trimmed ("" is
 * no title); tags are trimmed and deduplicated. A note left with nothing in it
 * is deleted rather than kept as an empty file, and the empty note returned.
 */
export function writeNote(
  instance: string,
  save: string,
  patch: NotePatch,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Note {
  const path = notePath(instance, save, env)
  const old = readNote(instance, save, env) ?? EMPTY
  const title = patch.title === undefined ? old.title : patch.title === null || patch.title.trim() === "" ? null : patch.title.trim()
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

export function removeNote(instance: string, save: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(notePath(instance, save, env), { force: true })
  pruneDir(instance, env)
}

/** Every note of an instance, for when all its saves go. */
export function removeNotes(instance: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(notesDir(instance, env), { recursive: true, force: true })
}

/**
 * The note on `fromInstance`'s save, onto `toInstance`'s save of the same name
 * (a cloned save). With no note to copy, any note the destination had goes: it
 * described the save the clone replaced.
 */
export function copyNote(fromInstance: string, toInstance: string, save: string, env: NodeJS.ProcessEnv = process.env): void {
  const src = notePath(fromInstance, save, env)
  const dst = notePath(toInstance, save, env)
  if (src === dst) return
  if (!existsSync(src)) {
    removeNote(toInstance, save, env)
    return
  }
  writeAtomic(dst, readFileSync(src, "utf8"))
}
