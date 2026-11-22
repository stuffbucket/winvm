import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  Icon,
  type IconName,
} from "../../../../apps/viewer/ui/src/components/Icon"
import iconSource from "../../../../apps/viewer/ui/src/components/Icon.tsx?raw"
import { iconNames } from "../icons"

const NAMES = iconNames(iconSource) as IconName[]

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
