import type { Meta, StoryObj } from "@storybook/react-vite"
import type { JSX } from "react"

import {
  type Check,
  DECORATIVE,
  matrix,
  passes,
  THEME_NAMES,
  type Theme,
  unclassified,
  value,
} from "../contrast"

const meta = {
  title: "Foundations/Contrast",
  parameters: { a11y: { test: "off" } },
} satisfies Meta

export default meta

function Sample({ check }: { readonly check: Check }): JSX.Element {
  const fg = value(check.theme, check.fg)
  const bg = value(check.theme, check.bg)
  if (check.role === "non-text")
    return (
      <span className="sb-contrast__sample" style={{ background: bg }}>
        <span className="sb-contrast__mark" style={{ background: fg }} />
      </span>
    )
  return (
    <span className="sb-contrast__sample" style={{ background: bg, color: fg }}>
      Aa
    </span>
  )
}

function ThemePanel({
  theme,
  checks,
}: {
  readonly theme: Theme
  readonly checks: readonly Check[]
}): JSX.Element {
  const failing = checks.filter((c) => !passes(c)).length
  const ink = (token: string): string => value(theme, token)
  return (
    <section
      className="sb-contrast__panel"
      style={{ background: ink("surface-base"), color: ink("text-strong") }}
    >
      <h3 className="sb-contrast__title">
        {theme === "dark" ? "Dark" : "Light"}:{" "}
        {failing === 0 ? "all pass" : `${String(failing)} below minimum`}
      </h3>
      <table className="sb-contrast__table">
        <thead>
          <tr>
            <th scope="col">Sample</th>
            <th scope="col">Token</th>
            <th scope="col">On</th>
            <th scope="col">Ratio</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={`${c.fg}-${c.bg}-${c.role}`} title={c.why}>
              <td>
                <Sample check={c} />
              </td>
              <td>
                <code>--{c.fg}</code>
                <div
                  className="sb-contrast__why"
                  style={{ color: ink("text-muted") }}
                >
                  {c.role} · {c.why}
                </div>
              </td>
              <td>
                <code>--{c.bg}</code>
              </td>
              <td className="sb-contrast__ratio">
                {c.ratio.toFixed(2)}
                <span
                  style={{
                    color: ink(passes(c) ? "status-success" : "status-error"),
                  }}
                >
                  {passes(c) ? ` ✓ ≥${String(c.min)}` : ` ✗ <${String(c.min)}`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

export const AllPairings: StoryObj = {
  render: () => {
    const checks = matrix()
    const missing = unclassified()
    return (
      <div className="sb-contrast">
        <p className="sb-contrast__note">
          Not measured, decorative:{" "}
          {DECORATIVE.map((token) => `--${token}`).join(", ")}.
          {missing.length > 0 &&
            ` Neither measured nor decorative (the audit fails): ${missing
              .map((token) => `--${token}`)
              .join(", ")}.`}
        </p>
        {THEME_NAMES.map((theme) => (
          <ThemePanel
            key={theme}
            theme={theme}
            checks={checks.filter((c) => c.theme === theme)}
          />
        ))}
      </div>
    )
  },
}
