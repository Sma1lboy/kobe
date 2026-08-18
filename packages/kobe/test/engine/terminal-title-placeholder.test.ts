import { describe, expect, it } from "vitest"
import { engineSessionIdFromTitle, isEnginePlaceholderTitle } from "../../src/engine/registry.ts"
import { titleIsPlaceholder, titleSessionId } from "../../src/engine/terminal-title.ts"

/**
 * Codex writes its THREAD ID into the OSC title until the thread is named
 * (`tui.terminal_title=["activity","thread-title"]` documents itself as "the
 * thread title, or the thread identifier when unnamed"), so a live codex tab
 * reports `01a00ee9-f0e9-7503-a11c-83b4eface0f6` where claude reports a
 * sentence. Kobe must not render that as a name — and the id is exactly what
 * names the tab instead (the rollout it points at holds the first prompt).
 */
const CODEX_THREAD_TITLE = "01a00ee9-f0e9-7503-a11c-83b4eface0f6"

describe("engine placeholder titles", () => {
  it("reads codex's thread id back out of its own title", () => {
    expect(engineSessionIdFromTitle("codex", CODEX_THREAD_TITLE)).toBe(CODEX_THREAD_TITLE)
    expect(isEnginePlaceholderTitle(CODEX_THREAD_TITLE, "codex")).toBe(true)
  })

  it("a NAMED codex thread is a name, not a placeholder", () => {
    expect(engineSessionIdFromTitle("codex", "fix the flaky watcher test")).toBeNull()
    expect(isEnginePlaceholderTitle("fix the flaky watcher test", "codex")).toBe(false)
    // A title that merely CONTAINS a uuid is still a name (anchored match).
    expect(isEnginePlaceholderTitle(`resume ${CODEX_THREAD_TITLE}`, "codex")).toBe(false)
  })

  it("engines whose title is always a name declare no rule", () => {
    for (const vendor of ["claude", "kimi", "copilot"] as const) {
      expect(isEnginePlaceholderTitle(CODEX_THREAD_TITLE, vendor)).toBe(false)
      expect(engineSessionIdFromTitle(vendor, CODEX_THREAD_TITLE)).toBeNull()
    }
  })

  it("an unresolved vendor still rejects the placeholder, but never claims the id", () => {
    // The process-tree probe is a ~2s ps walk; without the union fallback a
    // placeholder slips through on every tick it can't answer and gets
    // recorded as the tab's name (the same reason stripEngineStatusPrefix
    // falls back to the union of every built-in's glyphs).
    expect(isEnginePlaceholderTitle(CODEX_THREAD_TITLE, undefined)).toBe(true)
    expect(isEnginePlaceholderTitle("fix the flaky watcher test", null)).toBe(false)
    // …but an id is only meaningful against the store of the engine that
    // wrote it, so an unresolved vendor answers null rather than guessing.
    expect(engineSessionIdFromTitle(undefined, CODEX_THREAD_TITLE)).toBeNull()
    expect(engineSessionIdFromTitle(null, CODEX_THREAD_TITLE)).toBeNull()
  })

  it("the pure rules cover the other placeholder shape too", () => {
    // An engine whose bad title carries NO session id (a cwd, a model name)
    // declares `isPlaceholderTitle` instead — no vendor check in neutral code.
    const policy = { ownsStatus: false, isPlaceholderTitle: (t: string) => t === "shell" }
    expect(titleIsPlaceholder(policy, "shell")).toBe(true)
    expect(titleSessionId(policy, "shell")).toBeNull()
    expect(titleIsPlaceholder(policy, "reviewing the diff")).toBe(false)
    // An engine with no policy at all judges nothing, and "" is never a
    // placeholder — it is "nothing reported yet".
    expect(titleIsPlaceholder(undefined, "anything")).toBe(false)
    expect(titleIsPlaceholder(policy, "   ")).toBe(false)
  })
})
