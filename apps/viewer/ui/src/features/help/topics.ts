import type { IconName } from "../../components/Icon"

/** What the overview's list of things to do offers, in order. */
export type TopicId = "exec" | "files" | "save" | "restore" | "agent"

export interface Topic {
  readonly id: TopicId
  /** The same glyph as the toolbar button it is about. */
  readonly icon: IconName
  /** How many numbered steps (`help.<id>.step1` …). */
  readonly steps: number
  /** The pictures: each is `help.<id>.fig.<name>.alt`, and, when there is more than one, `.label`. */
  readonly figures: readonly string[]
}

export const TOPICS: readonly Topic[] = [
  { id: "exec", icon: "terminal", steps: 3, figures: ["terminal"] },
  { id: "files", icon: "folder", steps: 3, figures: ["files"] },
  { id: "save", icon: "history", steps: 3, figures: ["new"] },
  { id: "restore", icon: "history", steps: 3, figures: ["browse", "goBack"] },
  { id: "agent", icon: "agent", steps: 3, figures: ["claude"] },
]

/** The catalog keys a topic reads, so a test can check each exists. */
export function topicKeys(topic: Topic): string[] {
  const id = topic.id
  return [
    `ability.${id}`,
    `help.${id}.lead`,
    `help.${id}.note.title`,
    `help.${id}.note.body`,
    ...Array.from({ length: topic.steps }, (_, i) => `help.${id}.step${String(i + 1)}`),
    ...topic.figures.flatMap((f) => [`help.${id}.fig.${f}.alt`, ...(topic.figures.length > 1 ? [`help.${id}.fig.${f}.label`] : [])]),
  ]
}

/** The picture key for a topic's figure, as `images.ts` names them. */
export const pictureKey = (topic: TopicId, figure: string): string => `${topic}-${figure}`
