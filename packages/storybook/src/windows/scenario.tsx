import type { StoryObj } from "@storybook/react-vite"

import { type App, appIn, waitFor } from "./frame"
import { type Page, WindowFrame } from "./WindowFrame"

export interface Scenario {
  readonly page?: Page
  readonly query?: Readonly<Record<string, string>>
  readonly ready?: string
  readonly steps?: (app: App) => Promise<void>
  readonly shows?: string
}

export function scenario(name: string, s: Scenario): StoryObj {
  return {
    name,
    render: (_args, { globals }) => (
      <WindowFrame
        page={s.page ?? "index"}
        query={s.query ?? { state: "running" }}
        theme={globals.theme}
        title={`winvm: ${name}`}
      />
    ),
    play: async ({ canvasElement }) => {
      const app = await appIn(canvasElement, s.ready ?? ".toolbar")
      await s.steps?.(app)
      if (s.shows !== undefined) await waitFor(app, s.shows)
    },
  }
}
