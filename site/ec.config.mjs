// Expressive Code reads this file for the code blocks in Markdown, so plugins and theme settings belong here
// rather than in Starlight's `expressiveCode` option.
import { createRenderer, defineEcConfig } from "@astrojs/starlight/expressive-code";

import codeFocus, { withoutTabindexScript } from "./scripts/code-focus.mjs";

// Output, plain text and JSON wrap at the edge of the box instead of scrolling sideways. Wrapping only changes
// how a line is drawn: copying still gives the original lines. Shell commands and program code do not wrap,
// because there a line that continues below looks like a second command.
const WRAPPED = "text,txt,plaintext,plain,output,json,jsonc,log";

export default defineEcConfig({
  // Frames, borders and backgrounds take the site's colors (theme.css), which come from the app's tokens.
  useStarlightUiThemeColors: true,
  styleOverrides: {
    borderRadius: "var(--radius-card)",
    codeFontFamily: "var(--font-mono)",
    uiFontFamily: "var(--font-body)",
  },
  defaultProps: {
    overridesByLang: { [WRAPPED]: { wrap: true, preserveIndent: true } },
  },
  // Lines that still run long scroll sideways; this lets a keyboard reach and scroll them.
  plugins: [codeFocus()],
  customCreateRenderer: withoutTabindexScript(createRenderer),
});
