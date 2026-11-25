import type { Meta, StoryObj } from "@storybook/react-vite"

import { ConfirmDialog } from "../../../../apps/viewer/ui/src/components/ConfirmDialog"
import { DeleteMachineBody } from "../../../../apps/viewer/ui/src/features/machines/DeleteMachine"
import { t } from "../../../../apps/viewer/ui/src/i18n"

const ignore = (): void => undefined

const meta = {
  title: "Components/Confirm Dialog",
  component: ConfirmDialog,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="sb-stage">
        <Story />
      </div>
    ),
  ],
  args: {
    open: true,
    title: t("confirm.stop.title"),
    body: t("confirm.stop.body"),
    confirmLabel: t("action.shutDown"),
    cancelLabel: t("confirm.cancel"),
    onConfirm: ignore,
    onCancel: ignore,
  },
} satisfies Meta<typeof ConfirmDialog>

export default meta

type Story = StoryObj<typeof meta>

export const ShutDown: Story = {}

export const Restart: Story = {
  args: {
    title: t("confirm.reboot.title"),
    body: t("confirm.reboot.body"),
    confirmLabel: t("action.restart"),
  },
}

export const TurnOff: Story = {
  args: {
    title: t("confirm.kill.title"),
    body: t("confirm.kill.body"),
    confirmLabel: t("action.forceStop"),
    tone: "danger",
  },
}

export const Busy: Story = {
  args: { busy: true },
}

export const DeleteRunningMachine: Story = {
  args: {
    title: t("machine.deleteTitle", { title: "Work PC" }),
    body: (
      <DeleteMachineBody
        deleting={{ name: "canvas-test", title: "Work PC", live: true }}
        keepSaves
        busy={false}
        onKeepSaves={ignore}
      />
    ),
    confirmLabel: t("machine.deleteLive"),
    tone: "danger",
  },
}
