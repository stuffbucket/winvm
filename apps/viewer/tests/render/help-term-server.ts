/**
 * A stand-in for the guest's terminal WebSocket that plays a short, fixed
 * session, so the Terminal window can be looked at (and photographed for the
 * help pictures) without a VM. It speaks the same interface as
 * tests/fake-term-server.ts, and prints the same one line of JSON when it is
 * ready: `{"url": "ws://127.0.0.1:<port>/term?shell=pwsh", "protocols": [...]}`.
 *
 *   bun tests/render/help-term-server.ts
 */
const token = crypto.randomUUID().replace(/-/g, "")
const encoder = new TextEncoder()

const ESC = "\x1b["
const dim = (s: string): string => `${ESC}90m${s}${ESC}0m`
const cmd = (s: string): string => `${ESC}93m${s}${ESC}0m`
const str = (s: string): string => `${ESC}36m${s}${ESC}0m`
const ok = (s: string): string => `${ESC}32m${s}${ESC}0m`
const PROMPT = "PS C:\\Users\\Administrator> "

// What the shell has already done when the window opens: the banner, then three commands.
const SESSION = [
  "PowerShell 7.5.1\r\n",
  `\r\n${PROMPT}${cmd("winget")} install Git.Git\r\n`,
  `Found Git [Git.Git] Version 2.47.1\r\n`,
  `${ok("Successfully installed")}\r\n`,
  `\r\n${PROMPT}${cmd("git")} ${dim("--version")}\r\n`,
  "git version 2.47.1.windows.1\r\n",
  `\r\n${PROMPT}${cmd("Get-ChildItem")} ${dim("-Path")} ${str("C:\\work")}\r\n`,
  "\r\n",
  "Mode                 LastWriteTime         Length Name\r\n",
  "----                 -------------         ------ ----\r\n",
  "d----          11/2/2026   4:12 PM                build\r\n",
  "d----          11/3/2026   9:40 AM                src\r\n",
  "-a---          11/3/2026   9:41 AM           1204 README.md\r\n",
  `\r\n${PROMPT}`,
]

const server = Bun.serve<undefined>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname !== "/term") return new Response("not found", { status: 404 })
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim())
    if (!protocols.includes("winvm-term") || !protocols.includes(`winvm-token.${token}`)) return new Response("forbidden", { status: 403 })
    return srv.upgrade(req, { data: undefined, headers: { "Sec-WebSocket-Protocol": "winvm-term" } }) ? undefined : new Response("upgrade failed", { status: 400 })
  },
  websocket: {
    open(ws) {
      ws.sendBinary(encoder.encode(`\x1b]0;C:\\Program Files\\PowerShell\\7\\pwsh.exe\x07${SESSION.join("")}`))
    },
    message() {},
  },
})

console.log(JSON.stringify({ url: `ws://127.0.0.1:${String(server.port)}/term?shell=pwsh`, protocols: ["winvm-term", `winvm-token.${token}`] }))
