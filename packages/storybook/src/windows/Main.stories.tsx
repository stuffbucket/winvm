import type { Meta } from "@storybook/react-vite"

import {
  type App,
  clickOn,
  clickText,
  keys,
  liveScreen,
  menu,
  paintedScreen,
  pause,
  press,
  waitFor,
} from "./frame"
import { scenario } from "./scenario"

const NOTE =
  "Licence key is in the drawer. Office is not installed yet; ask before adding it. The display looks soft at the default size."
const CAMERA_MS = 1000
const MACHINES = "pi:stopped,scratch:running,old:paused,archive:missing"

const meta = {
  title: "Windows/Main",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta

const open = (id: string) => async (app: App) => {
  await liveScreen(app)
  await menu(app, id)
}

const checkpoints = async (app: App): Promise<void> => {
  await open("checkpoints")(app)
  await waitFor(app, ".checkpoints__canvas")
}

const card = (name: string) => async (app: App) => {
  await checkpoints(app)
  await press(app, /^Show all checkpoints/)
  await pause(CAMERA_MS)
  await clickOn(app, `.checkpoint[data-name="${name}"] .checkpoint__hit`)
}

export const OverviewStowed = scenario("Overview, stowed", {
  query: { state: "stowed" },
  ready: ".notes__field",
})

export const OverviewWithNote = scenario("Overview, machine note", {
  query: { state: "stowed", note: NOTE },
  ready: ".notes__field",
})

export const OverviewNoPicture = scenario("Overview, no picture", {
  query: { state: "stowed", pictures: "none" },
  ready: ".notes__field",
})

export const OverviewOff = scenario("Overview, shut down", {
  query: { state: "stopped" },
  shows: ".overview:not(.overview--notes) .facts",
})

export const OverviewMissing = scenario("Overview, not created", {
  query: { state: "missing" },
  shows: ".overview__note .mono",
})

export const ScreenRunning = scenario("Screen, running", {
  query: { state: "running", screen: "1" },
  steps: paintedScreen,
  shows: ".screen__held:not(.screen__held--on)",
})

export const ScreenStarting = scenario("Screen, starting", {
  query: { state: "running", agent: "silent", screen: "1" },
  steps: paintedScreen,
  shows: ".toolbar__activity",
})

export const ScreenPaused = scenario("Screen, paused", {
  query: { state: "paused", screen: "1" },
  steps: paintedScreen,
  shows: ".screen__held--on",
})

export const ScreenAsleep = scenario("Screen, asleep", {
  query: { state: "asleep", screen: "1" },
  steps: paintedScreen,
  shows: ".screen__held--on .screen__held-hint",
})

export const MachinePicker = scenario("Machine picker", {
  query: { state: "stowed", machines: MACHINES },
  steps: async (app) => {
    await clickOn(app, ".machine-picker")
    await waitFor(app, '[role="menu"]')
  },
  shows: "[role=menu] [role=menuitemradio]",
})

export const MachineRename = scenario("Machine picker, renaming", {
  query: { state: "stowed" },
  steps: async (app) => {
    await menu(app, "rename-window")
  },
  shows: ".toolbar__rename",
})

export const Details = scenario("Details and resources", {
  steps: async (app) => {
    await open("view-details")(app)
    await waitFor(app, ".panel")
  },
})

export const DetailsMacOnly = scenario("Details, no guest agent", {
  query: { state: "running", usage: "mac" },
  steps: async (app) => {
    await open("view-details")(app)
    await waitFor(app, ".panel")
  },
  shows: ".panel .resources",
})

export const SettingsPolicy = scenario("Settings, policy", {
  steps: async (app) => {
    await open("settings")(app)
    await waitFor(app, ".settings-dialog")
  },
})

export const SettingsHardware = scenario("Settings, hardware", {
  steps: async (app) => {
    await open("settings")(app)
    await waitFor(app, ".settings-dialog")
    await clickText(app, "Processors, memory and disk")
  },
  shows: ".settings-dialog .number-field",
})

export const Checkpoints = scenario("Checkpoints", { steps: checkpoints })

export const CheckpointSelected = scenario("Checkpoint selected", {
  steps: card("office-installed"),
})

export const CheckpointIncompatible = scenario("Checkpoint incompatible", {
  steps: card("old-display"),
})

export const CheckpointRestore = scenario("Checkpoint restore confirm", {
  steps: async (app) => {
    await card("office-installed")(app)
    await press(app, "Restore this checkpoint")
  },
})

export const CheckpointQuickLook = scenario("Checkpoint quick look", {
  steps: async (app) => {
    await card("office-installed")(app)
    await keys(app, " ")
    await pause(CAMERA_MS)
  },
})

export const CheckpointDelete = scenario("Checkpoint delete confirm", {
  steps: async (app) => {
    await card("old-display")(app)
    await press(app, "Delete…")
  },
})

export const CheckpointSearch = scenario("Checkpoint search", {
  steps: async (app) => {
    await checkpoints(app)
    await keys(app, "{Meta>}f{/Meta}")
    await keys(app, "office")
    await pause(CAMERA_MS)
  },
})

export const CheckpointNew = scenario("New checkpoint", {
  steps: async (app) => {
    await checkpoints(app)
    await press(app, "New Checkpoint")
  },
})

export const CheckpointsMany = scenario("Checkpoints, hundreds", {
  query: { state: "running", many: "400" },
  steps: checkpoints,
})

export const CheckpointsNoPictures = scenario("Checkpoints, no pictures", {
  query: { state: "running", pictures: "none" },
  steps: checkpoints,
})

export const Share = scenario("Use with Claude", {
  page: "help",
  steps: async (app) => {
    await open("vm-share")(app)
    await waitFor(app, ".popover")
  },
})

export const NewMachine = scenario("New machine", {
  query: { state: "stowed" },
  steps: async (app) => {
    await menu(app, "vm-new")
    await waitFor(app, "dialog[open]")
  },
})

export const DeleteMachine = scenario("Delete machine", {
  query: { state: "stowed" },
  steps: async (app) => {
    await menu(app, "vm-delete")
    await waitFor(app, "dialog[open]")
  },
})

export const ConfirmShutDown = scenario("Shut down confirm", {
  steps: async (app) => {
    await open("vm-stop")(app)
    await waitFor(app, "dialog[open]")
  },
})

export const ConfirmForceStop = scenario("Force stop confirm", {
  steps: async (app) => {
    await open("vm-kill")(app)
    await waitFor(app, "dialog[open]")
  },
})

export const Reference = scenario("Command reference", {
  steps: async (app) => {
    await open("reference")(app)
    await waitFor(app, "dialog[open]")
  },
})

export const HelpList = scenario("Help, abilities", {
  page: "help",
  query: { state: "stopped" },
  ready: ".abilities",
})

const topic = (index: number) => async (app: App) => {
  const items = await waitFor(app, ".ability")
  const all = items.ownerDocument.querySelectorAll(".ability")
  const item = all.item(index) as HTMLElement | null
  if (item === null) throw new Error(`no ability ${String(index)}`)
  item.click()
  await waitFor(app, ".help")
}

export const HelpExec = scenario("Help, run commands", {
  page: "help",
  query: { state: "stopped" },
  ready: ".abilities",
  steps: topic(0),
})

export const HelpFiles = scenario("Help, files", {
  page: "help",
  query: { state: "stopped" },
  ready: ".abilities",
  steps: topic(1),
})

export const HelpSave = scenario("Help, save", {
  page: "help",
  query: { state: "stopped" },
  ready: ".abilities",
  steps: topic(2),
})

export const HelpRestore = scenario("Help, restore", {
  page: "help",
  query: { state: "stopped" },
  ready: ".abilities",
  steps: topic(3),
})

export const HelpAgent = scenario("Help, Claude", {
  page: "help",
  query: { state: "stowed" },
  ready: ".abilities",
  steps: topic(4),
})
