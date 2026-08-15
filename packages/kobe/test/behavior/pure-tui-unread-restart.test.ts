/**
 * Regression pin for issue #22 (owner report 2026-08-12, wisp): a session you
 * have already read must not come back UNREAD after you quit kobe and start
 * it again.
 *
 * The bug is environment-shaped, which is why this test spends two real TUI
 * processes on it: the daemon's activity registry outlives the TUI, so the
 * second launch is handed the very same `turn_complete` — while the seen bit
 * that digests the lamp lived only in the first process's memory. Nothing
 * short of an actual restart against a live daemon reproduces it.
 *
 * Shape: complete a turn on tab-1, let launch #1 sit in that tab (reading
 * it), then make tab-2 the active tab so launch #2 opens somewhere else and
 * tab-1's row is one you are NOT looking at — exactly where the lamp shows.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Terminal } from "@xterm/headless"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SIDEBAR_WIDTH } from "../../src/tui/panes/sidebar/view-core.ts"
import { type BehaviorEnv, DIST_ROVE_CLI, loadNodePty, makeBehaviorEnv, makeScratchRepo, runRove } from "./harness.ts"

const nodePty = await loadNodePty()

const COLS = 140
const ROWS = 40
/** ● an unread completion, ○ one already looked at, ◌ no daemon signal yet. */
const UNREAD = "●"
const SEEN = "○"

async function poll(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

describe.skipIf(!nodePty)("Pure TUI unread lamp across a restart (behavior)", () => {
  let env: BehaviorEnv
  let repo: string
  let statePath: string
  let taskId: string
  let branch: string

  const readState = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>

  /**
   * Boot the real TUI and hand back its screen as plain text lines — the
   * frame goes through a headless xterm, so a row reads as the cells the user
   * sees rather than as a stream of escapes with a glyph buried in it.
   */
  async function withTui<T>(run: (screen: () => string[]) => Promise<T>): Promise<T> {
    if (!nodePty) throw new Error("unreachable: suite is skipped without node-pty")
    const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
    // This child would inherit vitest's markers, and the host-session poll is
    // off under a test RUNNER — it is a real TUI in its own process.
    const { VITEST, NODE_ENV, BUN_TEST, ...tuiEnv } = env.env as Record<string, string>
    const child = nodePty.spawn("bun", [DIST_ROVE_CLI], { cols: COLS, rows: ROWS, cwd: repo, env: tuiEnv })
    const data = child.onData((chunk: string) => term.write(chunk))
    try {
      return await run(() => {
        const buffer = term.buffer.active
        const lines: string[] = []
        for (let y = 0; y < ROWS; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "")
        return lines
      })
    } finally {
      data.dispose()
      child.kill()
    }
  }

  /** The rail rows below this task's worktree row — its tabs, in tab order. */
  function tabRows(lines: readonly string[]): string[] {
    const rail = lines.map((line) => line.slice(0, SIDEBAR_WIDTH))
    const worktree = rail.findIndex((line) => line.includes(branch))
    return worktree < 0 ? [] : rail.slice(worktree + 1)
  }

  beforeAll(async () => {
    env = await makeBehaviorEnv()
    repo = await makeScratchRepo(env)
    // Rove reads and writes its canonical state; the old path is migration
    // input only, not a live mirror.
    const stateDir = join(env.home, ".config", "rove")
    await mkdir(stateDir, { recursive: true })
    statePath = join(stateDir, "state.json")
    await writeFile(statePath, JSON.stringify({ onboarded: true }))

    // `--prompt` takes the headless launch path: worktree + hosted engine
    // session under `<taskId>::tab-1`, plus the snapshot the TUI renders from.
    // Explicit short branch: the rail row is LABELLED by it, and an
    // auto-generated `rove/<slug>-<id>` is long enough to be truncated there.
    branch = "rove/pin"
    const add = runRove(["api", "add", "--repo", repo, "--branch", branch, "--prompt", "hello"], env)
    expect(add.code, add.stderr).toBe(0)
    taskId = (JSON.parse(add.stdout) as { task: { id: string } }).task.id

    await poll(() => {
      const sessions = JSON.parse(runRove(["api", "pty-list"], env).stdout) as {
        sessions?: { key: string; alive?: boolean }[]
      }
      return sessions.sessions?.some((s) => s.key === `${taskId}::tab-1` && s.alive) === true
    }, 30_000)

    // The turn the user is about to read. An engine tab passes canonical IDs
    // plus the compatibility aliases, so the daemon records this completion
    // against tab-1.
    const hook = runRove(["hook", "turn-complete", "--engine", "claude-code-local"], {
      ...env,
      env: {
        ...env.env,
        ROVE_TASK_ID: taskId,
        ROVE_TAB_ID: "tab-1",
        KOBE_TASK_ID: taskId,
        KOBE_TAB_ID: "tab-1",
      },
    })
    expect(hook.code, hook.stderr).toBe(0)
  }, 120_000)

  afterAll(async () => {
    await env.dispose()
  })

  it("keeps a completion read after kobe is restarted", async () => {
    const key = `terminalTabs.${taskId}`

    // Launch #1 — boot lands in the restored session, so tab-1 is the tab the
    // user is looking at and its completion is read.
    await withTui(async (screen) => {
      await poll(() => screen().some((line) => line.includes("scratch-repo")), 30_000)
      expect(
        screen().some((line) => line.includes("scratch-repo")),
        "the rail never hydrated",
      ).toBe(true)
      // The durable receipt of that read. Polled, not raced: the KV write is
      // debounced, and launch #2 must not start before it lands.
      await poll(async () => (await readState()).completionSeen !== undefined, 30_000)
      expect(await readState(), "launch #1 never recorded the completion as read").toHaveProperty("completionSeen")
    })

    // Between launches the user leaves that tab: tab-2 is what the next
    // launch opens, so tab-1's row is a session nobody is looking at.
    const state = await readState()
    const snapshot = state[key] as { tabs: unknown[]; activeId: string; nextOrdinal: number }
    expect((snapshot?.tabs?.[0] as { id?: string } | undefined)?.id).toBe("tab-1")
    snapshot.tabs.push({ kind: "engine", id: "tab-2", title: null, ordinal: 2 })
    snapshot.activeId = "tab-2"
    snapshot.nextOrdinal = 3
    await writeFile(statePath, JSON.stringify(state))

    // Launch #2 — the daemon replays the very same turn_complete it never
    // forgot, against a process whose in-memory seen bits are empty.
    await withTui(async (screen) => {
      // Wait for that activity to reach the rail (the row leaves the "no
      // signal" glyph). Whether it lands on ● or ○ is the question below.
      await poll(() => {
        const row = tabRows(screen())[0] ?? ""
        return row.includes(SEEN) || row.includes(UNREAD)
      }, 30_000)
      const row = tabRows(screen())[0] ?? ""
      expect(row, "a completion already read came back unread after the restart").not.toContain(UNREAD)
      expect(row, "tab-1's row never received the daemon's activity").toContain(SEEN)
      // ...and the row genuinely was one nobody was looking at. Had this
      // launch landed back in tab-1, the session-only seen bit would digest
      // the lamp on its own and the assertions above would say nothing.
      const parked = (await readState())[key] as { activeId?: string } | undefined
      expect(parked?.activeId, "launch #2 did not stay parked on tab-2").toBe("tab-2")
    })
  }, 120_000)
})
