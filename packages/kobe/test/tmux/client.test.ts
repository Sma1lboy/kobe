import { describe, expect, test } from "vitest"
import { runTmux, runTmuxCapturing, tmuxCommandSequence } from "../../src/tmux/client"

describe("spawn failure degrades instead of throwing", () => {
  // Regression: a Tasks/Ops pane runs with its task's worktree as cwd.
  // Deleting the task unlinks that worktree, after which `Bun.spawn`
  // throws posix_spawn ENOENT BEFORE the command runs — even though tmux
  // is on PATH — because the kernel can't resolve the inherited (gone)
  // cwd. The spawn helpers anchor their cwd to SAFE_SPAWN_CWD AND wrap the
  // spawn so ANY synchronous spawn failure degrades to a documented
  // non-zero result rather than rejecting. Without that wrapper the throw
  // propagated into a polling loop and crashed the crash-net-less pane
  // process to a bare shell.
  //
  // Under vitest the synchronous failure is `Bun is not defined` (the Bun
  // global is absent in the Node test VM); in production it's the ENOENT
  // above. Either way the helper must resolve to its fallback, never throw.
  test("runTmuxCapturing resolves to a non-zero empty capture", async () => {
    await expect(runTmuxCapturing(["display-message", "-p", "x"])).resolves.toEqual({ code: 1, stdout: "" })
  })

  test("runTmux resolves to a non-zero exit code", async () => {
    await expect(runTmux(["display-message", "-p", "x"])).resolves.toBe(1)
  })
})

describe("tmuxCommandSequence", () => {
  test("joins commands with tmux command separators", () => {
    expect(
      tmuxCommandSequence([
        ["set-option", "-g", "status", "on"],
        ["bind-key", "-n", "C-q", "detach-client"],
      ]),
    ).toEqual(["set-option", "-g", "status", "on", ";", "bind-key", "-n", "C-q", "detach-client"])
  })

  test("skips empty commands", () => {
    expect(tmuxCommandSequence([[], ["display-message", "ready"], []])).toEqual(["display-message", "ready"])
  })
})
