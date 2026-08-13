import { installRoveEnvCompatibility, legacyKobeEnvKey, readRoveEnv } from "@sma1lboy/kobe-daemon/compat-env"
import { describe, expect, test } from "vitest"
import { kobeCliInvocation, roveCliInvocation } from "../../src/cli/invocation.ts"
import {
  activeCliName,
  markKobeInvocation,
  markRoveInvocation,
  prepareCliEnvironment,
} from "../../src/cli/rename-compat.ts"

describe("rove environment compatibility", () => {
  test("ROVE_* overrides the matching legacy KOBE_* value", () => {
    const env: NodeJS.ProcessEnv = {
      ROVE_HOME_DIR: "/new-home",
      KOBE_HOME_DIR: "/old-home",
      ROVE_DEBUG: "1",
    }

    installRoveEnvCompatibility(env)

    expect(env.KOBE_HOME_DIR).toBe("/new-home")
    expect(env.KOBE_DEBUG).toBe("1")
    expect(env.ROVE_HOME_DIR).toBe("/new-home")
  })

  test("an existing KOBE_* value survives when no ROVE_* value exists", () => {
    const env: NodeJS.ProcessEnv = { KOBE_HOME_DIR: "/legacy-home" }
    installRoveEnvCompatibility(env)
    expect(env.KOBE_HOME_DIR).toBe("/legacy-home")
    expect(readRoveEnv("HOME_DIR", env)).toBe("/legacy-home")
  })

  test("the internal invoked-as marker is not exposed as a KOBE_* control", () => {
    const env: NodeJS.ProcessEnv = {}
    markRoveInvocation(env)
    prepareCliEnvironment(env)

    expect(activeCliName(env)).toBe("rove")
    expect(env.KOBE_INVOKED_AS).toBeUndefined()
  })

  test("the shared kobe entry stays the legacy alias by default", () => {
    expect(activeCliName({})).toBe("kobe")
    expect(legacyKobeEnvKey("ROVE_TASK_ID")).toBe("KOBE_TASK_ID")
    expect(legacyKobeEnvKey("OTHER_TASK_ID")).toBeUndefined()
  })

  test("the kobe wrapper overrides a stale inherited invocation marker", () => {
    const env: NodeJS.ProcessEnv = { ROVE_INVOKED_AS: "rove" }
    markKobeInvocation(env)
    expect(activeCliName(env)).toBe("kobe")
  })

  test("source-mode child invocations follow the active public wrapper", () => {
    const original = process.env.ROVE_INVOKED_AS
    try {
      markRoveInvocation()
      expect(roveCliInvocation()).toEqual([
        process.execPath,
        "--conditions=browser",
        expect.stringMatching(/\/cli\/rove\.ts$/),
      ])

      markKobeInvocation()
      expect(kobeCliInvocation()).toEqual([
        process.execPath,
        "--conditions=browser",
        expect.stringMatching(/\/cli\/kobe\.ts$/),
      ])
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.env, "ROVE_INVOKED_AS")
      else process.env.ROVE_INVOKED_AS = original
    }
  })
})
