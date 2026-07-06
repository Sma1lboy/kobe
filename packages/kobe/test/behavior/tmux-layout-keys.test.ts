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

const SESSION = "layoutkeys"

interface PaneRow {
  paneId: string
  role: string
  pid: number
}

function taskSessionName(env: BehaviorEnv): string {
  const name = tmuxInner(env, "list-sessions", "-F", "#{session_name}")
    .stdout.split("\n")
    .find((s) => s.startsWith("kobe-") && s !== "kobe-home")
  if (!name) throw new Error("no task session found on the inner socket")
  return name
}

function currentPanes(env: BehaviorEnv, session: string): PaneRow[] {
  return tmuxInner(env, "list-panes", "-t", `=${session}`, "-F", "#{pane_id}\t#{@kobe_role}\t#{pane_pid}")
    .stdout.split("\n")
    .filter(Boolean)
    .map((line) => {
      const [paneId, role, pid] = line.split("\t")
      return { paneId, role, pid: Number.parseInt(pid ?? "", 10) } as PaneRow
    })
}

function roleSet(rows: readonly PaneRow[]): Set<string> {
  return new Set(rows.map((r) => r.role))
}

function pidOf(rows: readonly PaneRow[], role: string): number | undefined {
  return rows.find((r) => r.role === role)?.pid
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

function resolvePrefixKey(env: BehaviorEnv): string {
  const out = tmuxInner(env, "show-options", "-g", "prefix").stdout.trim()
  return out.split(/\s+/)[1] || "C-b"
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return predicate()
}

describe.skipIf(!tmuxAvailable())("tmux prefix-table layout chords (behavior)", () => {
  let env: BehaviorEnv
  let session: string
  let prefixKey: string

  beforeAll(async () => {
    env = await makeBehaviorEnv()
    const repo = await makeScratchRepo(env)
    const boot = tmux(env, "new-session", "-d", "-x", "180", "-y", "45", "-s", SESSION, `cd ${repo} && kobe`)
    expect(boot.code).toBe(0)
    await waitForScreen(env, SESSION, (s) => s.includes("KOBE v") && s.includes("fake-claude ready"), 45_000)
    session = taskSessionName(env)
    prefixKey = resolvePrefixKey(env)
  }, 60_000)

  afterAll(async () => {
    await env.dispose()
  })

  function sendPrefixChord(letter: string): void {
    tmux(env, "send-keys", "-t", SESSION, prefixKey, letter)
  }

  it("prefix a hides/restores the Tasks rail, preserving its pane process", async () => {
    const before = currentPanes(env, session)
    expect(roleSet(before)).toEqual(new Set(["tasks", "claude", "ops", "shell"]))
    const tasksPid = pidOf(before, "tasks") as number

    sendPrefixChord("a")
    const hidden = await waitUntil(() => !roleSet(currentPanes(env, session)).has("tasks"))
    expect(hidden).toBe(true)
    expect(roleSet(currentPanes(env, session))).toEqual(new Set(["claude", "ops", "shell"]))
    expect(isAlive(tasksPid)).toBe(true)

    sendPrefixChord("a")
    const restored = await waitUntil(() => roleSet(currentPanes(env, session)).has("tasks"))
    expect(restored).toBe(true)
    const after = currentPanes(env, session)
    expect(roleSet(after)).toEqual(new Set(["tasks", "claude", "ops", "shell"]))
    expect(pidOf(after, "tasks")).toBe(tasksPid)
  }, 20_000)

  it("prefix o toggles the Ops pane by killing + rebuilding it (pid changes on restore)", async () => {
    const before = currentPanes(env, session)
    const opsPidBefore = pidOf(before, "ops") as number

    sendPrefixChord("o")
    const hidden = await waitUntil(() => !roleSet(currentPanes(env, session)).has("ops"))
    expect(hidden).toBe(true)
    expect(roleSet(currentPanes(env, session))).toEqual(new Set(["tasks", "claude", "shell"]))
    const killed = await waitUntil(() => !isAlive(opsPidBefore))
    expect(killed).toBe(true)

    sendPrefixChord("o")
    const restored = await waitUntil(() => roleSet(currentPanes(env, session)).has("ops"))
    expect(restored).toBe(true)
    const after = currentPanes(env, session)
    expect(roleSet(after)).toEqual(new Set(["tasks", "claude", "ops", "shell"]))
    expect(pidOf(after, "ops")).not.toBe(opsPidBefore)
  }, 20_000)

  it("prefix z hides/restores the terminal pane, preserving its shell process", async () => {
    const before = currentPanes(env, session)
    const shellPid = pidOf(before, "shell") as number

    sendPrefixChord("z")
    const hidden = await waitUntil(() => !roleSet(currentPanes(env, session)).has("shell"))
    expect(hidden).toBe(true)
    expect(roleSet(currentPanes(env, session))).toEqual(new Set(["tasks", "claude", "ops"]))
    expect(isAlive(shellPid)).toBe(true)

    sendPrefixChord("z")
    const restored = await waitUntil(() => roleSet(currentPanes(env, session)).has("shell"))
    expect(restored).toBe(true)
    const after = currentPanes(env, session)
    expect(roleSet(after)).toEqual(new Set(["tasks", "claude", "ops", "shell"]))
    expect(pidOf(after, "shell")).toBe(shellPid)
  }, 20_000)

  it("prefix space (zen) collapses to Tasks + engine, restoring the full workspace with the terminal process intact", async () => {
    const before = currentPanes(env, session)
    expect(roleSet(before)).toEqual(new Set(["tasks", "claude", "ops", "shell"]))
    const shellPid = pidOf(before, "shell") as number

    sendPrefixChord("Space")
    const zenned = await waitUntil(() => roleSet(currentPanes(env, session)).size === 2)
    expect(zenned).toBe(true)
    expect(roleSet(currentPanes(env, session))).toEqual(new Set(["tasks", "claude"]))

    sendPrefixChord("Space")
    const restored = await waitUntil(() => roleSet(currentPanes(env, session)).size === 4)
    expect(restored).toBe(true)
    const after = currentPanes(env, session)
    expect(roleSet(after)).toEqual(new Set(["tasks", "claude", "ops", "shell"]))
    expect(pidOf(after, "shell")).toBe(shellPid)
  }, 20_000)
})
