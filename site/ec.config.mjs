import { createRenderer, defineEcConfig } from "@astrojs/starlight/expressive-code";

import codeFocus, { withoutTabindexScript } from "./scripts/code-focus.mjs";

const WRAPPED = "text,txt,plaintext,plain,output,json,jsonc,log";

export default defineEcConfig({
  useStarlightUiThemeColors: true,
  styleOverrides: {
    borderRadius: "var(--radius-card)",
    codeFontFamily: "var(--font-mono)",
    uiFontFamily: "var(--font-body)",
  },
  defaultProps: {
    overridesByLang: { [WRAPPED]: { wrap: true, preserveIndent: true } },
  },
  plugins: [codeFocus()],
  customCreateRenderer: withoutTabindexScript(createRenderer),
});
