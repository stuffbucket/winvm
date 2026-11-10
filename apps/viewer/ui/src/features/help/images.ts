/**
 * The pictures in the help popovers: one light and one dark JPEG each, which
 * the popover picks between by the OS's appearance. They are screenshots of
 * the real windows against fixtures, made by `scripts/render-help.mjs`: run it
 * again after the Terminal, Files or Checkpoints change, and commit the result.
 * Each name is `<topic>-<figure>`, as `pictureKey` makes it.
 */
import agentClaudeDark from "./img/agent-claude.dark.jpg"
import agentClaudeLight from "./img/agent-claude.light.jpg"
import execTerminalDark from "./img/exec-terminal.dark.jpg"
import execTerminalLight from "./img/exec-terminal.light.jpg"
import filesFilesDark from "./img/files-files.dark.jpg"
import filesFilesLight from "./img/files-files.light.jpg"
import restoreBrowseDark from "./img/restore-browse.dark.jpg"
import restoreBrowseLight from "./img/restore-browse.light.jpg"
import restoreGoBackDark from "./img/restore-goBack.dark.jpg"
import restoreGoBackLight from "./img/restore-goBack.light.jpg"
import saveNewDark from "./img/save-new.dark.jpg"
import saveNewLight from "./img/save-new.light.jpg"

export interface HelpImage {
  readonly light: string
  readonly dark: string
  /** In pixels, so the page keeps the picture's room before it loads. */
  readonly width: number
  readonly height: number
}

const WIDTH = 1200
const HEIGHT = 675

const picture = (light: string, dark: string): HelpImage => ({ light, dark, width: WIDTH, height: HEIGHT })

export const IMAGES: Readonly<Record<string, HelpImage>> = {
  "exec-terminal": picture(execTerminalLight, execTerminalDark),
  "files-files": picture(filesFilesLight, filesFilesDark),
  "save-new": picture(saveNewLight, saveNewDark),
  "restore-browse": picture(restoreBrowseLight, restoreBrowseDark),
  "restore-goBack": picture(restoreGoBackLight, restoreGoBackDark),
  "agent-claude": picture(agentClaudeLight, agentClaudeDark),
}
