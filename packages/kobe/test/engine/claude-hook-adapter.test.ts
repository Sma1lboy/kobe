import { describe, expect, it } from "vitest"
import {
  ClaudeHookAdapter,
  KOBE_HOOK_EVENTS,
  buildClaudeHooks,
  buildWorktreeWatchHook,
  mergeActivityHooks,
  mergeWorktreeSyncHook,
  mergeWorktreeWatchHook,
} from "../../src/engine/claude-code-local/hook-adapter.ts"

/**
 * The ONLY place Claude Code hook event names live. These lock the
 * vendor→neutral mapping shape + the non-clobbering merge. Activity hooks are
 * now GLOBAL + cwd-based (no `--task-id`): one block in ~/.claude makes every
 * Claude session report, and the daemon maps each hook's cwd to a task.
 */
describe("buildClaudeHooks", () => {
  // Inject a fixed invocation so the test doesn't depend on the dev/prod CLI resolver.
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

  it("scopes the Notification hook to permission prompts + question dialogs", () => {
    // Two matcher-scoped groups on ONE event — permission prompts and
    // elicitation (question) dialogs both report awaiting-input; NOT
    // idle_prompt, which fires for any resting prompt and would escalate
    // every idle session (turn_complete already covers "done, look at me").
    expect(hooks.Notification.map((g) => g.matcher)).toEqual(["permission_prompt", "elicitation_dialog"])
    for (const group of hooks.Notification) {
      expect(group.hooks[0].command).toContain("'hook' 'awaiting-input'")
    }
  })
})

describe("activityDetailFromPayload", () => {
  const adapter = new ClaudeHookAdapter()

  it("classifies awaiting-input by the Notification payload's notification_type", () => {
    expect(adapter.activityDetailFromPayload("awaiting-input", { notification_type: "permission_prompt" })).toEqual({
      waiting: "permission",
    })
    expect(adapter.activityDetailFromPayload("awaiting-input", { notification_type: "elicitation_dialog" })).toEqual({
      waiting: "input",
    })
  })
})

/**
 * Session identity extraction — Claude pipes `session_id`/`transcript_path`
 * on every hook payload; this is what lets kobe pin a live sessionId per
 * task/tab, including user-typed `claude` sessions it never spawned. Type
 * guards matter: a malformed payload must yield undefined, never throw
 * (hooks run on every turn boundary machine-wide).
 */
describe("sessionFromPayload", () => {
  const adapter = new ClaudeHookAdapter()

  it("extracts session_id + transcript_path", () => {
    expect(
      adapter.sessionFromPayload({ session_id: "abc-123", transcript_path: "/tmp/abc-123.jsonl", cwd: "/wt" }),
    ).toEqual({ sessionId: "abc-123", transcriptPath: "/tmp/abc-123.jsonl" })
  })

  it("omits transcriptPath when absent, and returns undefined without a session_id", () => {
    expect(adapter.sessionFromPayload({ session_id: "abc" })).toEqual({ sessionId: "abc" })
    expect(adapter.sessionFromPayload({})).toBeUndefined()
    expect(adapter.sessionFromPayload({ session_id: 42 })).toBeUndefined()
    expect(adapter.sessionFromPayload({ session_id: "" })).toBeUndefined()
    expect(adapter.sessionFromPayload({ session_id: "abc", transcript_path: 7 })).toEqual({ sessionId: "abc" })
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
    expect(out.model).toBe("opus") // untouched
    expect(out.hooks?.PostToolUse).toEqual(userSettings.hooks.PostToolUse) // untouched
    // kobe's Stop coexists with the user's Stop hook (both kept).
    expect(JSON.stringify(out.hooks?.Stop)).toContain("turn-complete")
    expect(JSON.stringify(out.hooks?.Stop)).toContain("user-old-stop")
    expect(out.hooks?.Stop).toHaveLength(2)
  })

  it("is idempotent — re-install replaces only kobe's own entry, no duplicates", () => {
    const once = mergeActivityHooks({}, true, ["kobe"])
    const twice = mergeActivityHooks(once, true, ["kobe"]) as SettingsShape
    expect(twice.hooks?.Stop).toHaveLength(1)
  })

  it("replaces LEGACY unquoted `kobe hook <verb>` entries too, keeping user hooks", () => {
    // Early kobe wrote hook commands unquoted (`kobe hook turn-complete`); the
    // quoted-marker-only recognizer left them behind on every upgrade, so each
    // Claude event fired kobe's hook twice. They must be treated as kobe's own.
    const legacy = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "kobe hook turn-complete" }] },
          { hooks: [{ type: "command", command: "user-old-stop" }] },
        ],
        Notification: [
          { matcher: "permission_prompt", hooks: [{ type: "command", command: "kobe hook awaiting-input" }] },
        ],
      },
    }
    const out = mergeActivityHooks(legacy, true, ["kobe"]) as SettingsShape
    expect(out.hooks?.Stop).toHaveLength(2) // fresh kobe entry + the user's, legacy dropped
    expect(JSON.stringify(out.hooks?.Stop)).toContain("user-old-stop")
    expect(JSON.stringify(out.hooks?.Stop)).toContain("'hook' 'turn-complete'")
    expect(JSON.stringify(out.hooks?.Stop)).not.toContain('"kobe hook turn-complete"')
    expect(JSON.stringify(out.hooks)).not.toContain('"kobe hook awaiting-input"')
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

  it("activity + worktree-sync hooks coexist in one settings file", () => {
    const withActivity = mergeActivityHooks({}, true, ["kobe"])
    const both = mergeWorktreeSyncHook(withActivity, "kobe hook worktree-created") as SettingsShape
    expect(both.hooks?.Stop).toHaveLength(1)
    expect(both.hooks?.WorktreeCreate).toHaveLength(1)
    // Removing one leaves the other intact.
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
    expect(out.model).toBe("opus") // untouched
    const post = out.hooks?.PostToolUse as Array<{ matcher?: string; hooks: { command: string }[] }>
    expect(post).toHaveLength(2) // user's Edit hook + kobe's Bash hook coexist
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
