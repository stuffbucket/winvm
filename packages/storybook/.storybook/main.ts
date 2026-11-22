import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { StorybookConfig } from "@storybook/react-vite"
import react from "@vitejs/plugin-react"
import { mergeConfig } from "vite"

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const REPO = resolve(PKG, "../..")

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.mdx", "../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  staticDirs: [{ from: "../.ui", to: "/ui" }],
  core: { disableTelemetry: true },
  viteFinal: (base) =>
    Promise.resolve(
      mergeConfig(base, {
        plugins: [react()],
        resolve: { dedupe: ["react", "react-dom"] },
        server: { fs: { allow: [REPO] } },
      }),
    ),
}

export default config
