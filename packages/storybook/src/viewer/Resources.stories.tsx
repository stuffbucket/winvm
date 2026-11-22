import type { Meta, StoryObj } from "@storybook/react-vite"

import { OperationOverlay } from "../../../../apps/viewer/ui/src/features/operation/OperationOverlay"
import { Resources } from "../../../../apps/viewer/ui/src/features/usage/Resources"
import type { UsageView } from "../../../../apps/viewer/ui/src/features/usage/useUsage"
import { t } from "../../../../apps/viewer/ui/src/i18n"
import {
  type Status,
  VM_OPERATIONS,
} from "../../../../apps/viewer/ui/src/model"
import { machine, usage } from "./fixtures"

const LABELLED = [
  ...new Map(
    VM_OPERATIONS.map((operation) => [t(`operation.${operation}`), operation]),
  ).values(),
]

const meta = {
  title: "Viewer/Resources and Status",
  loaders: [
    async () => {
      const m = await machine()
      return {
        machine: m,
        windows: await usage(m, "windows"),
        mac: await usage(m, "mac"),
      }
    },
  ],
} satisfies Meta

export default meta

type Story = StoryObj

function meters(
  key: "windows" | "mac",
  held: "paused" | "asleep" | null = null,
): Story {
  return {
    render: (_args, { loaded }) => {
      const m = loaded.machine as Status
      return (
        <aside className="sb-panel">
          <Resources
            usage={loaded[key] as UsageView}
            context={{ cpus: m.cpus, overlayBytes: m.overlayBytes }}
            held={held}
          />
        </aside>
      )
    },
  }
}

export const Meters: Story = { ...meters("windows"), name: "Meters" }

export const MacOnly: Story = {
  ...meters("mac"),
  name: "Meters, no guest agent",
}

export const Paused: Story = { ...meters("windows", "paused"), name: "Paused" }

export const Asleep: Story = { ...meters("windows", "asleep"), name: "Asleep" }

export const Operations: Story = {
  name: "Operation overlay, every operation",
  render: () => (
    <div className="sb-row">
      {LABELLED.map((operation) => (
        <div key={operation} className="display display--fill sb-operation">
          <OperationOverlay operation={{ operation, source: "local" }} />
        </div>
      ))}
    </div>
  ),
}
