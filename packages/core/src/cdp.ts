/**
 * A small Chrome DevTools Protocol client — enough to drive a WebView2 window
 * (Tauri, Electron-on-Edge, any WebView2 app) from the host: list its targets,
 * evaluate JavaScript, click a CSS selector, wait for one, read its text.
 *
 * Pure host code over fetch and WebSocket; no Playwright. How the guest's
 * DevTools port gets to the host is webview.ts's business; this file only
 * needs `http://127.0.0.1:<port>`.
 */

export interface Target {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly url: string
  readonly webSocketDebuggerUrl?: string
}

export class CdpError extends Error {}

/** The DevTools targets (pages, iframes, workers) behind a debugging port. */
export async function targets(base: string, timeoutMs = 3000): Promise<readonly Target[]> {
  const r = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new CdpError(`${base}/json/list: ${String(r.status)}`)
  return (await r.json()) as Target[]
}

/**
 * The target to drive: the first page whose URL or title contains `match`
 * (case-insensitive), else the first page. null when there is none.
 */
export function pickTarget(list: readonly Target[], match: string | null): Target | null {
  const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl !== undefined)
  if (match === null || match === "") return pages[0] ?? null
  const m = match.toLowerCase()
  return pages.find((t) => t.url.toLowerCase().includes(m) || t.title.toLowerCase().includes(m)) ?? null
}

interface RemoteObject {
  readonly type: string
  readonly subtype?: string
  readonly value?: unknown
  readonly description?: string
  readonly unserializableValue?: string
}
interface EvalResult {
  readonly result: RemoteObject
  readonly exceptionDetails?: { readonly text: string; readonly exception?: RemoteObject }
}

/** One WebSocket session with one target. Commands are matched to replies by id. */
export class CdpSession {
  private readonly ws: WebSocket
  private nextId = 0
  private readonly pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  private closed: Error | null = null

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.onmessage = (e: MessageEvent): void => {
      const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (msg.id === undefined) return
      const p = this.pending.get(msg.id)
      if (p === undefined) return
      this.pending.delete(msg.id)
      if (msg.error !== undefined) p.rej(new CdpError(msg.error.message))
      else p.res(msg.result)
    }
    ws.onclose = (): void => {
      this.closed = new CdpError("the DevTools connection closed")
      for (const p of this.pending.values()) p.rej(this.closed)
      this.pending.clear()
    }
  }

  static async open(wsUrl: string, timeoutMs = 5000): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new CdpError(`could not open ${wsUrl} in ${String(timeoutMs)} ms`)), timeoutMs)
      ws.onopen = (): void => {
        clearTimeout(t)
        res()
      }
      ws.onerror = (): void => {
        clearTimeout(t)
        rej(new CdpError(`could not open ${wsUrl}`))
      }
    })
    return new CdpSession(ws)
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed !== null) throw this.closed
    this.nextId += 1
    const id = this.nextId
    return await new Promise<T>((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        rej(new CdpError(`${method}: no answer in ${String(timeoutMs)} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        res: (v) => {
          clearTimeout(t)
          res(v as T)
        },
        rej: (e) => {
          clearTimeout(t)
          rej(e)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate an expression in the page (promises awaited) and return its value as JSON. */
  async eval(expression: string, timeoutMs = 30_000): Promise<unknown> {
    const r = await this.send<EvalResult>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      timeoutMs,
    )
    if (r.exceptionDetails !== undefined) {
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
      throw new CdpError(d.split("\n")[0] ?? d)
    }
    const o = r.result
    if (o.type === "undefined") return undefined
    if (o.unserializableValue !== undefined) return o.unserializableValue
    return o.value
  }

  /**
   * Wait until `selector` matches an element (and, with `visible`, one that
   * has a box). Returns the time it took. Polls; throws on timeout.
   */
  async waitFor(selector: string, o: { readonly timeoutMs?: number; readonly visible?: boolean } = {}): Promise<number> {
    const t0 = performance.now()
    const deadline = t0 + (o.timeoutMs ?? 10_000)
    const probe = `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; ${
      o.visible === true ? "const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0" : "return true"
    } })()`
    for (;;) {
      if ((await this.eval(probe)) === true) return performance.now() - t0
      if (performance.now() >= deadline) throw new CdpError(`no element matches ${selector} after ${String(o.timeoutMs ?? 10_000)} ms`)
      await Bun.sleep(100)
    }
  }

  /** The element's innerText (textContent for non-HTML elements). Throws if nothing matches. */
  async text(selector: string): Promise<string> {
    const v = await this.eval(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? (e.innerText ?? e.textContent ?? "") : null })()`,
    )
    if (v === null) throw new CdpError(`no element matches ${selector}`)
    return String(v)
  }

  /**
   * Click the element as a user would: scroll it into view, then a real mouse
   * press and release at its centre (Input.dispatchMouseEvent), so pointer,
   * mouse and click handlers all run and whatever is on top gets the click.
   */
  async click(selector: string): Promise<{ readonly x: number; readonly y: number }> {
    const at = (await this.eval(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "center", inline: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } })()`,
    )) as { x: number; y: number; w: number; h: number } | null
    if (at === null) throw new CdpError(`no element matches ${selector}`)
    if (at.w === 0 || at.h === 0) throw new CdpError(`${selector} has no box (hidden?)`)
    const ev = { x: at.x, y: at.y, button: "left", clickCount: 1 }
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y })
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...ev })
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...ev })
    return { x: at.x, y: at.y }
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }
}
