import { expect } from "vitest"

/**
 * Poke-until-observed — the fix for the whole fs-watcher test flake class.
 *
 * A watcher test that writes ONCE and then waits is really asserting two
 * things: that the watcher reacts, AND that it happened to be ready at the
 * instant of that single write. The second one is a race — chokidar's
 * initial scan, debounce coalescing, and fs-event delivery all stretch
 * under parallel-suite load, which is why these tests passed standalone
 * and flaked in full runs (issue #3).
 *
 * Repeating the write removes the timing dependency entirely: keep poking
 * until the condition holds. Assertions must therefore be MONOTONIC
 * (`>= n`, "grew since"), never exact counts — the poke may legitimately
 * land more than once.
 */
export async function pokeUntil(
  cond: () => boolean,
  poke: () => void,
  opts: { timeoutMs?: number; pokeEveryMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const pokeEveryMs = opts.pokeEveryMs ?? 150
  const deadline = Date.now() + timeoutMs
  let lastPoke = 0
  while (!cond() && Date.now() < deadline) {
    if (Date.now() - lastPoke >= pokeEveryMs) {
      lastPoke = Date.now()
      poke()
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(cond()).toBe(true)
}

/**
 * Plain poll — for assertions a repeated poke would corrupt (e.g. "a burst
 * coalesces into exactly ONE trigger"). Use `pokeUntil` to prove the
 * watcher is live FIRST, then this to observe the counted behavior.
 */
export async function waitUntil(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(cond()).toBe(true)
}
