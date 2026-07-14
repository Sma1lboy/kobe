/**
 * Env contract for AUTOSPAWNED daemons (`connectOrStartDaemon`'s spawn).
 *
 * Why this matters: a `kobe` helper running INSIDE an engine tab inherits
 * the session's identity env (KOBE_TASK_ID/KOBE_TAB_ID/KOBE_TUI/
 * KOBE_TERMINAL_PTY). Passing that straight into a spawned daemon produced
 * the 2026-07-13 zombies: long-lived shared daemons stamped with one tab's
 * identity, invisible to the idle-stop policy (they never saw a gui). The
 * spawn env must drop the session markers and carry the autospawn flag the
 * lifetime policy keys its first-gui grace on.
 */

import { autospawnDaemonEnv } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { describe, expect, it } from "vitest"

describe("autospawnDaemonEnv", () => {
  it("drops engine-session identity, keeps overrides, stamps the autospawn flag", () => {
    const env = autospawnDaemonEnv({
      KOBE_TASK_ID: "01ABC",
      KOBE_TAB_ID: "tab-3",
      KOBE_TUI: "1",
      KOBE_TERMINAL_PTY: "1",
      KOBE_HOME_DIR: "/tmp/sandbox-home",
      KOBE_DAEMON_SOCKET_PATH: "/tmp/sandbox.sock",
      PATH: "/usr/bin",
    })
    expect(env.KOBE_TASK_ID).toBeUndefined()
    expect(env.KOBE_TAB_ID).toBeUndefined()
    expect(env.KOBE_TUI).toBeUndefined()
    expect(env.KOBE_TERMINAL_PTY).toBeUndefined()
    // Explicit isolation overrides (dev:sandbox, captures) must survive.
    expect(env.KOBE_HOME_DIR).toBe("/tmp/sandbox-home")
    expect(env.KOBE_DAEMON_SOCKET_PATH).toBe("/tmp/sandbox.sock")
    expect(env.PATH).toBe("/usr/bin")
    expect(env.KOBE_DAEMON_AUTOSPAWNED).toBe("1")
  })
})
