import { settledWithin, signalProcessGroup } from "@sma1lboy/kobe-daemon/daemon/pty-terminate"
import { describe, expect, test } from "vitest"

describe("settledWithin", () => {
  test("reports a resolved exit, and a rejected one just the same", async () => {
    expect(await settledWithin(Promise.resolve(0), 50)).toBe(true)
    // An exit is an exit however the runtime reports it — treating a rejection
    // as "still running" would escalate to SIGKILL against a dead process.
    expect(await settledWithin(Promise.reject(new Error("spawn lost")), 50)).toBe(true)
  })

  test("gives up on a promise that never settles instead of hanging the caller", async () => {
    // The node-pty driver's `exited` resolves only when ConPTY delivers
    // onExit; one wedged child must not hang killAll() and the host shutdown.
    expect(await settledWithin(new Promise(() => {}), 20)).toBe(false)
  })

  test("does not leave a pending timer holding the event loop open", async () => {
    // A leaked timer would keep the pty host process alive past idle-exit.
    const before = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length ?? 0
    await settledWithin(Promise.resolve(0), 60_000)
    const after = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length ?? 0
    expect(after).toBeLessThanOrEqual(before)
  })
})

describe("signalProcessGroup", () => {
  test("Windows goes straight to the child — it has no process group to signal", () => {
    let fellBack = false
    signalProcessGroup(
      4242,
      "SIGTERM",
      () => {
        fellBack = true
      },
      "win32",
    )
    expect(fellBack).toBe(true)
  })

  test("POSIX tries the group first and only falls back when that fails", () => {
    let fellBack = false
    // pid 1 is excluded on purpose: `kill(-1)` is "every process I may signal".
    signalProcessGroup(
      1,
      "SIGTERM",
      () => {
        fellBack = true
      },
      "linux",
    )
    expect(fellBack).toBe(true)

    fellBack = false
    // A pid whose group does not exist: kill(-pid) throws ESRCH, and the
    // child-only fallback must still run.
    signalProcessGroup(
      2147483646,
      "SIGTERM",
      () => {
        fellBack = true
      },
      "linux",
    )
    expect(fellBack).toBe(true)
  })

  test("a fallback that throws on an already-dead child is swallowed", () => {
    expect(() =>
      signalProcessGroup(
        4242,
        "SIGKILL",
        () => {
          throw new Error("Cannot kill a pty that has already exited")
        },
        "win32",
      ),
    ).not.toThrow()
  })
})
