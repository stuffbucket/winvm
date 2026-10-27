const { invoke } = window.__TAURI__.core

const $ = (id) => document.getElementById(id)

function say(text) {
  $("status").textContent = text
}

function show(out) {
  $("output").textContent = [out.stdout, out.stderr].filter(Boolean).join("\n").trim()
}

async function winvm(...args) {
  const out = await invoke("winvm", { args })
  show(out)
  return out
}

function item(text, cls) {
  const li = document.createElement("li")
  li.textContent = text
  if (cls) li.className = cls
  return li
}

async function host() {
  const out = await winvm("doctor")
  const lines = out.stdout.split("\n").filter((l) => /^(ok|MISS)\s/.test(l))
  const list = $("host")
  list.replaceChildren(
    ...lines.map((l) => item(l.replace(/^(ok|MISS)\s+/, ""), l.startsWith("ok") ? "ok" : "bad")),
  )
  if (lines.length === 0) list.replaceChildren(item(out.stderr.trim() || "winvm doctor printed nothing", "bad"))
}

function instancesFrom(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    if (Array.isArray(parsed.instances)) return parsed.instances
    return parsed.state === "missing" ? [] : [parsed]
  } catch {
    return null
  }
}

function button(label, verb, name, enabled) {
  const b = document.createElement("button")
  b.type = "button"
  b.textContent = label
  b.disabled = !enabled
  b.addEventListener("click", () => act(verb, name, label))
  return b
}

async function instances() {
  const out = await winvm("status", "--json")
  const all = instancesFrom(out.stdout)
  const list = $("instances")
  if (all === null) {
    const last = out.stderr.trim().split("\n").find((l) => /error/i.test(l)) ?? `exit ${out.code}`
    list.replaceChildren(item(`winvm status failed: ${last}`, "bad"))
    $("output-panel").open = true
    return
  }
  if (all.length === 0) {
    list.replaceChildren(item("No instances yet. Start one to create “default”.", "muted"))
    list.append(row({ name: "default", state: "stopped" }))
    return
  }
  list.replaceChildren(...all.map(row))
}

function row(s) {
  const li = document.createElement("li")
  const left = document.createElement("div")
  const name = document.createElement("span")
  name.className = "name"
  name.textContent = s.name
  const detail = document.createElement("span")
  detail.className = "detail"
  detail.textContent = [s.state, s.image].filter(Boolean).join(" · ")
  left.append(name, detail)
  const running = s.state === "running" || s.state === "paused"
  const right = document.createElement("div")
  right.className = "actions"
  right.append(
    button("Start", "start", s.name, !running),
    button("Open", "open", s.name, running),
    button("Stop", "stop", s.name, running),
  )
  li.append(left, right)
  return li
}

async function act(verb, name, label) {
  for (const b of document.querySelectorAll("button")) b.disabled = true
  say(`${label} ${name}…`)
  try {
    const out = await winvm(verb, "-i", name)
    say(out.code === 0 ? `${label} ${name}: done` : `${label} ${name} failed (exit ${out.code}); see Last command`)
    if (out.code !== 0) $("output-panel").open = true
  } catch (e) {
    say(String(e))
  }
  await refresh()
}

async function refresh() {
  say("Refreshing…")
  try {
    await host()
    await instances()
    say("")
  } catch (e) {
    say(String(e))
  }
  for (const b of $("refresh").parentElement.querySelectorAll("button")) b.disabled = false
}

$("refresh").addEventListener("click", refresh)
$("install-cli").addEventListener("click", async () => {
  try {
    say(`winvm is now at ${await invoke("install_cli")}`)
  } catch (e) {
    say(String(e))
  }
})

refresh()
