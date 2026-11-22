import type { Meta, StoryObj } from "@storybook/react-vite"

import { Button } from "../../../../apps/viewer/ui/src/components/Button"
import { Callout } from "../../../../apps/viewer/ui/src/components/Callout"
import { SessionEndNote } from "../../../../apps/viewer/ui/src/features/close/SessionEndNote"
import { t } from "../../../../apps/viewer/ui/src/i18n"

const SESSION_MS = 42_000

const dismiss = (
  <Button size="sm" variant="ghost">
    {t("action.dismiss")}
  </Button>
)

const meta = {
  title: "Components/Banners",
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="notices sb-pane">
        <Story />
      </div>
    ),
  ],
} satisfies Meta

export default meta

type Story = StoryObj

export const OperationFailed: Story = {
  render: () => (
    <Callout tone="error" title={t("error.start")} action={dismiss}>
      <pre className="output">
        qemu-system-aarch64: -drive file=disk.qcow2: Could not open: Resource
        busy
      </pre>
    </Callout>
  ),
}

export const RestoredBusy: Story = {
  render: () => (
    <Callout tone="notice" title={t("notice.restoredBusy")} action={dismiss}>
      <pre className="output">Windows Update is still installing.</pre>
    </Callout>
  ),
}

export const SessionEnding: Story = {
  render: () => (
    <Callout tone="notice" title={t("close.sessionTitle")}>
      <SessionEndNote
        session={{ kind: "waiting", deadline: Date.now() + SESSION_MS }}
      />
    </Callout>
  ),
}

export const SessionMissed: Story = {
  render: () => (
    <Callout tone="notice" title={t("close.sessionTitle")}>
      <SessionEndNote session={{ kind: "missed" }} />
    </Callout>
  ),
}

export const CloseFailed: Story = {
  render: () => (
    <Callout tone="error" title={t("close.failed")} action={dismiss}>
      <pre className="output">winvm stow: the guest agent did not answer</pre>
    </Callout>
  ),
}

export const FinderOpening: Story = {
  render: () => (
    <Callout
      tone="notice"
      title={t("files.finder.opening", { place: "Desktop" })}
    >
      <p>{t("files.finder.firstTime")}</p>
    </Callout>
  ),
}

export const Copying: Story = {
  render: () => (
    <Callout tone="notice" title={t("files.copying", { name: "budget.xlsx" })}>
      <p>{t("files.ofTotal", { done: 2, total: 5 })}</p>
    </Callout>
  ),
}

export const CopyFailed: Story = {
  render: () => (
    <Callout tone="error" title={t("error.put")} action={dismiss}>
      <pre className="output">setup.exe: not enough space on C:</pre>
    </Callout>
  ),
}

export const HostNotReady: Story = {
  render: () => (
    <Callout
      tone="error"
      title={t("host.notReady")}
      action={
        <Button size="sm" variant="primary">
          {t("action.setup")}
        </Button>
      }
    >
      <p>{t("host.runtimeMissing")}</p>
    </Callout>
  ),
}

export const StatusError: Story = {
  render: () => (
    <Callout tone="error" title={t("error.status")}>
      <pre className="output">winvm status: config.json is not valid JSON</pre>
    </Callout>
  ),
}

export const Stacked: Story = {
  name: "Several at once",
  render: () => (
    <>
      <Callout tone="error" title={t("error.stop")} action={dismiss}>
        <pre className="output">the guest did not shut down in 60 s</pre>
      </Callout>
      <Callout tone="notice" title={t("close.sessionTitle")}>
        <SessionEndNote session={{ kind: "missed" }} />
      </Callout>
    </>
  ),
}
