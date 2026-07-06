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

  it("ctrl+h focuses the Tasks rail; a second (left-edge) ctrl+h does NOT wrap", async () => {
    tmux(env, "send-keys", "-t", SESSION, "C-h")
    expect(await waitForRole(env, "tasks")).toBe("tasks")

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
