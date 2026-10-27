// The winvm web page: the guest's screen (noVNC over QEMU's websocket), its
// status, and buttons that run the CLI through the local server.
//
// The access token arrives in the URL fragment (#token=...), which the browser
// never sends anywhere; every API call carries it in a header.
import RFB from "./novnc/core/rfb.js"

const $ = (id) => document.getElementById(id)
const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? ""
let instance = new URLSearchParams(location.search).get("i") ?? ""

let rfb = null
let rfbTarget = "" // "port|password" the current connection was made with
let pollTimer = null

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...(opts.headers ?? {}), "x-winvm-token": token } })
  if (r.status === 401) throw new Error("this page's access token is missing or stale — reopen it with `winvm open --web`")
  return r
}

async function apiJson(path, opts) {
  const r = await api(path, opts)
  const body = await r.json().catch(() => ({}))
  if (!r.ok && body.error === undefined) body.error = `HTTP ${r.status}`
  return { ok: r.ok, status: r.status, body }
}

// --- the screen ------------------------------------------------------------

function screenMessage(text) {
  const el = $("screen-msg")
  el.textContent = text
  el.hidden = text === ""
}

function disconnectScreen() {
  if (rfb !== null) {
    const old = rfb
    rfb = null
    rfbTarget = ""
    try { old.disconnect() } catch { /* already gone */ }
  }
}

function connectScreen(vnc) {
  const target = `${vnc.websocketPort}|${vnc.password}`
  if (rfb !== null && rfbTarget === target) return
  disconnectScreen()
  screenMessage("connecting to the screen…")
  const conn = new RFB($("screen"), `ws://127.0.0.1:${vnc.websocketPort}`, {
    credentials: { password: vnc.password },
    // QEMU's websocket server only speaks the "binary" subprotocol.
    wsProtocols: ["binary"],
  })
  conn.scaleViewport = true
  conn.background = "#000"
  conn.addEventListener("connect", () => {
    screenMessage("")
    $("screen-state").textContent = `screen: connected (VNC :${vnc.display})`
  })
  conn.addEventListener("credentialsrequired", () => conn.sendCredentials({ password: vnc.password }))
  conn.addEventListener("securityfailure", (e) => {
    screenMessage(`the VNC server refused the password (${e.detail.reason ?? "no reason given"}) — try \`winvm open --web\` again`)
  })
  conn.addEventListener("disconnect", () => {
    if (rfb !== conn) return
    rfb = null
    rfbTarget = ""
    $("screen-state").textContent = "screen: disconnected"
    screenMessage("screen disconnected — reconnecting…")
    // The next status poll reconnects if the guest is still up.
  })
  rfb = conn
  rfbTarget = target
}

// --- status ----------------------------------------------------------------

function renderStatus(data) {
  const s = data.status
  const badge = $("state")
  badge.textContent = s.state
  badge.dataset.state = s.state
  $("title").textContent = data.report.title
  const rows = $("rows")
  rows.replaceChildren()
  for (const [k, v] of data.report.rows) {
    const dt = document.createElement("dt")
    dt.textContent = k
    const dd = document.createElement("dd")
    dd.textContent = v
    rows.append(dt, dd)
  }
  const notes = $("notes")
  notes.replaceChildren(...data.report.notes.map((n) => Object.assign(document.createElement("li"), { textContent: n })))

  const select = $("load-name")
  const chosen = select.value
  select.replaceChildren(
    ...(data.saves.length === 0
      ? [Object.assign(document.createElement("option"), { textContent: "(no saves)", value: "" })]
      : data.saves.map((sv) =>
          Object.assign(document.createElement("option"), {
            value: sv.name,
            textContent: `${sv.name} — ${sv.kind}, ${new Date(sv.createdAt).toLocaleString()}`,
          }),
        )),
  )
  if (data.saves.some((sv) => sv.name === chosen)) select.value = chosen

  if (data.vnc !== null) {
    connectScreen(data.vnc)
  } else {
    disconnectScreen()
    $("screen-state").textContent = ""
    screenMessage(
      s.state === "missing"
        ? `instance "${s.name}" does not exist`
        : `"${s.name}" is ${s.state} — press Start${s.state === "stowed" ? " or Load" : ""}`,
    )
  }
}

async function refresh() {
  if (instance === "") return
  try {
    const { ok, body } = await apiJson(`/api/status?i=${encodeURIComponent(instance)}`)
    if (!ok) throw new Error(body.error)
    renderStatus(body)
  } catch (error) {
    $("title").textContent = `status unavailable: ${error.message}`
  }
}

function schedule() {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    if (!document.hidden) await refresh()
    schedule()
  }, 5000)
}

// --- actions ---------------------------------------------------------------

function setBusy(busy) {
  for (const b of document.querySelectorAll("aside button")) b.disabled = busy
}

async function act(verb, arg) {
  setBusy(true)
  const head = $("job-head")
  const out = $("job-output")
  head.className = "muted"
  head.textContent = `${verb}${arg ? ` ${arg}` : ""}: starting…`
  out.textContent = ""
  try {
    const { ok, body } = await apiJson("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instance, verb, arg }),
    })
    if (!ok) throw new Error(body.error)
    let job = body
    head.textContent = `winvm ${job.argv.join(" ")} — running…`
    while (job.exitCode === null) {
      await new Promise((r) => setTimeout(r, 1000))
      const next = await apiJson(`/api/job?id=${job.id}`)
      if (!next.ok) throw new Error(next.body.error)
      job = next.body
      out.textContent = job.output
      out.scrollTop = out.scrollHeight
    }
    head.className = job.exitCode === 0 ? "done" : "fail"
    head.textContent = `winvm ${job.argv.join(" ")} — ${job.exitCode === 0 ? "done" : `failed (exit ${job.exitCode})`}`
    out.textContent = job.output
    // An unknown verb prints the usage and exits 2: say that plainly instead.
    if (job.exitCode === 2 && job.output.startsWith("winvm <command>")) {
      head.textContent = `"${verb}" isn't a command in this copy of winvm yet`
      out.textContent = ""
    }
  } catch (error) {
    head.className = "fail"
    head.textContent = `${verb}: ${error.message}`
  } finally {
    setBusy(false)
    await refresh()
  }
}

async function screenshot() {
  const head = $("job-head")
  try {
    const r = await api(`/api/screenshot?i=${encodeURIComponent(instance)}`)
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
    const url = URL.createObjectURL(await r.blob())
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `${instance}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    })
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    head.className = "done"
    head.textContent = "screenshot saved to your downloads"
  } catch (error) {
    head.className = "fail"
    head.textContent = `screenshot: ${error.message}`
  }
}

// --- wiring ----------------------------------------------------------------

async function loadInstances() {
  const { ok, body } = await apiJson("/api/instances")
  if (!ok) throw new Error(body.error)
  const names = body.instances
  if (instance === "") instance = names[0] ?? "default"
  if (!names.includes(instance)) names.unshift(instance)
  $("instance").replaceChildren(
    ...names.map((n) => Object.assign(document.createElement("option"), { value: n, textContent: n })),
  )
  $("instance").value = instance
}

function wire() {
  for (const b of document.querySelectorAll("button[data-verb]")) {
    b.addEventListener("click", () => act(b.dataset.verb, b.dataset.arg))
  }
  $("save-form").addEventListener("submit", (e) => {
    e.preventDefault()
    act("save", $("save-name").value.trim() || undefined)
  })
  $("load-form").addEventListener("submit", (e) => {
    e.preventDefault()
    const name = $("load-name").value
    if (name !== "") act("load", name)
  })
  $("shot").addEventListener("click", screenshot)
  $("instance").addEventListener("change", (e) => {
    instance = e.target.value
    const url = new URL(location.href)
    url.searchParams.set("i", instance)
    history.replaceState(null, "", url)
    disconnectScreen()
    refresh()
  })
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh()
  })
}

async function main() {
  wire()
  if (token === "") {
    screenMessage("this page needs its access token — open it with `winvm open --web`")
    return
  }
  try {
    await loadInstances()
  } catch (error) {
    screenMessage(error.message)
    return
  }
  document.title = `winvm — ${instance}`
  await refresh()
  schedule()
}

main()
