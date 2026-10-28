import { describe, expect, it } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"

import { configDir, dataDir } from "../src/xdg"

describe("XDG base directories", () => {
  it("uses the variables when they are absolute paths", () => {
    const env = { HOME: "/h", XDG_CONFIG_HOME: "/cfg", XDG_DATA_HOME: "/data" }
    expect(configDir(env)).toBe("/cfg/winvm")
    expect(dataDir(env)).toBe("/data/winvm")
  })

  it("falls back to the defaults under HOME when unset, empty or relative", () => {
    for (const v of [undefined, "", "relative/dir", "./x"]) {
      const env = { HOME: "/h", ...(v === undefined ? {} : { XDG_CONFIG_HOME: v, XDG_DATA_HOME: v }) }
      expect(configDir(env)).toBe("/h/.config/winvm")
      expect(dataDir(env)).toBe("/h/.local/share/winvm")
    }
  })

  it("takes the home directory from the OS when HOME is missing", () => {
    expect(dataDir({})).toBe(resolve(homedir(), ".local/share/winvm"))
    expect(configDir({ HOME: "" })).toBe(resolve(homedir(), ".config/winvm"))
  })
})
