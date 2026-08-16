import { describe, expect, test } from "vitest"
import { activeCliName } from "../../src/cli/rename-compat.ts"
import { clearInheritedCliInvocation } from "../setup.ts"

// Regression: a Rove-launched test process made legacy CLI suites render Rove copy
describe("CLI test environment", () => {
  test("does not inherit the invoking wrapper identity", () => {
    const env: NodeJS.ProcessEnv = { ROVE_INVOKED_AS: "rove" }

    clearInheritedCliInvocation(env)

    expect(env.ROVE_INVOKED_AS).toBeUndefined()
    expect(activeCliName(env)).toBe("kobe")
  })
})
