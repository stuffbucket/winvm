import { useState } from "react"

import { cx } from "../../components/cx"
import { t } from "../../i18n"
import { IMAGES } from "./images"
import { pictureKey, type Topic } from "./topics"

/** A topic's picture, in the OS's light or dark; with several, buttons name each and pick which shows. */
export function HelpFigure({ topic }: { readonly topic: Topic }): JSX.Element {
  const [shown, setShown] = useState(0)
  const several = topic.figures.length > 1
  const name = topic.figures[shown] ?? topic.figures[0] ?? ""
  const image = IMAGES[pictureKey(topic.id, name)]
  return (
    <figure className="help__figure">
      {image !== undefined && (
        <picture>
          <source media="(prefers-color-scheme: dark)" srcSet={image.dark} />
          <img className="help__image" src={image.light} alt={t(`help.${topic.id}.fig.${name}.alt`)} width={image.width} height={image.height} />
        </picture>
      )}
      {several && (
        <div className="help__views" role="group" aria-label={t(`ability.${topic.id}`)}>
          {topic.figures.map((f, i) => (
            <button key={f} type="button" className={cx("help__view", i === shown && "help__view--on")} aria-pressed={i === shown} onClick={() => setShown(i)}>
              {t(`help.${topic.id}.fig.${f}.label`)}
            </button>
          ))}
        </div>
      )}
    </figure>
  )
}

/** What a topic says: one sentence, the steps, and one thing worth knowing. */
export function HelpText({ topic }: { readonly topic: Topic }): JSX.Element {
  const id = topic.id
  return (
    <>
      <p className="help__lead">{t(`help.${id}.lead`)}</p>
      <ol className="help__steps">
        {Array.from({ length: topic.steps }, (_, i) => (
          <li key={i}>{t(`help.${id}.step${String(i + 1)}`)}</li>
        ))}
      </ol>
      <div className="help__note">
        <h3 className="help__note-title">{t(`help.${id}.note.title`)}</h3>
        <p>{t(`help.${id}.note.body`)}</p>
      </div>
    </>
  )
}
