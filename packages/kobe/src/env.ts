/**
 * Centralised environment / runtime flag access.
 *
 * Convention: any new `KOBE_*` env var that the production code path
 * reads goes through here. Test-only env vars (`KOBE_TEST_ENGINE`,
 * `KOBE_TEST_FAKE_PORT`, the per-pane `KOBE_*_HOST` fixtures, etc.)
 * stay where they are — they're internal plumbing for the harness,
 * not part of kobe's user-facing surface.
 *
 * The win of routing reads through here:
 *
 *   1. One place to learn which knobs the binary respects.
 *   2. Typed, validated accessors (no `process.env.KOBE_X === "1"`
 *      stringly-typed checks scattered through the codebase).
 *   3. Easy to mock in unit tests — just stub the function.
 *   4. Documents the *intent* of each variable in the comment, not
 *      buried at its first use site.
 *
 * This is *not* a generic config layer. We don't load `.env` files,
 * don't cascade through `~/.kobe/config.json`, don't do any of that.
 * If we ever need that, build a `loadConfig()` that returns a frozen
 * record once at startup and have these accessors read from it.
 */

import { homedir } from "node:os"
import { join } from "node:path"

/**
 * `KOBE_DEV=1` — declares the binary is running from a developer
 * checkout rather than an installed package. Suppresses the npm
 * version-check chip so contributors don't see "↑ vX.Y.Z available"
 * every time they `bun run dev` against an older `package.json` than
 * what's published. Intentionally opt-in: the production CLI path
 * never sets it, so `npm i -g @sma1lboy/kobe` users always get the
 * notification.
 */
export function isDev(): boolean {
  return process.env.KOBE_DEV === "1"
}

/**
 * `KOBE_HOME_DIR` — overrides `os.homedir()` for everything kobe
 * persists (state file, version-check cache, task index). Tests
 * point this at a temp dir so they don't trample the real `~/.kobe/`.
 */
export function homeDir(): string {
  return process.env.KOBE_HOME_DIR ?? homedir()
}

/**
 * Root directory for kobe's persistent state — `~/.kobe/` by default
 * (or `$KOBE_HOME_DIR/.kobe/` when overridden). Callers join their
 * own filename onto this; we don't `mkdir` here, that's the writer's
 * job at the actual write site.
 */
export function kobeStateDir(): string {
  return join(homeDir(), ".kobe")
}

/**
 * Path to the small flat-JSON KV blob shared between the TUI's
 * `KVProvider` (src/tui/context/kv.tsx) and CLI-side modules like
 * `src/state/repos.ts`. Both must agree on this path or the picker
 * stops seeing what `kobe add` wrote. Defaults to
 * `~/.config/kobe/state.json`; honours `KOBE_HOME_DIR` so tests can
 * isolate via tmpdir.
 *
 * The TUI's `kv.tsx` predates this helper and still hardcodes the
 * same expression — keep them in sync if either moves.
 */
export function kvStatePath(): string {
  return join(homeDir(), ".config", "kobe", "state.json")
}

/**
 * `KOBE_TMUX_BIN` — path to the tmux binary the embedded terminal
 * pane should spawn. Defaults to `tmux` (resolved against PATH).
 * Mostly for hosts where tmux is installed under a non-standard
 * prefix, or for tests that point at a stub tmux.
 */
export function tmuxBin(): string {
  return process.env.KOBE_TMUX_BIN ?? "tmux"
}
