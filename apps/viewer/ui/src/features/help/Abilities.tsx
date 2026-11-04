import { type KeyboardEvent, useRef, useState } from "react"

import { HelpPopover } from "../../components/HelpPopover"
import { Icon } from "../../components/Icon"
import { cx } from "../../components/cx"
import { t } from "../../i18n"
import { HelpFigure, HelpText } from "./HelpTopic"
import { TOPICS, type TopicId } from "./topics"

/**
 * What to do with this Windows machine: one row per topic in a single list,
 * each a button that opens its help beside it. The icons are the toolbar
 * buttons' own glyphs, in a column of their own, so a label that wraps stays
 * under its first line.
 */
export function Abilities(): JSX.Element {
  const [open, setOpen] = useState<TopicId | null>(null)
  const list = useRef<HTMLUListElement | null>(null)
  const rows = useRef(new Map<TopicId, HTMLButtonElement>())
  const index = TOPICS.findIndex((x) => x.id === open)
  const topic = TOPICS[index]

  const step = (delta: -1 | 1): void => {
    const next = TOPICS[(index + delta + TOPICS.length) % TOPICS.length]
    if (next !== undefined) setOpen(next.id)
  }

  // Up, Down, Home and End move between rows; Tab still visits every one.
  const arrows = (e: KeyboardEvent<HTMLUListElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at === -1) return
    const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : null
    if (to === null) return
    e.preventDefault()
    buttons[Math.max(0, Math.min(to, buttons.length - 1))]?.focus()
  }

  return (
    <section className="abilities" aria-labelledby="abilities-title">
      <h2 className="abilities__title" id="abilities-title">
        {t("abilities.title")}
      </h2>
      <ul className="abilities__list" ref={list} onKeyDown={arrows}>
        {TOPICS.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className={cx("ability", open === a.id && "ability--open")}
              aria-haspopup="dialog"
              aria-expanded={open === a.id}
              ref={(el) => {
                if (el === null) rows.current.delete(a.id)
                else rows.current.set(a.id, el)
              }}
              onClick={() => setOpen(open === a.id ? null : a.id)}
            >
              <span className="ability__icon" aria-hidden="true">
                <Icon name={a.icon} />
              </span>
              <span className="ability__label">{t(`ability.${a.id}`)}</span>
              <span className="ability__more" aria-hidden="true">
                <Icon name="forward" />
              </span>
            </button>
          </li>
        ))}
      </ul>
      {topic !== undefined && (
        <HelpPopover
          anchor={rows.current.get(topic.id) ?? null}
          scope={list.current}
          title={t(`ability.${topic.id}`)}
          media={<HelpFigure key={topic.id} topic={topic} />}
          onClose={() => setOpen(null)}
          onStep={step}
          footer={
            <>
              <span className="help__position">{t("help.position", { n: index + 1, total: TOPICS.length })}</span>
              <span className="help__nav">
                <button type="button" className="btn btn--ghost btn--icon" aria-label={t("help.previous")} title={t("help.previous")} onClick={() => step(-1)}>
                  <Icon name="back" />
                </button>
                <button type="button" className="btn btn--ghost btn--icon" aria-label={t("help.next")} title={t("help.next")} onClick={() => step(1)}>
                  <Icon name="forward" />
                </button>
              </span>
            </>
          }
        >
          <HelpText topic={topic} />
        </HelpPopover>
      )}
    </section>
  )
}
