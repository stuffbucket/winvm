import type { Meta, StoryObj } from "@storybook/react-vite"

import { Button } from "../../../../apps/viewer/ui/src/components/Button"
import { Icon } from "../../../../apps/viewer/ui/src/components/Icon"

const VARIANTS = ["primary", "secondary", "ghost", "destructive"] as const

const meta = {
  title: "Components/Button",
  component: Button,
  args: { children: "Take Checkpoint", variant: "primary", size: "md" },
  argTypes: {
    variant: { control: "inline-radio", options: VARIANTS },
    size: { control: "inline-radio", options: ["md", "sm"] },
  },
} satisfies Meta<typeof Button>

export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const AllVariants: Story = {
  render: () => (
    <div className="sb-stack">
      {(["md", "sm"] as const).map((size) => (
        <div key={size}>
          <p className="sb-label">{size === "md" ? "Regular" : "Small"}</p>
          <div className="sb-row">
            {VARIANTS.map((variant) => (
              <Button key={variant} variant={variant} size={size}>
                {variant === "destructive" ? "Delete Machine" : "Start Windows"}
              </Button>
            ))}
            <Button variant="primary" size={size} disabled>
              Disabled
            </Button>
          </div>
        </div>
      ))}
      <div>
        <p className="sb-label">With an icon</p>
        <div className="sb-row">
          <Button variant="primary">
            <Icon name="play" />
            Start Windows
          </Button>
          <Button variant="secondary">
            <Icon name="history" />
            Checkpoints
          </Button>
          <Button variant="ghost">
            <Icon name="folder" />
            Files
          </Button>
        </div>
      </div>
    </div>
  ),
}
