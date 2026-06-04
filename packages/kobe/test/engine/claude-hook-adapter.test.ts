import { describe, expect, it } from "vitest"
import {
  KOBE_HOOK_EVENTS,
  buildClaudeHooks,
  mergeClaudeHooks,
} from "../../src/engine/claude-code-local/hook-adapter.ts"

/**
 * The ONLY place Claude Code hook event names live. These lock the
 * vendor→neutral mapping shape + the non-clobbering merge.
 */
describe("buildClaudeHooks", () => {
  // Inject a fixed invocation so the test doesn't depend on the dev/prod CLI resolver.
  const hooks = buildClaudeHooks("01TASKID", ["kobe"]) as Record<
    string,
    Array<{ matcher?: string; hooks: { command: string }[] }>
  >

  it("installs a hook for each Claude event kobe owns", () => {
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "Notification", "SessionEnd"]) {
      expect(hooks[event]).toBeDefined()
    }
  })

  it("points each hook at `kobe hook <verb> --task-id <id>` (shell-quoted argv)", () => {
    expect(hooks.Stop[0].hooks[0].command).toContain("'hook' 'turn-complete' '--task-id' '01TASKID'")
    expect(hooks.StopFailure[0].hooks[0].command).toContain("'hook' 'turn-failed' '--task-id' '01TASKID'")
    expect(hooks.SessionStart[0].hooks[0].command).toContain("'hook' 'session-start' '--task-id' '01TASKID'")
  })

  it("scopes the Notification hook to permission prompts only", () => {
    expect(hooks.Notification[0].matcher).toBe("permission_prompt")
    expect(hooks.Notification[0].hooks[0].command).toContain("'hook' 'awaiting-input'")
  })
})

describe("mergeClaudeHooks", () => {
  it("replaces only kobe-owned events and preserves the user's other hooks", () => {
    const userHooks = {
      Stop: [{ hooks: [{ type: "command", command: "user-old-stop" }] }],
      PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "user-formatter" }] }],
    }
    const merged = mergeClaudeHooks(userHooks, buildClaudeHooks("01TASKID", ["kobe"])) as Record<string, unknown>
    // kobe owns Stop now…
    expect(JSON.stringify(merged.Stop)).toContain("turn-complete")
    // …but the user's unrelated PostToolUse hook is untouched.
    expect(merged.PostToolUse).toEqual(userHooks.PostToolUse)
  })

  it("KOBE_HOOK_EVENTS lists exactly the events it installs", () => {
    expect([...KOBE_HOOK_EVENTS].sort()).toEqual(
      ["Notification", "SessionEnd", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"].sort(),
    )
  })
})
