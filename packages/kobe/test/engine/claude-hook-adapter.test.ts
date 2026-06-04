import { describe, expect, it } from "vitest"
import {
  KOBE_HOOK_EVENTS,
  buildClaudeHooks,
  mergeClaudeHooks,
  mergeWorktreeSyncHook,
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

interface SettingsShape {
  hooks?: { WorktreeCreate?: unknown[]; PostToolUse?: unknown }
  model?: string
}

describe("mergeWorktreeSyncHook (Feature 2 — external worktree sync)", () => {
  it("adds a WorktreeCreate hook, preserving the user's other hooks", () => {
    const userSettings = {
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] }] },
      model: "opus",
    }
    const out = mergeWorktreeSyncHook(userSettings, "kobe hook worktree-created") as SettingsShape
    expect(out.model).toBe("opus") // untouched
    expect(out.hooks?.PostToolUse).toEqual(userSettings.hooks.PostToolUse) // untouched
    expect(JSON.stringify(out.hooks?.WorktreeCreate)).toContain("worktree-created")
  })

  it("is idempotent — re-install replaces kobe's own entry, no duplicates", () => {
    const once = mergeWorktreeSyncHook({}, "kobe hook worktree-created")
    const twice = mergeWorktreeSyncHook(once, "kobe hook worktree-created")
    expect((twice as SettingsShape).hooks?.WorktreeCreate).toHaveLength(1)
  })

  it("removes kobe's hook (command=null) while keeping the user's WorktreeCreate hooks", () => {
    const withUser = {
      hooks: { WorktreeCreate: [{ hooks: [{ type: "command", command: "user-wt-hook" }] }] },
    }
    const added = mergeWorktreeSyncHook(withUser, "kobe hook worktree-created")
    expect((added as SettingsShape).hooks?.WorktreeCreate).toHaveLength(2)
    const removed = mergeWorktreeSyncHook(added, null) as SettingsShape
    expect(removed.hooks?.WorktreeCreate).toHaveLength(1)
    expect(JSON.stringify(removed.hooks?.WorktreeCreate)).toContain("user-wt-hook")
  })

  it("drops the empty hooks key entirely when the last hook is removed", () => {
    const added = mergeWorktreeSyncHook({}, "kobe hook worktree-created")
    const removed = mergeWorktreeSyncHook(added, null) as SettingsShape
    expect(removed.hooks).toBeUndefined()
  })
})
