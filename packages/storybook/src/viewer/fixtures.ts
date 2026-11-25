import { instanceUsage, winvm } from "../../../../apps/viewer/ui/src/backend"
import {
  fraction,
  parseSample,
  pushHistory,
  type Sample,
  usageFrom,
} from "../../../../apps/viewer/ui/src/features/usage/usage"
import type { UsageView } from "../../../../apps/viewer/ui/src/features/usage/useUsage"
import { parseStatus, type Status } from "../../../../apps/viewer/ui/src/model"

const SAMPLES = 30

export async function machine(): Promise<Status> {
  const found = parseStatus((await winvm("status", "--json")).stdout)?.[0]
  if (found === undefined) throw new Error("the render fake gave no status")
  return found
}

export async function usage(
  m: Status,
  guest: "windows" | "mac",
): Promise<UsageView> {
  let view: UsageView = {
    now: null,
    cpuHistory: [],
    memoryHistory: [],
    macCpuHistory: [],
  }
  let prev: Sample | null = null
  for (let i = 0; i < SAMPLES; i += 1) {
    const read = parseSample(await instanceUsage(m.pid ?? 0, m.name))
    if (read === null) throw new Error("the render fake gave no usage")
    const sample: Sample =
      guest === "windows"
        ? read
        : { ...read, guest: null, guestError: "no agent" }
    const now = usageFrom(prev, sample, m.cpus, m.memoryMiB)
    prev = sample
    view = {
      now,
      cpuHistory: pushHistory(view.cpuHistory, now.cpu),
      macCpuHistory: pushHistory(view.macCpuHistory, now.macCpu),
      memoryHistory: pushHistory(
        view.memoryHistory,
        now.memory === null ? null : fraction(now.memory),
      ),
    }
  }
  return view
}
