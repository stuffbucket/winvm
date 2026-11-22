import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  radii,
  size,
  spacing,
} from "../../../../apps/viewer/ui/src/styles/theme"

const meta = {
  title: "Foundations/Spacing",
  parameters: { a11y: { test: "off" } },
} satisfies Meta

export default meta

export const Scale: StoryObj = {
  name: "Spacing, sizing, radii",
  render: () => (
    <div className="sb-tokens">
      <section>
        <h3>Spacing</h3>
        {Object.entries(spacing).map(([step, v]) => (
          <div key={step} className="sb-tokens__row">
            <span
              className="sb-tokens__bar"
              style={{ width: `var(--space-${step})` }}
            />
            <code>--space-{step}</code>
            <span className="sb-tokens__value">{v}</span>
          </div>
        ))}
      </section>
      <section>
        <h3>Sizing</h3>
        {Object.entries(size).map(([step, v]) => (
          <div key={step} className="sb-tokens__row">
            <span
              className="sb-tokens__swatch"
              style={{
                width: `var(--size-${step})`,
                height: `var(--size-${step})`,
                background: "var(--accent)",
              }}
            />
            <code>--size-{step}</code>
            <span className="sb-tokens__value">{v}</span>
          </div>
        ))}
      </section>
      <section>
        <h3>Radii</h3>
        {Object.entries(radii).map(([step, v]) => (
          <div key={step} className="sb-tokens__row">
            <span
              className="sb-tokens__radius"
              style={{ borderRadius: `var(--radius-${step})` }}
            />
            <code>--radius-{step}</code>
            <span className="sb-tokens__value">{v}</span>
          </div>
        ))}
      </section>
    </div>
  ),
}
