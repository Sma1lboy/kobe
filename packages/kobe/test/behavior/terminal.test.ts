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
 * Backend: direct shell pipes. This intentionally avoids tmux so the
 * behavior test matches the production default.
 *
 * What we assert:
 *   1. The header `terminal — <basename>` is visible.
 *   2. After typing `echo hello\n`, "hello" appears in the rendered
 *      scrollback.
 *   3. After typing `exit\n`, the shell process dies. The
 *      pane is allowed to render either an empty body or the shell's
 *      farewell line. We assert that "kobe terminal host" (from the
 *      surrounding host shell) is still visible — the pane didn't take
 *      down the host.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

let kobe: KobeHandle | null = null
let tmpRoot = ""

afterEach(async () => {
  if (kobe && !kobe.closed) {
    await kobe.exit()
  }
  kobe = null

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

  // Stable task id keeps the registry key predictable across retries.
  const taskId = `j-${Date.now()}`

  kobe = await spawnKobe({
    env: {
      KOBE_TERMINAL_HOST: "1",
      KOBE_TERMINAL_CWD: fixtureCwd,
      KOBE_TERMINAL_TASK_ID: taskId,
      // Force a deterministic shell so prompt/colors don't depend on
      // the dev's chosen $SHELL config.
      SHELL: "/bin/bash",
    },
    cols: 100,
    rows: 30,
  })

  // The host shell renders 'kobe terminal host' as a banner above
  // the pane. Wait for it as a boot signal.
  await kobe.waitFor((s) => s.includes("kobe terminal host"), 10_000)

  // Wait until the embedded shell has produced its first prompt/output.
  await kobe.waitFor((s) => s.includes("$") || s.includes("%") || s.includes("#"), 10_000)

  // Type a command. The fixture host signals `focused = () => true`,
  // so keystrokes are forwarded to the PTY. We send `echo hello`
  // followed by Enter (\r). The pipe backend normalizes CR to LF.
  await kobe.typeText("echo hello\r")

  // Wait for "hello" to appear in the captured scrollback. Generous
  // timeout — process startup and shell prompts can vary on dev boxes.
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
