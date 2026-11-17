import { appendFileSync, openSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { resolve } from "node:path"

interface Child {
  readonly name: string
  readonly argv: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly log?: string
}

interface Kept {
  readonly name: string
  readonly proc: ReturnType<typeof Bun.spawn>
}

const dir = process.argv[process.argv.indexOf("--dir") + 1] ?? "."
const spec = JSON.parse(readFileSync(resolve(dir, "spec.json"), "utf8")) as {
  readonly instance?: string
}
const socket = resolve(dir, "keeper.sock")
const journal = resolve(dir, "requests.jsonl")
let child: Kept | null = null
let sidecars: Kept[] = []
let lastExit: Record<string, unknown> | null = null

function spawnChild(c: Child, onExit: (code: number | null) => void): Kept {
  const out = c.log === undefined ? "ignore" : openSync(c.log, "a")
  const proc = Bun.spawn([...c.argv], {
    env: { ...process.env, ...c.env },
    stdin: "ignore",
    stdout: out,
    stderr: out,
    onExit: (_p, code) => {
      onExit(code)
    },
  })
  return { name: c.name, proc }
}

const retire = (): void => {
  for (const s of sidecars) s.proc.kill("SIGKILL")
}

const listed = (k: Kept): Record<string, unknown> => ({
  name: k.name,
  pid: k.proc.pid,
  startUs: 1,
  adopted: false,
})

function answer(request: Record<string, unknown>): Record<string, unknown> {
  appendFileSync(journal, `${JSON.stringify(request)}\n`)
  switch (request.op) {
    case "hello":
      return {
        ok: true,
        protocol: 2,
        version: "fake",
        pid: process.pid,
        instance: spec.instance,
        child: child === null ? null : listed(child),
        sidecars: sidecars.map(listed),
        lastExit,
        hostEnding: false,
      }
    case "launch-sidecar": {
      if (child !== null) return { ok: false, error: "busy" }
      const c = request.child as Child
      for (const s of sidecars.filter((k) => k.name === c.name))
        s.proc.kill("SIGKILL")
      sidecars = sidecars.filter((k) => k.name !== c.name)
      const kept = spawnChild(c, () => {
        sidecars = sidecars.filter((k) => k !== kept)
      })
      sidecars.push(kept)
      return { ok: true, pid: kept.proc.pid }
    }
    case "launch": {
      if (child !== null) return { ok: false, error: "busy" }
      const c = request.child as Child
      const kept = spawnChild(c, (code) => {
        lastExit = { child: c.name, pid: kept.proc.pid, status: code }
        child = null
        retire()
      })
      child = kept
      return { ok: true, pid: kept.proc.pid }
    }
    case "kill": {
      retire()
      if (child === null) return { ok: false, error: "no child" }
      child.proc.kill("SIGKILL")
      return { ok: true, pid: child.proc.pid }
    }
    case "exit-when-idle":
      return { ok: true }
    default:
      return { ok: false, error: "unknown op" }
  }
}

rmSync(socket, { force: true })
const server = createServer((connection: Socket) => {
  connection.setEncoding("utf8")
  let buffered = ""
  connection.on("data", (data: string) => {
    buffered += data
    const end = buffered.indexOf("\n")
    if (end < 0) return
    const request = JSON.parse(buffered.slice(0, end)) as Record<
      string,
      unknown
    >
    connection.end(`${JSON.stringify(answer(request))}\n`)
  })
})
server.listen(socket)
process.on("SIGTERM", () => {
  retire()
  child?.proc.kill("SIGKILL")
  server.close()
  rmSync(socket, { force: true })
  process.exit(0)
})
