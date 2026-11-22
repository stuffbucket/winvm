import type { Meta, StoryObj } from "@storybook/react-vite"

import { MachineHeading } from "../../../../apps/viewer/ui/src/features/machines/MachineHeading"
import { type Status, shownTitle } from "../../../../apps/viewer/ui/src/model"
import { machine } from "./fixtures"

const rename = (title: string): Promise<string | null> =>
  Promise.resolve(title.trim() === "" ? null : title)

const meta = {
  title: "Viewer/Machines",
  loaders: [async () => ({ machine: await machine() })],
} satisfies Meta

export default meta

function heading(name: string, titled: boolean): StoryObj {
  return {
    name,
    render: (_args, { loaded }) => {
      const m = loaded.machine as Status
      const title = titled ? m.title : null
      return (
        <div className="sb-pane">
          <MachineHeading
            text={title ?? ""}
            shown={shownTitle(m.name, title)}
            hasTitle={title !== null}
            onRename={rename}
          />
        </div>
      )
    },
  }
}

export const Heading = heading("Heading, titled", true)

export const HeadingUntitled = heading("Heading, untitled", false)
