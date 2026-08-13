import { afterEach, describe, expect, test } from "vitest"
import { homeDir, isDev, kobeStateDir, kvStatePath, roveStateDir } from "../src/env.ts"

const ORIGINAL = {
  ROVE_DEV: process.env.ROVE_DEV,
  KOBE_DEV: process.env.KOBE_DEV,
  ROVE_HOME_DIR: process.env.ROVE_HOME_DIR,
  KOBE_HOME_DIR: process.env.KOBE_HOME_DIR,
}

function restore(key: keyof typeof ORIGINAL): void {
  const value = ORIGINAL[key]
  if (value === undefined) Reflect.deleteProperty(process.env, key)
  else process.env[key] = value
}

afterEach(() => {
  for (const key of Object.keys(ORIGINAL) as (keyof typeof ORIGINAL)[]) restore(key)
})

describe("rename-compatible environment access", () => {
  test("ROVE_HOME_DIR wins while the phase-one state layout stays .kobe", () => {
    process.env.KOBE_HOME_DIR = "/legacy-home"
    process.env.ROVE_HOME_DIR = "/rove-home"

    expect(homeDir()).toBe("/rove-home")
    expect(roveStateDir()).toBe("/rove-home/.kobe")
    expect(kobeStateDir()).toBe(roveStateDir())
    expect(kvStatePath()).toBe("/rove-home/.config/kobe/state.json")
  })

  test("KOBE_HOME_DIR remains a supported fallback", () => {
    Reflect.deleteProperty(process.env, "ROVE_HOME_DIR")
    process.env.KOBE_HOME_DIR = "/legacy-home"
    expect(homeDir()).toBe("/legacy-home")
  })

  test("ROVE_DEV takes precedence over KOBE_DEV", () => {
    process.env.KOBE_DEV = "1"
    process.env.ROVE_DEV = "0"
    expect(isDev()).toBe(false)
    process.env.ROVE_DEV = "1"
    expect(isDev()).toBe(true)
  })
})
