import { describe, expect, it } from "vitest"
import { engineSessionIdFromTitle, isEnginePlaceholderTitle } from "../../src/engine/registry.ts"
import { titleIsPlaceholder, titleSessionId } from "../../src/engine/terminal-title.ts"

/**
 * Codex writes its THREAD ID into the OSC title until the thread is named
 * (`tui.terminal_title=["activity","thread-title"]` documents itself as "the
 * thread title, or the thread identifier when unnamed"), so a live codex tab
 * reports `01a00ee9-f0e9-7503-a11c-83b4eface0f6` where claude reports a
 * sentence. Rove must not render that as a name — and the id is exactly what
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

  it("an engine that declares no rule judges nothing", () => {
    // The pure layer is what a future engine plugs into; with no policy there
    // is no verdict, and "" is never a placeholder — it is "nothing reported
    // yet", which every caller already treats as absent.
    expect(titleIsPlaceholder(undefined, CODEX_THREAD_TITLE)).toBe(false)
    expect(titleSessionId(undefined, CODEX_THREAD_TITLE)).toBeNull()
    expect(titleIsPlaceholder({ ownsStatus: true, sessionIdFromTitle: () => null }, "   ")).toBe(false)
  })
})
