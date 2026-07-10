/**
 * TUI boot smoke + pane-focus regression pins — kobe operated exactly the way
 * the demo-video capture does (packages/branding/scripts/capture-tui.ts):
 * the dist build launches inside a host tmux pane, the test send-keys real
 * chords and asserts the captured screen / the inner session's pane state.
 *
 * Regression pins carried here:
 *   - boot renders the workspace (brand header + rail + engine pane) in an
 *     isolated env with a fake `claude` — a packaging/boot break is visible
 *     as a black-box failure, not a unit-test blind spot.
 *   - ctrl+h/ctrl+l move pane focus directionally, and a LEFT-EDGE ctrl+h is
 *     a no-op instead of tmux's default wrap-around (#192 / focusBindCommand
 *     edge guard) — and must not wedge the client (run-shell -b).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  type BehaviorEnv,
  makeBehaviorEnv,
  makeScratchRepo,
  tmux,
  tmuxAvailable,
  tmuxInner,
  waitForScreen,
} from "./harness.ts"

const SESSION = "smoke"

/** The inner session's active pane role (`@kobe_role`: tasks/claude/…). */
function activeRole(env: BehaviorEnv): string {
  const rows = tmuxInner(env, "list-panes", "-a", "-F", "#{pane_active}\t#{@kobe_role}").stdout
  const active = rows.split("\n").find((l) => l.startsWith("1\t"))
  return active?.split("\t")[1] ?? ""
}

async function waitForRole(env: BehaviorEnv, want: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let got = ""
  while (Date.now() < deadline) {
    got = activeRole(env)
    if (got === want) return got
    await new Promise((r) => setTimeout(r, 250))
  }
  return got
}

describe.skipIf(!tmuxAvailable())("kobe TUI boot + focus chords (behavior)", () => {
  let env: BehaviorEnv
  beforeAll(async () => {
    env = await makeBehaviorEnv()
    const repo = await makeScratchRepo(env)
    const boot = tmux(env, "new-session", "-d", "-x", "180", "-y", "45", "-s", SESSION, `cd ${repo} && kobe`)
    expect(boot.code).toBe(0)
  }, 30_000)
  afterAll(async () => {
    await env.dispose()
  })

  it("boots into the workspace: brand header, rail sections, live engine pane", async () => {
    const screen = await waitForScreen(
      env,
      SESSION,
      (s) => s.includes("KOBE v") && s.includes("PROJECTS") && s.includes("fake-claude ready"),
      45_000,
    )
    expect(screen).toContain("TASKS")
    expect(screen).not.toMatch(/Module not found|panic|Unhandled/i)
  }, 50_000)

  it("uses a subtle inactive divider and keeps the accent for the active pane", () => {
    const border = tmuxInner(env, "show-options", "-gwv", "pane-border-style").stdout.trim()
    const active = tmuxInner(env, "show-options", "-gwv", "pane-active-border-style").stdout.trim()
    expect(border.toLowerCase()).toBe("fg=#2b2a27")
    expect(active.toLowerCase()).toBe("fg=#cc785c")
  })

  it("ctrl+h focuses the Tasks rail; a second (left-edge) ctrl+h does NOT wrap", async () => {
    tmux(env, "send-keys", "-t", SESSION, "C-h")
    expect(await waitForRole(env, "tasks")).toBe("tasks")

    // Left edge: the pre-#192 default wrapped to the RIGHTMOST pane; the
    // edge guard must make this a no-op — and run-shell -b must leave the
    // client responsive (the follow-up ctrl+l below still lands).
    tmux(env, "send-keys", "-t", SESSION, "C-h")
    await new Promise((r) => setTimeout(r, 1_500))
    expect(activeRole(env)).toBe("tasks")
  }, 30_000)

  it("ctrl+l moves focus right, off the rail", async () => {
    tmux(env, "send-keys", "-t", SESSION, "C-l")
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && activeRole(env) === "tasks") {
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(activeRole(env)).not.toBe("tasks")
  }, 15_000)
})
