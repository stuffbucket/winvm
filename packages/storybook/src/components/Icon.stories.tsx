import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  Icon,
  type IconName,
} from "../../../../apps/viewer/ui/src/components/Icon"
import iconSource from "../../../../apps/viewer/ui/src/components/Icon.tsx?raw"

const UNION = /export type IconName =([\s\S]*?)\n\n/.exec(iconSource)?.[1] ?? ""
const NAMES = [...UNION.matchAll(/"([A-Za-z]+)"/g)]
  .map((m) => m[1])
  .filter((name): name is IconName => name !== undefined)

const meta = {
  title: "Components/Icon",
  parameters: { a11y: { test: "off" } },
} satisfies Meta

export default meta

export const Gallery: StoryObj = {
  render: () => (
    <div className="sb-icons">
      {NAMES.map((name) => (
        <div key={name} className="sb-icons__cell">
          <Icon name={name} />
          <code>{name}</code>
        </div>
      ))}
    </div>
  ),
}
