/**
 * What kind of thing a guest file is, from its extension: the glyph the list
 * draws for it and the words the Kind column uses. The glyphs are Octicons and
 * Seti-UI icons (both MIT) from Symbols Nerd Font Mono, vendored as a subset
 * holding exactly the code points below (styles/fonts/, THIRD-PARTY-LICENSE.md).
 * A new glyph here means a new subset.
 */

export type Kind =
  | "folder"
  | "text"
  | "log"
  | "image"
  | "archive"
  | "audio"
  | "video"
  | "code"
  | "script"
  | "app"
  | "installer"
  | "library"
  | "config"
  | "font"
  | "pdf"
  | "word"
  | "sheet"
  | "slides"
  | "shortcut"
  | "disk"
  | "database"
  | "other"

/** Each kind's glyph: nf-oct-* and nf-seti-* code points in the vendored subset. */
export const GLYPH: Record<Kind, string> = {
  folder: "\u{F4D3}", // nf-oct-file_directory_fill
  text: "\u{E64E}", // nf-seti-text
  log: "\u{F4ED}", // nf-oct-log
  image: "\u{F4E5}", // nf-oct-image
  archive: "\u{F410}", // nf-oct-file_zip
  audio: "\u{E638}", // nf-seti-audio
  video: "\u{E69F}", // nf-seti-video
  code: "\u{F40D}", // nf-oct-file_code
  script: "\u{E691}", // nf-seti-shell
  app: "\u{F471}", // nf-oct-file_binary
  installer: "\u{F487}", // nf-oct-package
  library: "\u{E690}", // nf-seti-settings
  config: "\u{E615}", // nf-seti-config
  font: "\u{E659}", // nf-seti-font
  pdf: "\u{E67D}", // nf-seti-pdf
  word: "\u{E6A5}", // nf-seti-word
  sheet: "\u{E6A6}", // nf-seti-xls
  slides: "\u{F4A5}", // nf-oct-file
  shortcut: "\u{F481}", // nf-oct-file_symlink_file
  disk: "\u{F472}", // nf-oct-database
  database: "\u{E64D}", // nf-seti-db
  other: "\u{F4A5}", // nf-oct-file
}

/** PowerShell's own mark, for its scripts. */
const POWERSHELL = "\u{E683}" // nf-seti-powershell

/** The sort indicator beside the sorted column's heading. */
export const CHEVRON = { up: "\u{F47B}", down: "\u{F47C}" } as const // nf-oct-chevron_up, nf-oct-chevron_down

const BY_EXT: Readonly<Record<string, Kind>> = Object.fromEntries(
  (
    [
      ["text", "txt md markdown rtf nfo"],
      ["log", "log etl"],
      ["image", "png jpg jpeg gif bmp webp tif tiff ico heic svg"],
      ["archive", "zip 7z rar tar gz tgz bz2 xz zst cab"],
      ["audio", "mp3 wav flac m4a aac ogg wma"],
      ["video", "mp4 mov mkv avi wmv webm m4v"],
      ["code", "js mjs cjs ts tsx jsx py rs c h cpp hpp cs go java json xml yaml yml toml html htm css"],
      ["script", "ps1 psm1 psd1 bat cmd sh vbs reg ahk"],
      ["app", "exe com scr"],
      ["installer", "msi msix msixbundle appx appxbundle"],
      ["library", "dll sys drv ocx"],
      ["config", "ini cfg conf inf"],
      ["font", "ttf otf woff woff2 fon"],
      ["pdf", "pdf"],
      ["word", "doc docx odt"],
      ["sheet", "xls xlsx ods csv tsv"],
      ["slides", "ppt pptx odp"],
      ["shortcut", "lnk url"],
      ["disk", "iso vhd vhdx qcow2 img dmg wim"],
      ["database", "db sqlite sqlite3 mdb accdb"],
    ] as const
  ).flatMap(([kind, exts]) => exts.split(" ").map((e) => [e, kind] as const)),
)

/** A name's extension, lower case and without the dot; "" for none (a leading dot alone is not one). */
export function extension(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ""
}

export function kindOf(name: string, dir: boolean): Kind {
  if (dir) return "folder"
  return BY_EXT[extension(name)] ?? "other"
}

/** The glyph a row draws: its kind's, or PowerShell's own for a PowerShell script. */
export function glyphOf(name: string, dir: boolean): string {
  if (!dir && /^ps[dm]?1$/.test(extension(name))) return POWERSHELL
  return GLYPH[kindOf(name, dir)]
}

/**
 * The Kind column's words for an entry, through the catalog: `files.kind.<kind>`
 * with the extension in capitals as `{ext}` ("PNG image", "LOG file").
 */
export function kindLabel(name: string, dir: boolean, label: (key: string, values?: Record<string, string>) => string): string {
  const kind = kindOf(name, dir)
  const ext = extension(name).toUpperCase()
  if (kind === "other") return ext === "" ? label("files.kind.plain") : label("files.kind.other", { ext })
  return label(`files.kind.${kind}`, { ext })
}
