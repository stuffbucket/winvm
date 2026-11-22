import type { Meta } from "@storybook/react-vite"

import { waitFor } from "./frame"
import { scenario } from "./scenario"

const meta = {
  title: "Windows/Files and Terminal",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta

const FILES = { instance: "canvas-test", title: "Work PC" }

export const Files = scenario("Files, Desktop", {
  page: "files",
  query: FILES,
  ready: ".fw__side",
  steps: async (app) => {
    await waitFor(app, '[role="row"], [role="option"], li')
  },
})

export const FilesMachineOff = scenario("Files, machine shut down", {
  page: "files",
  query: { ...FILES, state: "stopped" },
  ready: ".fw__side",
})

export const TerminalUnreachable = scenario("Terminal, no connection", {
  page: "terminal",
  ready: ".term",
  shows: ".term__status",
})

export const TerminalMachineOff = scenario("Terminal, machine shut down", {
  page: "terminal",
  query: { state: "stopped" },
  ready: ".term",
  shows: ".term__status",
})
