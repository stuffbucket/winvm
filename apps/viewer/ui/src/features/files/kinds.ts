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

const GLYPH: Record<Kind, string> = {
  folder: "\u{F4D3}",
  text: "\u{E64E}",
  log: "\u{F4ED}",
  image: "\u{F4E5}",
  archive: "\u{F410}",
  audio: "\u{E638}",
  video: "\u{E69F}",
  code: "\u{F40D}",
  script: "\u{E691}",
  app: "\u{F471}",
  installer: "\u{F487}",
  library: "\u{E690}",
  config: "\u{E615}",
  font: "\u{E659}",
  pdf: "\u{E67D}",
  word: "\u{E6A5}",
  sheet: "\u{E6A6}",
  slides: "\u{F4A5}",
  shortcut: "\u{F481}",
  disk: "\u{F472}",
  database: "\u{E64D}",
  other: "\u{F4A5}",
}

const POWERSHELL = "\u{E683}"

export const CHEVRON = { up: "\u{F47B}", down: "\u{F47C}" } as const

const BY_EXT: Readonly<Record<string, Kind>> = Object.fromEntries(
  (
    [
      ["text", "txt md markdown rtf nfo"],
      ["log", "log etl"],
      ["image", "png jpg jpeg gif bmp webp tif tiff ico heic svg"],
      ["archive", "zip 7z rar tar gz tgz bz2 xz zst cab"],
      ["audio", "mp3 wav flac m4a aac ogg wma"],
      ["video", "mp4 mov mkv avi wmv webm m4v"],
      [
        "code",
        "js mjs cjs ts tsx jsx py rs c h cpp hpp cs go java json xml yaml yml toml html htm css",
      ],
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

function extension(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 && dot < name.length - 1
    ? name.slice(dot + 1).toLowerCase()
    : ""
}

export function kindOf(name: string, dir: boolean): Kind {
  if (dir) return "folder"
  return BY_EXT[extension(name)] ?? "other"
}

export function glyphOf(name: string, dir: boolean): string {
  if (!dir && /^ps[dm]?1$/.test(extension(name))) return POWERSHELL
  return GLYPH[kindOf(name, dir)]
}

export function kindLabel(
  name: string,
  dir: boolean,
  label: (key: string, values?: Record<string, string>) => string,
): string {
  const kind = kindOf(name, dir)
  const ext = extension(name).toUpperCase()
  if (kind === "other")
    return ext === ""
      ? label("files.kind.plain")
      : label("files.kind.other", { ext })
  return label(`files.kind.${kind}`, { ext })
}
