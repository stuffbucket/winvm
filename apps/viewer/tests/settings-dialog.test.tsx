import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { SettingsDialog } = await import("../ui/src/features/settings/SettingsDialog")
type View = import("../ui/src/features/hardware/useMachineInfo").MachineInfoView
const view: View = { info: null, error: null, working: false, setSize: () => undefined }
const policy = { "autosave.enabled": true, "autosave.idleMinutes": 10, "autosave.keep": 3, "stow.enabled": true, "stow.idleMinutes": 60, "watch.enabled": true, "power.keepAwake": false }
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => { act(() => root?.unmount()); root = null; document.body.replaceChildren(); delete (window as { __TAURI__?: unknown }).__TAURI__ })
afterAll(() => GlobalRegistrator.unregister())

async function render(reply: { code: number; stdout: string; stderr: string }): Promise<HTMLElement> {
  Object.assign(window, { __TAURI__: { core: { invoke: async () => reply } } })
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root?.render(<SettingsDialog instance="dev-policy" title="Work PC" machineInfo={view} pauseOverlay onPauseOverlay={() => undefined} onClose={() => undefined} />) })
  return host
}

test("a failed read shows an error and cannot submit invented defaults", async () => {
  const host = await render({ code: 1, stdout: "", stderr: "config.json is unreadable" })
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("config.json is unreadable")
  expect(host.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true)
  expect(host.querySelector('input[type="number"]')).toBeNull()
})

test("turning monitoring off disables its subordinate fields without losing their values", async () => {
  const host = await render({ code: 0, stdout: JSON.stringify(policy), stderr: "" })
  const watch = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]
  if (!watch) throw new Error("missing monitoring toggle")
  act(() => watch.click())
  expect(host.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true)
  expect([...host.querySelectorAll<HTMLInputElement>('input[type="number"]')].map((e) => e.value)).toEqual(["10", "3", "60"])
  expect(host.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(false)
})
