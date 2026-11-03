import { useEffect, useRef, useState } from "react"

import { NumberField } from "../../components/NumberField"
import { t } from "../../i18n"
import { formatGB } from "../usage/usage"
import { formatMemory, fromGB, pendingRestart, toGB } from "./info"
import type { MachineInfoView } from "./useMachineInfo"

/** How long a run of stepper presses or arrow keys settles before it is written. */
const SETTLE_MS = 500

/**
 * The panel's Hardware: processors and memory for the next start, and the
 * disk's size. A running machine keeps its size; a change waits for the next
 * start, and says so while the two differ.
 */
export function Hardware({ view }: { readonly view: MachineInfoView }): JSX.Element {
  const info = view.info
  const next = info?.hardware.next ?? null
  const [cpus, setCpus] = useState(next?.cpus ?? 0)
  const [gb, setGb] = useState(next === null ? 0 : toGB(next.memoryMiB))
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // What winvm says is set wins over what was typed, once it answers.
  useEffect(() => {
    if (next === null) return
    setCpus(next.cpus)
    setGb(toGB(next.memoryMiB))
  }, [next?.cpus, next?.memoryMiB])

  useEffect(() => () => clearTimeout(timer.current), [])

  if (info === null)
    return view.error === null ? <p className="panel__note">{t("state.loading")}</p> : <p className="action__error">{view.error}</p>

  const { limits, running, diskBytes } = info.hardware
  // Both values each time, so a processors change and a memory change made
  // within the settling time are written together rather than one replacing the other.
  const commit = (size: { cpus: number; memoryMiB: number }): void => {
    clearTimeout(timer.current)
    const set = info.hardware.next
    timer.current = setTimeout(() => {
      if (size.cpus !== set.cpus || size.memoryMiB !== set.memoryMiB) view.setSize(size)
    }, SETTLE_MS)
  }

  return (
    <div className="action">
      <dl className="kv">
        <div className="kv__row kv__row--center">
          <dt>{t("hardware.cpus")}</dt>
          <dd>
            <NumberField
              value={cpus}
              min={limits.cpus.min}
              max={limits.cpus.max}
              disabled={view.working}
              label={t("hardware.cpus")}
              decrementLabel={t("hardware.fewer")}
              incrementLabel={t("hardware.more")}
              onValueChange={setCpus}
              onValueCommitted={(v) => commit({ cpus: v, memoryMiB: fromGB(gb) })}
            />
          </dd>
        </div>
        <div className="kv__row kv__row--center">
          <dt>{t("hardware.memory")}</dt>
          <dd>
            <NumberField
              value={gb}
              min={toGB(limits.memoryMiB.min)}
              max={toGB(limits.memoryMiB.max)}
              step={toGB(limits.memoryMiB.step)}
              disabled={view.working}
              label={t("hardware.memoryGB")}
              decrementLabel={t("hardware.less")}
              incrementLabel={t("hardware.more")}
              unit={t("hardware.gb")}
              onValueChange={setGb}
              onValueCommitted={(v) => commit({ cpus, memoryMiB: fromGB(v) })}
            />
          </dd>
        </div>
        {diskBytes !== null && (
          <div className="kv__row">
            <dt>{t("hardware.disk")}</dt>
            <dd>{formatGB(diskBytes)}</dd>
          </div>
        )}
      </dl>

      {running !== null && pendingRestart(info) && (
        <p className="action__hint" role="status">
          {t("hardware.pending", { cpus: running.cpus, memory: formatMemory(running.memoryMiB) })}
        </p>
      )}
      <p className="action__hint">{t("hardware.limits", { cpus: limits.cpus.max, memory: formatMemory(limits.memoryMiB.max) })}</p>
      {view.error !== null && <p className="action__error">{view.error}</p>}
    </div>
  )
}
