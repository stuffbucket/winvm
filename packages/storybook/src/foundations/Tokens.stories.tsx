import type { Meta, StoryObj } from "@storybook/react-vite"
import type { JSX } from "react"

import tokensCss from "../../../../apps/viewer/ui/src/styles/tokens.css?raw"

const NAMES = [
  ...new Set([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])),
].filter((name): name is string => name !== undefined)

type Kind = "color" | "size" | "radius" | "plain"

const GROUPS: readonly {
  readonly title: string
  readonly kind: Kind
  readonly match: (name: string) => boolean
}[] = [
  {
    title: "Brand, accent, link",
    kind: "color",
    match: (n) => /^--(brand|accent|link)/.test(n),
  },
  { title: "Status", kind: "color", match: (n) => n.startsWith("--status-") },
  {
    title: "Surfaces, text, borders",
    kind: "color",
    match: (n) =>
      /^--(surface|text-(strong|base-color|muted)|border-(subtle|strong))/.test(
        n,
      ),
  },
  {
    title: "Backdrop, terminal, scrims",
    kind: "color",
    match: (n) => /^--(backdrop|terminal|scrim)/.test(n),
  },
  { title: "Spacing", kind: "size", match: (n) => n.startsWith("--space-") },
  { title: "Sizing", kind: "size", match: (n) => n.startsWith("--size-") },
  { title: "Radii", kind: "radius", match: (n) => n.startsWith("--radius-") },
  {
    title: "Borders, elevation, focus",
    kind: "plain",
    match: (n) => /^--(border-width|elevation|focus)/.test(n),
  },
  {
    title: "Motion and layers",
    kind: "plain",
    match: (n) => /^--(duration|ease|z-)/.test(n),
  },
  {
    title: "Layout",
    kind: "plain",
    match: (n) => /^--(content|panel|lights|overview|checkpoints)/.test(n),
  },
]

function Specimen({
  name,
  kind,
}: {
  readonly name: string
  readonly kind: Kind
}): JSX.Element {
  if (kind === "color")
    return (
      <span
        className="sb-tokens__swatch"
        style={{ background: `var(${name})` }}
      />
    )
  if (kind === "size")
    return <span className="sb-tokens__bar" style={{ width: `var(${name})` }} />
  if (kind === "radius")
    return (
      <span
        className="sb-tokens__radius"
        style={{ borderRadius: `var(${name})` }}
      />
    )
  return <span />
}

function Row({
  name,
  kind,
}: {
  readonly name: string
  readonly kind: Kind
}): JSX.Element {
  const computed = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  return (
    <div className="sb-tokens__row">
      <Specimen name={name} kind={kind} />
      <code>{name}</code>
      <span className="sb-tokens__value">{computed}</span>
    </div>
  )
}

const meta = {
  title: "Foundations/Tokens",
  parameters: { a11y: { test: "off" } },
} satisfies Meta

export default meta

export const AllTokens: StoryObj = {
  render: () => (
    <div className="sb-tokens">
      {GROUPS.map((group) => (
        <section key={group.title}>
          <h3>{group.title}</h3>
          {NAMES.filter(group.match).map((name) => (
            <Row key={name} name={name} kind={group.kind} />
          ))}
        </section>
      ))}
    </div>
  ),
}
