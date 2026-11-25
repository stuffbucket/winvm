export interface Size {
  readonly width: number
  readonly height: number
}

interface TauriConfig {
  readonly app: {
    readonly windows: readonly {
      readonly label: string
      readonly width: number
      readonly height: number
    }[]
  }
}

export function mainSize(config: TauriConfig): Size {
  const main = config.app.windows.find((w) => w.label === "main")
  if (main === undefined) throw new Error("tauri.conf.json has no main window")
  return { width: main.width, height: main.height }
}

export function specSize(source: string, name: string): Size {
  const spec = new RegExp(
    String.raw`pub const ${name}: Spec = Spec \{\s*width: ([\d.]+),\s*height: ([\d.]+),`,
  ).exec(source)
  if (spec?.[1] === undefined || spec[2] === undefined)
    throw new Error(`windows.rs has no ${name} Spec`)
  return { width: Number(spec[1]), height: Number(spec[2]) }
}
