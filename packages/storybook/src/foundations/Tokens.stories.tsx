import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, JSX } from "react"

import tokensCss from "../../../../apps/viewer/ui/src/styles/tokens.css?raw"

const NAMES = [
  ...new Set([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])),
].filter((name): name is string => name !== undefined)

type Kind = "color" | "size" | "radius" | "type" | "plain"

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
  {
    title: "Type",
    kind: "type",
    match: (n) => /^--(font|text|weight|leading|tracking)-/.test(n),
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

function typeStyle(name: string): CSSProperties {
  if (name.startsWith("--font-")) return { fontFamily: `var(${name})` }
  if (name.startsWith("--weight-")) return { fontWeight: `var(${name})` }
  if (name.startsWith("--text-")) return { fontSize: `var(${name})` }
  return {}
}

const groupOf = (name: string): string =>
  GROUPS.find((group) => group.match(name))?.title ?? OTHER.title

const OTHER = { title: "Other", kind: "plain" as Kind }

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
  if (kind === "type") return <span style={typeStyle(name)}>Aa</span>
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
      {[...GROUPS, OTHER].map((group) => (
        <section key={group.title}>
          <h3>{group.title}</h3>
          {NAMES.filter((name) => groupOf(name) === group.title).map((name) => (
            <Row key={name} name={name} kind={group.kind} />
          ))}
        </section>
      ))}
    </div>
  ),
}
