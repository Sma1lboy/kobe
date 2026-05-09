/**
 * Stream J — terminal pane behavior test.
 *
 * Spawns the real kobe binary in `KOBE_TERMINAL_HOST=1` mode under a
 * PTY, drives the embedded shell via keystrokes, and asserts on visible
 * behavior. This is the load-bearing self-validation per HARNESS.md
 * §Behavioral self-test: unit tests prove the registry/encoder shape,
 * this proves the rendered pane actually echoes a real shell's output.
 *
 * The host fixture (`test/behavior/fixtures/terminal-host.tsx`) mounts
 * a single `<Terminal>` against `process.env.KOBE_TERMINAL_CWD`. We
 * use a freshly-`mkdtemp`'d directory so the captured `basename` in
 * the header is predictable.
 *
 * Backend: tmux. The constructor surfaces a clear error if tmux is
 * absent; if a future CI env doesn't have it, we surface the install
 * note from there. macOS / Linux dev boxes are the target.
 *
 * What we assert:
 *   1. The header `terminal — <basename>` is visible.
 *   2. After typing `echo hello\n`, "hello" appears in the rendered
 *      scrollback. (We rely on tmux echoing the line back through the
 *      PTY in the captured pane.)
 *   3. After typing `exit\n`, the shell process inside tmux dies. The
 *      pane is allowed to render either an empty body or the shell's
 *      farewell line. We assert that "kobe terminal host" (from the
 *      surrounding host shell) is still visible — the pane didn't take
 *      down the host.
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeAll, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

let kobe: KobeHandle | null = null
let tmpRoot = ""
let tmuxBin = ""

beforeAll(() => {
  // The Stream J implementation uses tmux. Skip with a clear message
  // if it's not available — but in this dev env, it should be.
  const r = spawnSync("tmux", ["-V"], { encoding: "utf8" })
  if (r.status !== 0) {
    throw new Error(
      "Stream J behavior test requires tmux on PATH. Install via 'brew install tmux' or set the path in your env.",
    )
  }
  tmuxBin = "tmux"
})

afterEach(async () => {
  if (kobe && !kobe.closed) {
    await kobe.exit()
  }
  kobe = null

  // Best-effort: list any kobe-task-* sessions still alive and kill
  // them so a flaky test doesn't leak across runs.
  try {
    const r = spawnSync(tmuxBin, ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" })
    if (r.status === 0) {
      for (const line of r.stdout.split("\n")) {
        const name = line.trim()
        if (name.startsWith("kobe-task-")) {
          spawnSync(tmuxBin, ["kill-session", "-t", name], { encoding: "utf8" })
        }
      }
    }
  } catch {
    /* swallow — cleanup is best-effort */
  }

  if (tmpRoot && fs.existsSync(tmpRoot)) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test("Stream J — embedded shell echoes 'hello' and survives exit", async () => {
  // Fixture cwd: a tmpdir whose basename is stable enough that the
  // header `terminal — <basename>` is easy to assert on.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-j-"))
  const fixtureCwd = path.join(tmpRoot, "termpane")
  fs.mkdirSync(fixtureCwd, { recursive: true })

  // Stable task id keeps the tmux session name predictable across
  // retries. The afterEach cleanup will kill it.
  const taskId = `j-${Date.now()}`

  kobe = await spawnKobe({
    env: {
      KOBE_TERMINAL_HOST: "1",
      KOBE_TERMINAL_CWD: fixtureCwd,
      KOBE_TERMINAL_TASK_ID: taskId,
      // Force a deterministic shell so prompt/colors don't depend on
      // the dev's chosen $SHELL config (zsh with oh-my-zsh produces
      // many escape codes, bash is more predictable for assertions).
      SHELL: "/bin/bash",
    },
    cols: 100,
    rows: 30,
  })

  // The host shell renders 'kobe terminal host' as a banner above
  // the pane. Wait for it as a boot signal.
  await kobe.waitFor((s) => s.includes("kobe terminal host"), 10_000)

  // The terminal pane header includes the basename of the cwd.
  await kobe.waitFor((s) => s.includes(`terminal — ${path.basename(fixtureCwd)}`), 10_000)

  // Type a command. The fixture host signals `focused = () => true`,
  // so keystrokes are forwarded to the PTY. We send `echo hello`
  // followed by Enter (\r). tmux's pane will reflect both the
  // command echo (typical bash behavior) and its output.
  await kobe.typeText("echo hello\r")

  // Wait for "hello" to appear in the captured scrollback. Generous
  // timeout — tmux capture polls at ~80ms inside kobe AND the PTY
  // driver's settle is ~100ms; cumulatively we want a few hundred
  // ms of slack.
  const after = await kobe.waitFor((s) => s.includes("hello"), 15_000)
  expect(after).toContain("hello")

  // Tell the shell to exit. We don't strictly verify a "shell
  // exited" message (different shells emit different farewells, or
  // none) — we only verify the host shell is still standing.
  await kobe.typeText("exit\r")
  // Brief pause so the shell has time to process exit.
  await new Promise((r) => setTimeout(r, 500))
  const final = await kobe.capture()
  expect(final).toContain("kobe terminal host")

  await kobe.exit()
  expect(kobe.closed).toBe(true)
}, 60_000)
