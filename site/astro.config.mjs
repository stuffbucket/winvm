// @ts-check
import { fileURLToPath } from "node:url";

import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

import { docOrder, MAINTAINER_DOCS } from "./scripts/generate.mjs";
import tableFocus from "./scripts/table-focus.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const appStyles = "../apps/viewer/ui/src/styles";

export default defineConfig({
  site: "https://stuffbucket.github.io",
  base: "/winvm/",
  integrations: [
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
      sidebar: [
        { label: "Overview", link: "/" },
        ...docOrder(root),
        { label: "Maintainers", collapsed: true, items: MAINTAINER_DOCS },
      ],
    }),
  ],
});
