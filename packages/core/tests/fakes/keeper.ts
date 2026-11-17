import {
  appendFileSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer, type Socket } from "node:net"
import { resolve } from "node:path"

import { lockState } from "../../src/pidlock"

interface Child {
  readonly name: string
  readonly argv: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly log?: string
  readonly runtime?: string
}

interface Kept {
  readonly name: string
  readonly proc: ReturnType<typeof Bun.spawn>
  readonly runtime?: string
}

interface Service {
  readonly proc: ReturnType<typeof Bun.spawn>
  readonly build: string
  adopted: boolean
}

const dir = process.argv[process.argv.indexOf("--dir") + 1] ?? "."
const spec = JSON.parse(readFileSync(resolve(dir, "spec.json"), "utf8")) as {
  readonly instance?: string
  readonly adopt?: { readonly name: string; readonly pidfile: string }
}
const socket = resolve(dir, "keeper.sock")
const journal = resolve(dir, "requests.jsonl")
let child: Kept | null = null
let sidecars: Kept[] = []
let lastExit: Record<string, unknown> | null = null
let service: Service | null = null
let adopted: { readonly name: string; readonly pid: number } | null = null

const held = spec.adopt === undefined ? null : lockState(spec.adopt.pidfile)
if (spec.adopt !== undefined && typeof held === "object" && held !== null)
  adopted = { name: spec.adopt.name, pid: held.held }
const watching = setInterval(() => {
  if (adopted === null) return
  try {
    process.kill(adopted.pid, 0)
  } catch {
    lastExit = { child: adopted.name, pid: adopted.pid, unknown: true }
    adopted = null
  }
}, 100)

function spawnChild(c: Child, onExit: (code: number | null) => void): Kept {
  const out = c.log === undefined ? "ignore" : openSync(c.log, "a", 0o600)
  const proc = Bun.spawn([...c.argv], {
    env: { ...process.env, ...c.env },
    stdin: "ignore",
    stdout: out,
    stderr: out,
    onExit: (_p, code) => {
      onExit(code)
    },
  })
  return {
    name: c.name,
    proc,
    ...(c.runtime === undefined ? {} : { runtime: c.runtime }),
  }
}

async function stopService(): Promise<number | null> {
  const ending = service
  if (ending === null) return null
  service = null
  ending.proc.kill("SIGUSR2")
  const timer = setTimeout(() => {
    ending.proc.kill("SIGKILL")
  }, 5000)
  await ending.proc.exited
  clearTimeout(timer)
  return ending.proc.pid
}

const retire = (): void => {
  for (const s of sidecars) s.proc.kill("SIGKILL")
}

const listed = (k: Kept): Record<string, unknown> => ({
  name: k.name,
  pid: k.proc.pid,
  startUs: 1,
  adopted: false,
  legacy: false,
  runtime: k.runtime ?? null,
})

async function answer(
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  appendFileSync(journal, `${JSON.stringify(request)}\n`)
  switch (request.op) {
    case "hello":
      return {
        ok: true,
        protocol: 3,
        version: "fake",
        pid: process.pid,
        instance: spec.instance,
        child:
          child !== null
            ? listed(child)
            : adopted === null
              ? null
              : {
                  name: adopted.name,
                  pid: adopted.pid,
                  startUs: 1,
                  adopted: true,
                  legacy: true,
                  runtime: null,
                },
        sidecars: sidecars.map(listed),
        service:
          service === null
            ? null
            : {
                pid: service.proc.pid,
                build: service.build,
                startUs: 1,
                adopted: service.adopted,
              },
        lastExit,
        hostEnding: false,
      }
    case "service": {
      const s = request.service as Child & { readonly build: string }
      if (service !== null && service.build === s.build)
        return { ok: true, pid: service.proc.pid, started: false }
      await stopService()
      const proc = Bun.spawn([...s.argv], {
        env: { ...s.env, WINVM_KEEPER_PID: String(process.pid) },
        stdin: "ignore",
        stdout: s.log === undefined ? "ignore" : openSync(s.log, "a", 0o600),
        stderr: s.log === undefined ? "ignore" : openSync(s.log, "a", 0o600),
        onExit: () => {
          if (service?.proc === proc) service = null
        },
      })
      service = { proc, build: s.build, adopted: false }
      return { ok: true, pid: proc.pid, started: true }
    }
    case "test-adopt":
      if (service !== null) service.adopted = true
      return { ok: true }
    case "service-stop": {
      const pid = await stopService()
      return pid === null
        ? { ok: false, error: "no service" }
        : { ok: true, pid }
    }
    case "launch-sidecar": {
      if (child !== null) return { ok: false, error: "busy" }
      const c = request.child as Child
      if (!existsSync(c.argv[0] ?? "")) return { ok: false, error: "ENOENT" }
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
      if (child !== null || adopted !== null)
        return { ok: false, error: "busy" }
      const c = request.child as Child
      if (!existsSync(c.argv[0] ?? "")) return { ok: false, error: "ENOENT" }
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
      if (adopted !== null) {
        process.kill(adopted.pid, "SIGKILL")
        return { ok: true, pid: adopted.pid }
      }
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

writeFileSync(resolve(dir, "keeper.pid"), `${String(process.pid)}\n`)
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
    void answer(request).then((reply) => {
      connection.end(`${JSON.stringify(reply)}\n`)
    })
  })
})
server.listen(socket)
process.on("SIGTERM", () => {
  clearInterval(watching)
  retire()
  child?.proc.kill("SIGKILL")
  service?.proc.kill("SIGKILL")
  server.close()
  rmSync(socket, { force: true })
  process.exit(0)
})
