import type { Meta, StoryObj } from "@storybook/react-vite"

import type { CloseSession } from "../../../../apps/viewer/ui/src/backend"
import { ClosePolicyDialog } from "../../../../apps/viewer/ui/src/features/close/ClosePolicyDialog"
import type { CloseFlowState } from "../../../../apps/viewer/ui/src/features/close/useCloseFlow"
import type { Status } from "../../../../apps/viewer/ui/src/model"
import { machine } from "./fixtures"

const SESSION_MS = 42_000
const ignore = (): void => undefined

type Make = (m: Status) => {
  readonly state: CloseFlowState
  readonly session: CloseSession | null
}

const meta = {
  title: "Viewer/Close Dialog",
  parameters: { layout: "fullscreen" },
  loaders: [async () => ({ machine: await machine() })],
} satisfies Meta

export default meta

function story(name: string, make: Make): StoryObj {
  return {
    name,
    render: (_args, { loaded }) => {
      const { state, session } = make(loaded.machine as Status)
      return (
        <div className="sb-stage">
          <ClosePolicyDialog
            state={state}
            session={session}
            onChoose={ignore}
            onRemember={ignore}
            onCancel={ignore}
          />
        </div>
      )
    },
  }
}

export const Asking = story("Asking", (m) => ({
  state: { kind: "asking", machine: m, index: 1, total: 1, remember: false },
  session: null,
}))

export const AskingSecondOfThree = story(
  "Second of three, remembered",
  (m) => ({
    state: {
      kind: "asking",
      machine: { ...m, name: "build-agent", title: "Build agent" },
      index: 2,
      total: 3,
      remember: true,
    },
    session: null,
  }),
)

export const SessionEnding = story("macOS is logging out", (m) => ({
  state: { kind: "asking", machine: m, index: 1, total: 1, remember: false },
  session: { kind: "waiting", deadline: Date.now() + SESSION_MS },
}))

export const SessionMissed = story("macOS stopped waiting", (m) => ({
  state: { kind: "asking", machine: m, index: 1, total: 1, remember: false },
  session: { kind: "missed" },
}))

export const WaitingForOperation = story("Waiting for a checkpoint", (m) => ({
  state: {
    kind: "waiting",
    machine: m,
    operation: { operation: "save", source: "external" },
    index: 1,
    total: 1,
  },
  session: null,
}))
