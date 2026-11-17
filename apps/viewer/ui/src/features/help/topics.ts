import type { IconName } from "../../components/Icon"

export type TopicId = "exec" | "files" | "save" | "restore" | "agent"

export interface Topic {
  readonly id: TopicId
  readonly icon: IconName
  readonly steps: number
  readonly figures: readonly string[]
}

export const TOPICS: readonly Topic[] = [
  { id: "exec", icon: "terminal", steps: 3, figures: ["terminal"] },
  { id: "files", icon: "folder", steps: 3, figures: ["files"] },
  { id: "save", icon: "history", steps: 3, figures: ["new"] },
  { id: "restore", icon: "history", steps: 3, figures: ["browse", "goBack"] },
  { id: "agent", icon: "agent", steps: 3, figures: ["claude"] },
]

export function topicKeys(topic: Topic): string[] {
  const id = topic.id
  return [
    `ability.${id}`,
    `help.${id}.lead`,
    `help.${id}.note.title`,
    `help.${id}.note.body`,
    ...Array.from(
      { length: topic.steps },
      (_, i) => `help.${id}.step${String(i + 1)}`,
    ),
    ...topic.figures.flatMap((f) => [
      `help.${id}.fig.${f}.alt`,
      ...(topic.figures.length > 1 ? [`help.${id}.fig.${f}.label`] : []),
    ]),
  ]
}

export const pictureKey = (topic: TopicId, figure: string): string =>
  `${topic}-${figure}`
