/**
 * Real-tmux smoke test for the keybindings builder. We don't drive the
 * bootstrap here — that path attaches and exits the process. Instead
 * we create a throwaway detached tmux session, install one of the
 * argv vectors emitted by `buildBindKeyArgs` via `tmux bind-key ...`,
 * then assert `tmux list-keys -T root` shows the binding back to us.
 *
 * Gated on tmux availability; the behavior runner itself is gated on
 * `KOBE_INCLUDE_BEHAVIOR=1`. Mirrors `tmux-control-client.test.ts`.
 */

import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, expect, it } from "vitest"
import { buildBindKeyArgs } from "../../src/tmux/keybindings.ts"

const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0

let session = ""

beforeEach(() => {
  const id = Math.random().toString(36).slice(2, 8)
  session = `kobe-keybind-${id}`
})

afterEach(() => {
  if (session) {
    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })
  }
})

it.skipIf(!tmuxAvailable)(
  "installing a bind-key argv against a real tmux makes the chord visible in list-keys -T root",
  () => {
    // 1. Spin up a throwaway detached session.
    const created = spawnSync(
      "tmux",
      ["new-session", "-d", "-s", session, "sleep", "60"],
      { encoding: "utf8" },
    )
    expect(created.status, created.stderr).toBe(0)

    // 2. Install ONE of our default bindings. Pick M-t (new-tab) so
    //    we can match a stable substring in list-keys output.
    const argvs = buildBindKeyArgs({ kobeBin: "echo-kobe-stub" })
    const newTabArgv = argvs.find((a) => a[4] === "M-t")
    expect(newTabArgv, "M-t binding should exist in defaults").toBeDefined()
    if (!newTabArgv) throw new Error("unreachable")

    const installed = spawnSync("tmux", [...newTabArgv], { encoding: "utf8" })
    expect(installed.status, installed.stderr).toBe(0)

    // 3. Ask tmux what it knows about the root table. The output
    //    format is `bind-key -T root M-t run-shell …` (one per line).
    const listed = spawnSync("tmux", ["list-keys", "-T", "root"], { encoding: "utf8" })
    expect(listed.status, listed.stderr).toBe(0)
    const stdout = listed.stdout
    // Look for a line that mentions M-t AND our stub binary — that
    // pair uniquely identifies our binding (tmux's defaults never
    // reference "echo-kobe-stub").
    const lines = stdout.split("\n").filter((l) => l.includes("M-t") && l.includes("echo-kobe-stub"))
    expect(lines.length, `expected M-t binding in list-keys output. Got:\n${stdout}`).toBeGreaterThan(0)
    // Sanity: it should be a run-shell command invoking `kobe rpc new-tab`.
    expect(lines[0]).toMatch(/run-shell/)
    expect(lines[0]).toMatch(/rpc new-tab/)
    expect(lines[0]).toMatch(/--no-wait/)
  },
  20_000,
)
