/**
 * Scripted PTY test double — a `PtyRegistry` whose factory spawns NOTHING:
 * every acquire hands back a `MockTaskPty` the test drives by hand. This is
 * the cheap track for the pane's error/exit paths, which the real backends
 * only reach through slow subprocess plumbing.
 *
 * Scripting surface (all synchronous, test-timed — "delay" is just calling
 * these later):
 *
 *   - emit output:      `harness.last().feed("hello\r\n")`
 *   - engine exit:      `harness.last().kill()` (fires `onExit`, same as a
 *                       self-exited child — the contract has no exit code)
 *   - corpse attach:    `harness.last().deadOnAttach = true` before kill()
 *   - acquire failure:  `harness.failNextAcquire("spawn EACCES")` — the next
 *                       factory call (plain `acquire` or the acquire half of
 *                       `reset`) throws. Queue several to fail several.
 *
 * Lives beside `pty-mock.ts` rather than in it because this file needs the
 * `PtyRegistry` class value and `registry.ts → pty.ts → pty-mock.ts` already
 * forms an import chain — importing registry from pty-mock would close a
 * module cycle.
 */

import { MockTaskPty } from "./pty-mock"
import { PtyRegistry } from "./registry"

export interface ScriptedPtyRegistry {
  /** Inject as the pane's `registry` prop (or use directly in unit tests). */
  registry: PtyRegistry
  /** Every PTY the factory created, in creation order. Never pruned. */
  ptys: MockTaskPty[]
  /** The most recently created PTY. Throws if nothing was acquired yet. */
  last(): MockTaskPty
  /** Queue an error for the next factory call; FIFO across repeated calls. */
  failNextAcquire(message: string): void
}

export function createScriptedPtyRegistry(): ScriptedPtyRegistry {
  const ptys: MockTaskPty[] = []
  const failures: string[] = []
  const registry = new PtyRegistry((opts) => {
    const failure = failures.shift()
    if (failure !== undefined) throw new Error(failure)
    const pty = new MockTaskPty(opts)
    ptys.push(pty)
    return pty
  })
  return {
    registry,
    ptys,
    last(): MockTaskPty {
      const pty = ptys[ptys.length - 1]
      if (!pty) throw new Error("scripted pty registry: nothing acquired yet")
      return pty
    },
    failNextAcquire(message: string): void {
      failures.push(message)
    },
  }
}
