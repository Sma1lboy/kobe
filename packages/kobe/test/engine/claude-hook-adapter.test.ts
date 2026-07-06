import { describe, expect, it } from "vitest"
import {
  KOBE_HOOK_EVENTS,
  buildClaudeHooks,
  buildWorktreeWatchHook,
  mergeActivityHooks,
  mergeWorktreeSyncHook,
  mergeWorktreeWatchHook,
} from "../../src/engine/claude-code-local/hook-adapter.ts"

describe("buildClaudeHooks", () => {
  const hooks = buildClaudeHooks(["kobe"]) as Record<string, Array<{ matcher?: string; hooks: { command: string }[] }>>

  it("installs a hook for each Claude event kobe owns", () => {
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "Notification", "SessionEnd"]) {
      expect(hooks[event]).toBeDefined()
    }
  })

  it("points each hook at `kobe hook <verb>` with NO task id (shell-quoted argv)", () => {
    expect(hooks.Stop[0].hooks[0].command).toContain("'hook' 'turn-complete'")
    expect(hooks.Stop[0].hooks[0].command).not.toContain("--task-id")
    expect(hooks.StopFailure[0].hooks[0].command).toContain("'hook' 'turn-failed'")
    expect(hooks.SessionStart[0].hooks[0].command).toContain("'hook' 'session-start'")
  })

  it("scopes the Notification hook to permission prompts only", () => {
    expect(hooks.Notification[0].matcher).toBe("permission_prompt")
    expect(hooks.Notification[0].hooks[0].command).toContain("'hook' 'awaiting-input'")
  })
})

interface SettingsShape extends Record<string, unknown> {
  hooks?: { Stop?: unknown[]; PostToolUse?: unknown; WorktreeCreate?: unknown[] }
  model?: string
}

describe("mergeActivityHooks (global, cwd-based)", () => {
  it("adds kobe's events, preserving the user's other hooks + keys", () => {
    const userSettings = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "user-old-stop" }] }],
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "user-formatter" }] }],
      },
      model: "opus",
    }
    const out = mergeActivityHooks(userSettings, true, ["kobe"]) as SettingsShape
    expect(out.model).toBe("opus")
    expect(out.hooks?.PostToolUse).toEqual(userSettings.hooks.PostToolUse)
    expect(JSON.stringify(out.hooks?.Stop)).toContain("turn-complete")
    expect(JSON.stringify(out.hooks?.Stop)).toContain("user-old-stop")
    expect(out.hooks?.Stop).toHaveLength(2)
  })

  it("is idempotent — re-install replaces only kobe's own entry, no duplicates", () => {
    const once = mergeActivityHooks({}, true, ["kobe"])
    const twice = mergeActivityHooks(once, true, ["kobe"]) as SettingsShape
    expect(twice.hooks?.Stop).toHaveLength(1)
  })

  it("removes kobe's hooks while keeping the user's same-event hooks", () => {
    const userSettings = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "user-old-stop" }] }] },
    }
    const added = mergeActivityHooks(userSettings, true, ["kobe"]) as SettingsShape
    expect(added.hooks?.Stop).toHaveLength(2)
    const removed = mergeActivityHooks(added, false, ["kobe"]) as SettingsShape
    expect(removed.hooks?.Stop).toHaveLength(1)
    expect(JSON.stringify(removed.hooks?.Stop)).toContain("user-old-stop")
  })

  it("drops the empty hooks key entirely when only kobe's hooks existed", () => {
    const added = mergeActivityHooks({}, true, ["kobe"])
    const removed = mergeActivityHooks(added, false, ["kobe"]) as SettingsShape
    expect(removed.hooks).toBeUndefined()
  })

  it("KOBE_HOOK_EVENTS lists exactly the events it installs", () => {
    expect([...KOBE_HOOK_EVENTS].sort()).toEqual(
      ["Notification", "SessionEnd", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"].sort(),
    )
  })
})

describe("mergeWorktreeSyncHook (external worktree sync)", () => {
  it("adds a WorktreeCreate hook, preserving the user's other hooks", () => {
    const userSettings = {
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] }] },
      model: "opus",
    }
    const out = mergeWorktreeSyncHook(userSettings, "kobe hook worktree-created") as SettingsShape
    expect(out.model).toBe("opus")
    expect(out.hooks?.PostToolUse).toEqual(userSettings.hooks.PostToolUse)
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

  it("activity + worktree-sync hooks coexist in one settings file", () => {
    const withActivity = mergeActivityHooks({}, true, ["kobe"])
    const both = mergeWorktreeSyncHook(withActivity, "kobe hook worktree-created") as SettingsShape
    expect(both.hooks?.Stop).toHaveLength(1)
    expect(both.hooks?.WorktreeCreate).toHaveLength(1)
    const noSync = mergeWorktreeSyncHook(both, null) as SettingsShape
    expect(noSync.hooks?.Stop).toHaveLength(1)
    expect(noSync.hooks?.WorktreeCreate).toBeUndefined()
  })
})

describe("buildWorktreeWatchHook (creation-time auto-adopt)", () => {
  const hooks = buildWorktreeWatchHook(["kobe"]) as {
    PostToolUse: Array<{ matcher?: string; hooks: { command: string }[] }>
  }

  it("installs a PostToolUse hook scoped to the Bash tool", () => {
    expect(hooks.PostToolUse).toHaveLength(1)
    expect(hooks.PostToolUse[0].matcher).toBe("Bash")
  })

  it("points the hook at `kobe hook worktree-created` (shell-quoted argv)", () => {
    expect(hooks.PostToolUse[0].hooks[0].command).toContain("'hook' 'worktree-created'")
  })
})

describe("mergeWorktreeWatchHook (PostToolUse observer)", () => {
  it("adds kobe's Bash hook, preserving the user's other PostToolUse hooks + keys", () => {
    const userSettings = {
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "user-fmt" }] }] },
      model: "opus",
    }
    const out = mergeWorktreeWatchHook(userSettings, true, ["kobe"]) as SettingsShape
    expect(out.model).toBe("opus")
    const post = out.hooks?.PostToolUse as Array<{ matcher?: string; hooks: { command: string }[] }>
    expect(post).toHaveLength(2)
    expect(JSON.stringify(post)).toContain("user-fmt")
    expect(JSON.stringify(post)).toContain("worktree-created")
  })

  it("is idempotent — re-install replaces only kobe's entry, no duplicates", () => {
    const once = mergeWorktreeWatchHook({}, true, ["kobe"])
    const twice = mergeWorktreeWatchHook(once, true, ["kobe"]) as SettingsShape
    expect(twice.hooks?.PostToolUse).toHaveLength(1)
  })

  it("removes kobe's hook while keeping the user's PostToolUse hooks", () => {
    const userSettings = {
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "user-fmt" }] }] },
    }
    const added = mergeWorktreeWatchHook(userSettings, true, ["kobe"]) as SettingsShape
    expect(added.hooks?.PostToolUse).toHaveLength(2)
    const removed = mergeWorktreeWatchHook(added, false, ["kobe"]) as SettingsShape
    expect(removed.hooks?.PostToolUse).toHaveLength(1)
    expect(JSON.stringify(removed.hooks?.PostToolUse)).toContain("user-fmt")
  })

  it("drops the empty PostToolUse key when only kobe's hook existed", () => {
    const added = mergeWorktreeWatchHook({}, true, ["kobe"])
    const removed = mergeWorktreeWatchHook(added, false, ["kobe"]) as SettingsShape
    expect(removed.hooks).toBeUndefined()
  })

  it("coexists with activity hooks in one settings file", () => {
    const withActivity = mergeActivityHooks({}, true, ["kobe"])
    const both = mergeWorktreeWatchHook(withActivity, true, ["kobe"]) as SettingsShape
    expect(both.hooks?.Stop).toHaveLength(1)
    expect(both.hooks?.PostToolUse).toHaveLength(1)
  })
})
