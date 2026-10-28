/**
 * Ask QEMU's VNC server for a new desktop size (RFB SetDesktopSize), the first
 * half of a live resize (display.ts). A short-lived, SHARED connection, so the
 * viewer and Screen Sharing stay connected.
 *
 * QEMU 11.1 (ui/vnc.c, VNC_MSG_CLIENT_SET_DESKTOP_SIZE) hands the width and
 * height to the display device (qemu_console_set_ui_info, no delay) and
 * answers at once with an ExtendedDesktopSize rect: reason 1 (this client's
 * request), status 4 "request forwarded" when the device can resize
 * (virtio-gpu), 3 "invalid screen layout" when it cannot (ramfb). Forwarded is
 * not done: the guest's driver then offers the size, and the agent sets it.
 */
import { createCipheriv } from "node:crypto"
import { connect } from "node:net"

/** RFB ExtendedDesktopSize status codes. */
export const RESIZE_STATUS = {
  0: "ok",
  1: "prohibited",
  2: "out of resources",
  3: "invalid screen layout (the display device cannot resize: ramfb?)",
  4: "forwarded",
} as const

export interface ResizeAnswer {
  /** The ExtendedDesktopSize status QEMU answered the request with. */
  readonly status: number
  /** The framebuffer's size when connecting. */
  readonly before: { readonly width: number; readonly height: number }
}

/** VNC authentication's DES: the password, 8 bytes, each byte bit-reversed, encrypts the challenge. */
export function vncAuthResponse(password: string, challenge: Uint8Array): Buffer {
  const key = Buffer.alloc(8)
  for (let i = 0; i < 8; i += 1) {
    const c = i < password.length ? password.charCodeAt(i) & 0xff : 0
    let r = 0
    for (let b = 0; b < 8; b += 1) if ((c >> b) & 1) r |= 1 << (7 - b)
    key[i] = r
  }
  const cipher = createCipheriv("des-ecb", key, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(challenge), cipher.final()])
}

/** The SetDesktopSize message (type 251) for one screen. */
export function setDesktopSizeMessage(width: number, height: number, screenId = 0, flags = 0): Buffer {
  const b = Buffer.alloc(24)
  b[0] = 251
  b.writeUInt16BE(width, 2)
  b.writeUInt16BE(height, 4)
  b[6] = 1 // screens
  b.writeUInt32BE(screenId, 8)
  b.writeUInt16BE(width, 16)
  b.writeUInt16BE(height, 18)
  b.writeUInt32BE(flags, 20)
  return b
}

/**
 * Connect to the VNC server on 127.0.0.1:`port`, ask for `width`x`height`, and
 * return QEMU's answer. Throws on authentication failure or timeout.
 */
export async function requestDesktopSize(
  port: number,
  password: string | null,
  width: number,
  height: number,
  timeoutMs = 5000,
): Promise<ResizeAnswer> {
  const sock = connect(port, "127.0.0.1")
  let buf = Buffer.alloc(0)
  let wake: (() => void) | null = null
  let failed: Error | null = null
  sock.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    wake?.()
  })
  sock.on("error", (e) => {
    failed = e
    wake?.()
  })
  sock.on("close", () => {
    failed ??= new Error("the VNC server closed the connection")
    wake?.()
  })
  const need = async (n: number): Promise<Buffer> => {
    while (buf.length < n) {
      if (failed !== null) throw failed
      await new Promise<void>((r) => (wake = r))
    }
    const out = buf.subarray(0, n)
    buf = buf.subarray(n)
    return out
  }
  const timer = setTimeout(() => {
    failed = new Error(`no answer from the VNC server on port ${String(port)} within ${String(timeoutMs)} ms`)
    sock.destroy()
  }, timeoutMs)

  try {
    await need(12) // "RFB 003.008\n"
    sock.write("RFB 003.008\n")
    const nTypes = (await need(1))[0] ?? 0
    if (nTypes === 0) throw new Error("the VNC server refused the connection")
    const types = [...(await need(nTypes))]
    if (types.includes(2)) {
      if (password === null) throw new Error("the VNC server wants a password and there is none")
      sock.write(Buffer.from([2]))
      sock.write(vncAuthResponse(password, await need(16)))
    } else if (types.includes(1)) {
      sock.write(Buffer.from([1]))
    } else {
      throw new Error(`no VNC security type winvm speaks (offered ${types.join(",")})`)
    }
    if ((await need(4)).readUInt32BE(0) !== 0) throw new Error("VNC authentication failed")
    sock.write(Buffer.from([1])) // ClientInit: shared
    const init = await need(24)
    const before = { width: init.readUInt16BE(0), height: init.readUInt16BE(2) }
    const bpp = (init[4] ?? 32) / 8
    await need(init.readUInt32BE(20)) // desktop name

    // SetEncodings: ExtendedDesktopSize only. A non-incremental update request
    // makes QEMU send the current layout (with the screen id to resize).
    const enc = Buffer.alloc(8)
    enc[0] = 2
    enc.writeUInt16BE(1, 2)
    enc.writeInt32BE(-308, 4)
    sock.write(enc)
    const fbur = Buffer.alloc(10)
    fbur[0] = 3
    fbur.writeUInt16BE(before.width, 6)
    fbur.writeUInt16BE(before.height, 8)
    sock.write(fbur)

    let sent = false
    for (;;) {
      const type = (await need(1))[0]
      if (type === 0) {
        const n = (await need(3)).readUInt16BE(1)
        for (let i = 0; i < n; i += 1) {
          const r = await need(12)
          const reason = r.readUInt16BE(0)
          const status = r.readUInt16BE(2)
          const w = r.readUInt16BE(4)
          const h = r.readUInt16BE(6)
          const encoding = r.readInt32BE(8)
          if (encoding === -308) {
            const screens = (await need(4))[0] ?? 0
            const layout = await need(16 * screens)
            if (reason === 1 && sent) return { status, before }
            if (!sent) {
              sock.write(setDesktopSizeMessage(width, height, screens > 0 ? layout.readUInt32BE(0) : 0, screens > 0 ? layout.readUInt32BE(12) : 0))
              sent = true
            }
          } else if (encoding === 0) {
            await need(w * h * bpp) // raw pixels; not asked for, but legal
          } else if (encoding !== -223) {
            throw new Error(`unexpected VNC encoding ${String(encoding)}`)
          }
        }
      } else if (type === 1) {
        await need(6 * (await need(5)).readUInt16BE(3))
      } else if (type === 2) {
        // bell
      } else if (type === 3) {
        await need((await need(7)).readUInt32BE(3))
      } else {
        throw new Error(`unexpected VNC message ${String(type)}`)
      }
    }
  } finally {
    clearTimeout(timer)
    sock.destroy()
  }
}
