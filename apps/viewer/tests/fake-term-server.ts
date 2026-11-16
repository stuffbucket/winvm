import type { Server, ServerWebSocket } from "bun"

interface FakeSession {
  readonly shell: string | null
  readonly cwd: string | null
  readonly protocols: readonly string[]
  readonly sizes: { cols: number; rows: number }[]
  input: string
}

interface Data {
  session: FakeSession
  line: string
}

export interface FakeTermServer {
  readonly port: number
  readonly token: string
  readonly sessions: FakeSession[]
  endpoint(shell?: string, cwd?: string | null): { url: string; protocols: string[] }
  stop(): void
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const PROMPT = "PS C:\\Users\\Administrator> "

function banner(s: FakeSession): string {
  const where = s.cwd ?? "C:\\Users\\Administrator"
  return `\x1b]0;C:\\Program Files\\PowerShell\\7\\pwsh.exe\x07PowerShell 7.5.0 (fake)\r\n${where}\r\n\r\n${PROMPT}`
}

function run(ws: ServerWebSocket<Data>, line: string): void {
  const [cmd, ...rest] = line.trim().split(/\s+/)
  const arg = rest.join(" ")
  const say = (text: string): void => {
    ws.sendBinary(encoder.encode(text))
  }
  if (cmd === "exit") {
    ws.send(JSON.stringify({ type: "exit", code: arg === "" ? 0 : Number(arg) }))
    ws.close(1000)
    return
  }
  if (cmd === "error") {
    ws.send(JSON.stringify({ type: "error", message: arg }))
  } else if (cmd === "title") {
    say(`\x1b]2;${arg}\x07`)
  } else if (cmd === "size") {
    const size = ws.data.session.sizes.at(-1)
    say(`${String(size?.cols)}x${String(size?.rows)}\r\n`)
  } else if (cmd === "split") {
    const bytes = encoder.encode("é✓\r\n")
    ws.sendBinary(bytes.slice(0, 1))
    ws.sendBinary(bytes.slice(1, 4))
    ws.sendBinary(bytes.slice(4))
  } else if (cmd === "colors") {
    for (let i = 0; i < 8; i++) say(`\x1b[3${String(i)}m color ${String(i)} \x1b[9${String(i)}m bright ${String(i)}\x1b[0m\r\n`)
  } else if (cmd !== undefined && cmd !== "") {
    say(`${line}\r\n`)
  }
  say(PROMPT)
}

export function startFakeTermServer(port = 0): FakeTermServer {
  const token = crypto.randomUUID().replace(/-/g, "")
  const sessions: FakeSession[] = []
  const server: Server<Data> = Bun.serve<Data>({
    hostname: "127.0.0.1",
    port,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname !== "/term") return new Response("not found", { status: 404 })
      const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim())
      if (!protocols.includes("winvm-term") || !protocols.includes(`winvm-token.${token}`)) return new Response("forbidden", { status: 403 })
      const session: FakeSession = {
        shell: url.searchParams.get("shell"),
        cwd: url.searchParams.get("cwd"),
        protocols,
        sizes: [{ cols: Number(url.searchParams.get("cols")), rows: Number(url.searchParams.get("rows")) }],
        input: "",
      }
      sessions.push(session)
      const upgraded = srv.upgrade(req, { data: { session, line: "" }, headers: { "Sec-WebSocket-Protocol": "winvm-term" } })
      return upgraded ? undefined : new Response("upgrade failed", { status: 400 })
    },
    websocket: {
      open(ws) {
        ws.sendBinary(encoder.encode(banner(ws.data.session)))
      },
      message(ws, message) {
        if (typeof message === "string") {
          const m = JSON.parse(message) as { type?: string; cols?: number; rows?: number }
          if (m.type === "resize" && typeof m.cols === "number" && typeof m.rows === "number") ws.data.session.sizes.push({ cols: m.cols, rows: m.rows })
          return
        }
        const text = decoder.decode(message)
        ws.data.session.input += text
        for (const ch of text) {
          if (ch === "\r") {
            ws.sendBinary(encoder.encode("\r\n"))
            const line = ws.data.line
            ws.data.line = ""
            run(ws, line)
          } else if (ch === "\x7f") {
            if (ws.data.line !== "") {
              ws.data.line = ws.data.line.slice(0, -1)
              ws.sendBinary(encoder.encode("\b \b"))
            }
          } else {
            ws.data.line += ch
            ws.sendBinary(encoder.encode(ch))
          }
        }
      },
    },
  })
  const actual = server.port ?? port
  return {
    port: actual,
    token,
    sessions,
    endpoint(shell = "pwsh", cwd = null) {
      const q = new URLSearchParams({ shell, ...(cwd === null ? {} : { cwd }) })
      return { url: `ws://127.0.0.1:${String(actual)}/term?${q.toString()}`, protocols: ["winvm-term", `winvm-token.${token}`] }
    },
    stop() {
      void server.stop(true)
    },
  }
}

if (import.meta.main) {
  const fake = startFakeTermServer(Number(process.argv[2] ?? 0))
  console.log(JSON.stringify(fake.endpoint()))
}
