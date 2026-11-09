#!/usr/bin/env bun
import { appendFileSync } from "node:fs"

export const RELEASE_PR_BRANCH = "release-please--branches--main--components--winvm-workspace"
const RELEASE_PR_REF = `refs/heads/${RELEASE_PR_BRANCH}`
const SHA_PATTERN = /^[0-9a-f]{40}$/

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string[]) => CommandResult

export type DispatchResult = {
  before: string | null
  after: string | null
  decision: "absent" | "unchanged" | "dispatched"
  dispatchedSha?: string
}

const runCommand: CommandRunner = (command) => {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

export function parseRemoteHead(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) return null

  const lines = trimmed.split("\n")
  if (lines.length !== 1) throw new Error(`expected exactly one ${RELEASE_PR_REF} record, found ${lines.length}`)

  const fields = lines[0].trim().split(/\s+/)
  if (fields.length !== 2 || !SHA_PATTERN.test(fields[0])) {
    throw new Error(`malformed ${RELEASE_PR_REF} record`)
  }
  if (fields[1] !== RELEASE_PR_REF) {
    throw new Error(`unexpected ref ${fields[1]}; expected ${RELEASE_PR_REF}`)
  }
  return fields[0]
}

export function releasePrHead(run: CommandRunner = runCommand): string | null {
  const result = run(["git", "ls-remote", "origin", RELEASE_PR_REF])
  if (result.exitCode !== 0) {
    throw new Error(`git ls-remote failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  }
  return parseRemoteHead(result.stdout)
}

export function dispatchReleasePrCi({
  before,
  force,
  repository,
  run = runCommand,
}: {
  before: string | null
  force: boolean
  repository: string
  run?: CommandRunner
}): DispatchResult {
  if (before !== null && !SHA_PATTERN.test(before)) throw new Error(`invalid before SHA: ${before}`)

  const after = releasePrHead(run)
  if (after === null) return { before, after, decision: "absent" }
  if (!force && after === before) return { before, after, decision: "unchanged" }

  const dispatch = run([
    "gh",
    "workflow",
    "run",
    "ci.yml",
    "--repo",
    repository,
    "--ref",
    RELEASE_PR_BRANCH,
    "-f",
    `expected_sha=${after}`,
  ])
  if (dispatch.exitCode !== 0) {
    throw new Error(`CI dispatch failed: ${dispatch.stderr.trim() || `exit ${dispatch.exitCode}`}`)
  }

  return { before, after, decision: "dispatched", dispatchedSha: after }
}

export function validateReleasePleaseTrigger(eventName: string, ref: string): void {
  if (ref !== "refs/heads/main") {
    throw new Error(`${eventName} release maintenance must run from refs/heads/main, got ${ref}`)
  }
}

function flag(args: string[], name: string): string {
  const index = args.indexOf(name)
  const value = index === -1 ? undefined : args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`)
  return value
}

function parseBefore(value: string): string | null {
  if (value === "absent") return null
  if (!SHA_PATTERN.test(value)) throw new Error(`invalid before SHA: ${value}`)
  return value
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`force must be true or false, got ${value}`)
}

function writeSummary(result: DispatchResult, forced: boolean): void {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (!path) return
  const shown = (value: string | null): string => value ?? "absent"
  appendFileSync(
    path,
    [
      "## Release PR CI decision",
      "",
      `- Before: \`${shown(result.before)}\``,
      `- After: \`${shown(result.after)}\``,
      `- Forced: \`${forced}\``,
      `- Decision: **${result.decision}**`,
      ...(result.dispatchedSha ? [`- Dispatched SHA: \`${result.dispatchedSha}\``] : []),
      "",
    ].join("\n"),
  )
}

function main(): void {
  const [operation, ...args] = process.argv.slice(2)
  if (operation === "validate-trigger") {
    validateReleasePleaseTrigger(process.env.GITHUB_EVENT_NAME ?? "unknown", process.env.GITHUB_REF ?? "")
    return
  }
  if (operation === "head") {
    console.log(releasePrHead() ?? "absent")
    return
  }
  if (operation === "capture") {
    const output = process.env.GITHUB_OUTPUT
    if (!output) throw new Error("GITHUB_OUTPUT is required for capture")
    appendFileSync(output, `sha=${releasePrHead() ?? "absent"}\n`)
    return
  }
  if (operation === "dispatch") {
    const force = parseBoolean(flag(args, "--force"))
    const result = dispatchReleasePrCi({
      before: parseBefore(flag(args, "--before")),
      force,
      repository: process.env.GITHUB_REPOSITORY ?? "",
    })
    writeSummary(result, force)
    if (result.decision === "dispatched") console.log(`Dispatched CI for ${RELEASE_PR_BRANCH} at ${result.dispatchedSha}.`)
    else console.log(`Release PR head is ${result.decision}; no CI dispatch needed.`)
    return
  }
  throw new Error(
    "usage: release-please-ci.ts validate-trigger|head|capture|dispatch --before SHA|absent --force true|false",
  )
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`::error::${message}`)
    process.exitCode = 1
  }
}
