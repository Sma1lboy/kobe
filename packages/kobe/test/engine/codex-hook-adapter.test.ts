import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodexHookAdapter, KOBE_CODEX_HOOK_EVENTS, codexHooksPath } from "../../src/engine/codex-local/hook-adapter.ts"

// The adapter's install path builds hook commands from `kobeCliInvocation()`,
// which resolves `@opentui/solid/preload` via `import.meta.resolve` and throws
// when that can't resolve (some test runners). Pin it so the roundtrip exercises
// the merge/IO, not CLI-path resolution.
vi.mock("../../src/cli/invocation.ts", () => ({ kobeCliInvocation: () => ["kobe"] }))

describe("CodexHookAdapter", () => {
  const adapter = new CodexHookAdapter()

  it("declares itself a wired hook engine writing ~/.codex/hooks.json", () => {
    expect(adapter.vendor).toBe("codex")
    expect(adapter.supportsHooks()).toBe(true)
    expect(adapter.globalSettingsPath()).toBe(codexHooksPath())
    expect(adapter.globalSettingsPath().endsWith(join(".codex", "hooks.json"))).toBe(true)
  })

  it("never installed the legacy WorktreeCreate hook → nothing to clean up", () => {
    expect(adapter.supportsWorktreeSync()).toBe(false)
  })

  it("decodes no extra detail (no failure/permission events are wired)", () => {
    expect(adapter.activityDetailFromPayload("turn-complete", {})).toBeUndefined()
    expect(adapter.activityDetailFromPayload("turn-failed", { error_type: "rate_limit" })).toBeUndefined()
  })

  it("owns exactly the three events Codex can deliver safely", () => {
    expect([...KOBE_CODEX_HOOK_EVENTS].sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"].sort())
    // The verbs with no clean Codex signal are NOT installed.
    for (const absent of ["StopFailure", "Notification", "SessionEnd"]) {
      expect(KOBE_CODEX_HOOK_EVENTS).not.toContain(absent)
    }
  })
})

describe("CodexHookAdapter install/remove roundtrip (real file)", () => {
  let dir: string
  let file: string
  const adapter = new CodexHookAdapter()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kobe-codex-hooks-"))
    file = join(dir, "hooks.json")
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function readHooks(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(file, "utf8")).hooks
  }

  it("installs SessionStart/UserPromptSubmit/Stop + the Bash worktree-watch, preserving the user's hooks", async () => {
    // Seed a user-authored hook that must survive kobe's merge.
    await writeFile(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }] } }))

    await adapter.installActivityHooks(file)
    await adapter.installWorktreeWatchHook(file)

    const hooks = await readHooks()
    expect(hooks.SessionStart).toBeDefined()
    expect(hooks.UserPromptSubmit).toBeDefined()
    expect(hooks.Stop).toBeDefined()
    // Codex never delivers these → kobe must not install them.
    expect(hooks.StopFailure).toBeUndefined()
    expect(hooks.Notification).toBeUndefined()
    expect(hooks.SessionEnd).toBeUndefined()
    // kobe's Stop coexists with the user's Stop hook.
    expect(JSON.stringify(hooks.Stop)).toContain("turn-complete")
    expect(JSON.stringify(hooks.Stop)).toContain("user-stop")
    // Worktree-watch is a PostToolUse(Bash) observer.
    const post = hooks.PostToolUse as Array<{ matcher?: string }>
    expect(post[0].matcher).toBe("Bash")
    expect(JSON.stringify(post)).toContain("worktree-created")
  })

  it("removal strips kobe's hooks but keeps the user's", async () => {
    await writeFile(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }] } }))
    await adapter.installActivityHooks(file)
    await adapter.installWorktreeWatchHook(file)

    await adapter.removeActivityHooks(file)
    await adapter.removeWorktreeWatchHook(file)

    const hooks = await readHooks()
    expect(JSON.stringify(hooks.Stop)).toContain("user-stop")
    expect(JSON.stringify(hooks.Stop)).not.toContain("turn-complete")
    expect(hooks.SessionStart).toBeUndefined()
    expect(hooks.PostToolUse).toBeUndefined()
  })
})
