// @ts-check
import { fileURLToPath } from "node:url";

import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

import { docOrder, MAINTAINER_DOCS } from "./scripts/generate.mjs";
import tableFocus from "./scripts/table-focus.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// The app's own design tokens (generated from apps/viewer/ui/src/styles/theme.ts) and fonts, so the site and
// the Mac app share one palette and one type. theme.css maps them onto Starlight's variables.
const appStyles = "../apps/viewer/ui/src/styles";

export default defineConfig({
  site: "https://stuffbucket.github.io",
  base: "/winvm/",
  integrations: [
    // Wide tables scroll sideways; this lets a keyboard reach and scroll them.
    tableFocus(),
    starlight({
      title: "winvm",
      description: "Windows 11 ARM64 virtual machines on an Apple Silicon Mac, from a Mac app or the winvm command.",
      favicon: "/favicon.png",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/stuffbucket/winvm" }],
      customCss: [
        `${appStyles}/tokens.css`,
        `${appStyles}/fonts.css`,
        "./src/styles/theme.css",
        "./src/styles/tables.css",
        "./src/styles/header.css",
      ],
      // README.md is the home page; the docs follow in the order README.md links them (see scripts/generate.mjs).
      sidebar: [
        { label: "Overview", link: "/" },
        ...docOrder(root),
        { label: "Maintainers", collapsed: true, items: MAINTAINER_DOCS },
      ],
    }),
  ],
});
