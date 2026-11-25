import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  Notices,
  type NoticesProps,
} from "../../../../apps/viewer/ui/src/features/notices/Notices"
import { t } from "../../../../apps/viewer/ui/src/i18n"
import { RESTORED_BUSY } from "../../../../apps/viewer/ui/src/model"

const SESSION_MS = 42_000
const ignore = (): void => undefined

const NONE: NoticesProps = {
  failure: null,
  session: null,
  closeFailed: null,
  finding: null,
  notice: null,
  copyJob: null,
  copyResult: null,
  checks: null,
  operating: false,
  statusError: null,
  onDismissFailure: ignore,
  onDismissCloseFailed: ignore,
  onDismissNotice: ignore,
  onDismissCopy: ignore,
  onReveal: ignore,
  onSetup: ignore,
}

const meta = {
  title: "Components/Banners",
  component: Notices,
  args: NONE,
  decorators: [
    (Story) => (
      <div className="sb-pane">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Notices>

export default meta

type Story = StoryObj<typeof meta>

export const OperationFailed: Story = {
  args: {
    failure: {
      verb: "start",
      code: 1,
      output:
        "qemu-system-aarch64: -drive file=disk.qcow2: Could not open: Resource busy",
    },
  },
}

export const RestoredBusy: Story = {
  args: {
    failure: {
      verb: "load",
      code: RESTORED_BUSY,
      output: "Windows Update is still installing.",
    },
  },
}

export const SessionEnding: Story = {
  args: { session: { kind: "waiting", deadline: Date.now() + SESSION_MS } },
}

export const SessionMissed: Story = {
  args: { session: { kind: "missed" } },
}

export const CloseFailed: Story = {
  args: {
    closeFailed: { message: "winvm stow: the guest agent did not answer" },
  },
}

export const FinderOpening: Story = {
  args: { finding: "Desktop" },
}

export const Notice: Story = {
  args: {
    notice: {
      tone: "error",
      title: t("machine.deleteFailed", { title: "Work PC" }),
      detail: "winvm delete: the machine is running",
    },
  },
}

export const Copying: Story = {
  args: { copyJob: { way: "in", done: 1, total: 5, name: "budget.xlsx" } },
}

export const CopiedIn: Story = {
  args: {
    copyResult: {
      ok: true,
      title: t("files.copiedIn", { name: "budget.xlsx", folder: "Desktop" }),
    },
  },
}

export const CopyFailed: Story = {
  args: {
    copyResult: {
      ok: false,
      title: t("files.copyFailed"),
      detail: "setup.exe: not enough space on C:",
    },
  },
}

export const ItemNotCopied: Story = {
  args: {
    copyResult: {
      ok: false,
      title: t("files.notCopied", { count: 1 }),
      detail: "install.log: the file is in use",
    },
  },
}

export const HostNotReady: Story = {
  args: {
    checks: {
      ready: false,
      timeMachine: "ok",
      checks: [{ label: "Runtime", ok: false, hint: "winvm setup" }],
    },
  },
}

export const StatusError: Story = {
  args: { statusError: "winvm status: config.json is not valid JSON" },
}

export const Stacked: Story = {
  name: "Several at once",
  args: {
    failure: {
      verb: "stop",
      code: 1,
      output: "the guest did not shut down in 60 s",
    },
    session: { kind: "missed" },
  },
}
