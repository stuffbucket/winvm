import type { Meta, StoryObj } from "@storybook/react-vite"
import { type JSX, useState } from "react"

import { MachineHeading } from "../../../../apps/viewer/ui/src/features/machines/MachineHeading"
import { MachinePicker } from "../../../../apps/viewer/ui/src/features/machines/MachinePicker"
import type { Phase } from "../../../../apps/viewer/ui/src/model"

const ignore = (): void => undefined
const NAMES = ["canvas-test", "pi", "scratch", "old", "archive"]
const TITLES = {
  "canvas-test": "Work PC",
  pi: null,
  scratch: "Scratch",
  old: null,
  archive: null,
}
const PHASES: Record<string, Phase> = {
  "canvas-test": "running",
  pi: "stopped",
  scratch: "stowed",
  old: "paused",
  archive: "missing",
}

const meta = {
  title: "Viewer/Machines",
} satisfies Meta

export default meta

type Story = StoryObj

function Picker({ renaming }: { readonly renaming: boolean }): JSX.Element {
  const [name, setName] = useState("canvas-test")
  return (
    <header className="toolbar">
      <MachinePicker
        names={NAMES}
        name={name}
        titles={TITLES}
        phases={PHASES}
        phase={PHASES[name] ?? null}
        renaming={renaming}
        onRenamed={ignore}
        onSelect={setName}
        onNew={ignore}
        onRename={ignore}
        onDelete={ignore}
      />
    </header>
  )
}

export const PickerClosed: Story = {
  name: "Picker",
  render: () => <Picker renaming={false} />,
}

export const PickerRenaming: Story = {
  name: "Picker, renaming",
  render: () => <Picker renaming />,
}

const rename = (title: string): Promise<string | null> =>
  Promise.resolve(title.trim() === "" ? null : title)

export const Heading: Story = {
  name: "Heading, titled",
  render: () => (
    <div className="sb-pane">
      <MachineHeading
        text="Work PC"
        shown="Work PC"
        hasTitle
        onRename={rename}
      />
    </div>
  ),
}

export const HeadingUntitled: Story = {
  name: "Heading, untitled",
  render: () => (
    <div className="sb-pane">
      <MachineHeading
        text=""
        shown="canvas-test"
        hasTitle={false}
        onRename={rename}
      />
    </div>
  ),
}
