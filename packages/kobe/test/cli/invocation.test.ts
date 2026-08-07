import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { kobeHookInvocation, kobeHookReporterEnv } from "../../src/cli/invocation.ts"

describe("source hook invocation", () => {
  it("persists a stable dispatcher and exports the current source reporter", () => {
    const invocation = kobeHookInvocation()
    const reporterEnv = kobeHookReporterEnv()

    expect(invocation.slice(0, 2)).toEqual(["sh", "-c"])
    expect(invocation[2]).toContain('exec "$KOBE_DEV_BUN" --conditions=browser "$KOBE_DEV_CLI_ENTRY" "$@"')
    expect(invocation[2]).toContain('exec kobe "$@"')
    expect(reporterEnv.KOBE_DEV_BUN).toBe(process.execPath)
    expect(reporterEnv.KOBE_DEV_CLI_ENTRY?.endsWith("/src/cli/index.ts")).toBe(true)
    expect(existsSync(reporterEnv.KOBE_DEV_CLI_ENTRY as string)).toBe(true)
  })

  it("dispatches hook arguments through the exported source reporter", () => {
    const invocation = kobeHookInvocation()
    const reporterEnv = kobeHookReporterEnv()
    const result = spawnSync(invocation[0] as string, [...invocation.slice(1), "hook", "session-start"], {
      env: {
        ...process.env,
        ...reporterEnv,
        KOBE_DEV_BUN: "/bin/echo",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout.toString().trim()).toBe(
      `--conditions=browser ${reporterEnv.KOBE_DEV_CLI_ENTRY} hook session-start`,
    )
  })
})
