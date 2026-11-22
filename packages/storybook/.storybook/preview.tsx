import "../../../apps/viewer/tests/render/fake-tauri.js"
import "../../../apps/viewer/ui/src/styles/styles.css"
import "../src/storybook.css"

import type { Preview } from "@storybook/react-vite"

import { applyTheme, THEMES } from "../src/theme"

document.documentElement.dataset.os = "macos"

const preview: Preview = {
  globalTypes: {
    theme: {
      description:
        "Color theme: System follows the OS like the app; Dark and Light pin data-theme",
      toolbar: {
        title: "Theme",
        icon: "contrast",
        items: THEMES.map((value) => ({
          value,
          title: value.charAt(0).toUpperCase() + value.slice(1),
        })),
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "system" },
  decorators: [
    (Story, { globals }) => {
      applyTheme(document, globals.theme)
      return <Story />
    },
  ],
  beforeEach({ globals }) {
    applyTheme(document, globals.theme)
  },
  parameters: {
    layout: "padded",
    backgrounds: { disabled: true },
    controls: { expanded: true },
    a11y: { test: "todo" },
    options: {
      storySort: {
        order: [
          "Overview",
          "Foundations",
          ["Tokens", "Type", "Spacing", "Contrast"],
          "Components",
          "Viewer",
          "Canvas",
          "Windows",
        ],
      },
    },
  },
}

export default preview
