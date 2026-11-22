import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  fontStacks,
  leading,
  text,
  tracking,
  weight,
} from "../../../../apps/viewer/ui/src/styles/theme"

const PANGRAM = "Windows 11 on Apple silicon, saved and restored in seconds"

const meta = {
  title: "Foundations/Type",
  parameters: { a11y: { test: "off" } },
} satisfies Meta

export default meta

export const Families: StoryObj = {
  render: () => (
    <div className="sb-type">
      {Object.entries(fontStacks).map(([name, stack]) => (
        <div key={name} className="sb-type__sample">
          <span className="sb-type__meta">--font-{name}</span>
          <span style={{ fontFamily: `var(--font-${name})` }}>
            {name === "symbols" ? "  " : PANGRAM}
          </span>
          <span className="sb-type__meta">{stack}</span>
        </div>
      ))}
    </div>
  ),
}

export const Ramp: StoryObj = {
  render: () => (
    <div className="sb-type">
      {Object.entries(text).map(([step, size]) => (
        <div key={step} className="sb-type__sample">
          <span className="sb-type__meta">
            --text-{step} · {size}
          </span>
          <span style={{ fontSize: `var(--text-${step})` }}>{PANGRAM}</span>
        </div>
      ))}
    </div>
  ),
}

export const WeightsAndLeading: StoryObj = {
  name: "Weights, leading, tracking",
  render: () => (
    <div className="sb-type">
      {Object.entries(weight).map(([step, w]) => (
        <div key={step} className="sb-type__sample">
          <span className="sb-type__meta">
            --weight-{step} · {w}
          </span>
          <span style={{ fontWeight: `var(--weight-${step})` }}>{PANGRAM}</span>
        </div>
      ))}
      {Object.entries(leading).map(([step, l]) => (
        <div key={step} className="sb-type__sample">
          <span className="sb-type__meta">
            --leading-{step} · {l}
          </span>
          <span style={{ lineHeight: `var(--leading-${step})` }}>
            {PANGRAM}. {PANGRAM}. {PANGRAM}.
          </span>
        </div>
      ))}
      {Object.entries(tracking).map(([step, v]) => (
        <div key={step} className="sb-type__sample">
          <span className="sb-type__meta">
            --tracking-{step} · {v}
          </span>
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontSize: `var(--text-${step})`,
              letterSpacing: `var(--tracking-${step})`,
            }}
          >
            {PANGRAM}
          </span>
        </div>
      ))}
    </div>
  ),
}
