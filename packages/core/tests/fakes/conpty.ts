/**
 * A stand-in for conpty.exe (assets/conpty.cs) on the host: the same arguments
 * and the same frames, with no pseudo-console. It echoes keystrokes, reports a
 * resize in its output, and on a typed line `exit N` exits with N; `fail` sends
 * an error instead. It ends when its connection does, as the real one does.
 */
import { FrameReader, termFrame } from "../../src/guestagent"

const args = process.argv.slice(2)
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const shell = args.slice(args.indexOf("--") + 1)
const enc = new TextEncoder()
const frames = new FrameReader()
let line = ""

const sock = await Bun.connect({
  hostname: "127.0.0.1",
  port: Number(opt("port")),
  socket: {
    data(s, chunk) {
      for (const f of frames.push(chunk)) {
        if (f.type === "r") {
          const v = new DataView(f.payload.buffer, f.payload.byteOffset)
          s.write(termFrame("o", enc.encode(`resized ${String(v.getUint16(0, true))}x${String(v.getUint16(2, true))}\r\n`)))
          continue
        }
        const text = new TextDecoder().decode(f.payload)
        s.write(termFrame("o", f.payload))
        line += text
        for (let cr = line.indexOf("\r"); cr >= 0; cr = line.indexOf("\r")) {
          const cmd = line.slice(0, cr).trim()
          line = line.slice(cr + 1)
          const m = /^exit (\d+)$/.exec(cmd)
          if (m !== null) {
            const code = new Uint8Array(4)
            new DataView(code.buffer).setInt32(0, Number(m[1]), true)
            s.write(termFrame("x", code))
            s.end()
          }
          if (cmd === "fail") {
            s.write(termFrame("e", enc.encode("it failed")))
            s.end()
          }
        }
      }
    },
    close() {
      process.exit(0)
    },
  },
})
sock.write(termFrame("H", enc.encode(opt("key") ?? "")))
sock.write(termFrame("o", enc.encode(`ready ${shell.join(" ")} ${opt("cols") ?? "?"}x${opt("rows") ?? "?"} cwd=${opt("cwd") ?? "-"} pid=${String(process.pid)}\r\n`)))
