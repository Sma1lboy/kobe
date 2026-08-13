/**
 * Centralised environment / runtime flag access.
 *
 * Convention: renamed controls accept `ROVE_*` first and fall back to their
 * `KOBE_*` aliases. Any new production read goes through here. Test-only env vars (`KOBE_TEST_ENGINE`,
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
 * don't cascade through `~/.rove/config.json`, don't do any of that.
 * If we ever need that, build a `loadConfig()` that returns a frozen
 * record once at startup and have these accessors read from it.
 */

import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { readRoveEnv } from "@sma1lboy/kobe-daemon/compat-env"
import {
  LEGACY_KOBE_CONFIG_DIR_BASENAME,
  LEGACY_KOBE_STATE_DIR_BASENAME,
  ROVE_CONFIG_DIR_BASENAME,
  ROVE_STATE_DIR_BASENAME,
} from "./product.ts"

/**
 * `ROVE_DEV=1` (or compatible `KOBE_DEV=1`) — declares the binary is running from a developer
 * checkout rather than an installed package. Suppresses the npm
 * version-check chip so contributors don't see "↑ vX.Y.Z available"
 * every time they `bun run dev` against an older `package.json` than
 * what's published. Intentionally opt-in: the production CLI path
 * never sets it, so `npm i -g @sma1lboy/kobe` users always get the
 * notification.
 */
export function isDev(): boolean {
  return readRoveEnv("DEV") === "1"
}

/**
 * `ROVE_HOME_DIR` (or compatible `KOBE_HOME_DIR`) — overrides `os.homedir()` for everything Rove
 * persists (state file, task index). Tests point this at a temp dir
 * so they don't trample the real `~/.rove/`.
 */
export function homeDir(): string {
  return readRoveEnv("HOME_DIR") ?? homedir()
}

/**
 * Root directory for Rove's persistent product data — `~/.rove/` by default
 * (or `$ROVE_HOME_DIR/.rove/` / `$KOBE_HOME_DIR/.rove/` when overridden). Callers join their
 * own filename onto this; we don't `mkdir` here, that's the writer's
 * job at the actual write site.
 */
export function roveStateDir(): string {
  return join(homeDir(), ROVE_STATE_DIR_BASENAME)
}

/** @deprecated Internal compatibility alias; use {@link roveStateDir}. */
export const kobeStateDir = roveStateDir

/** Read-only compatibility root for data created before the Rove migration. */
export function legacyKobeStateDir(): string {
  return join(homeDir(), LEGACY_KOBE_STATE_DIR_BASENAME)
}

/**
 * Path to the small flat-JSON KV blob shared between the TUI's
 * `KVProvider` (src/tui/context/kv.tsx) and CLI-side modules like
 * `src/state/repos.ts`. Defaults to `~/.config/rove/state.json`;
 * honours `KOBE_HOME_DIR` so tests can isolate via tmpdir.
 *
 * All reads/writes of this file go through `src/state/store.ts` (the
 * single owner of state.json I/O — read-merge-write, atomic rename);
 * this accessor is the one place the path is spelled.
 */
export function kvStatePath(): string {
  return join(homeDir(), ".config", ROVE_CONFIG_DIR_BASENAME, "state.json")
}

/** Read-only compatibility path copied on first launch after upgrade. */
export function legacyKobeKvStatePath(): string {
  return join(homeDir(), ".config", LEGACY_KOBE_CONFIG_DIR_BASENAME, "state.json")
}

/**
 * Directory for user-editable Rove settings files — `~/.rove/settings/`.
 * Unlike the KV blob (`kvStatePath()`, machine-written JSON), files in
 * here are hand-authored YAML the user owns (keybindings today; future
 * settings files land alongside). Not created eagerly — readers treat a
 * missing dir as "no overrides", writers mkdir at the write site.
 */
export function roveSettingsDir(): string {
  return join(roveStateDir(), "settings")
}

/** @deprecated Internal compatibility alias; use {@link roveSettingsDir}. */
export const kobeSettingsDir = roveSettingsDir

/**
 * User keybinding overrides — `~/.rove/settings/keybindings.yaml`.
 * Loaded once per process at TUI boot (see
 * `src/tui/context/keybindings-user.ts`) and applied onto `KobeKeymap`.
 * `.yml` is accepted as a fallback spelling when the `.yaml` file is
 * absent.
 */
export function keybindingsConfigPath(): string {
  return join(roveSettingsDir(), "keybindings.yaml")
}

/**
 * Directory for issue-attachment uploads served by the web bridge —
 * `<home>/.rove/issue-assets/`. Scoped per-repo (by a hex hash of the repo
 * root) one level down so an upload can happen before the issue exists. Not
 * created eagerly — the upload route mkdir's at the write site, readers treat
 * a missing dir as "no asset". Honours `KOBE_HOME_DIR` like every other state
 * path via {@link roveStateDir}.
 */
export function issueAssetsDir(): string {
  return join(roveStateDir(), "issue-assets")
}

/**
 * Directory for prompt attachments pasted into composers (clipboard
 * screenshots saved to disk so their path can travel in a prompt) —
 * `<home>/.rove/attachments/`. Created lazily at the write site; files
 * are small PNGs named by timestamp+nonce so they never collide. Honours
 * `KOBE_HOME_DIR` via {@link roveStateDir}.
 */
export function promptAttachmentsDir(): string {
  return join(roveStateDir(), "attachments")
}

/**
 * SSH ControlMaster socket for a remote project — one multiplexed connection
 * per host/user/port, reused by every `ssh` Rove runs against that remote (see
 * `exec/exec-host.ts`). Lives under `<home>/.rove/ssh/`. Keyed by a short hash so a long `user@host:port`
 * never blows past the ~104-char unix-socket path limit.
 */
export function remoteControlSocketPath(host: string, user: string, port?: number): string {
  const hash = createHash("sha1")
    .update(`${user}@${host}:${port ?? 22}`)
    .digest("hex")
    .slice(0, 16)
  return join(roveStateDir(), "ssh", `${hash}.sock`)
}

/**
 * Per-worktree marker proving the repo's init script already ran for that
 * worktree (once-per-worktree semantics). Kept under `<home>/.rove/` —
 * NOT inside the worktree — so it never shows up as an uncommitted change.
 * Keyed by a short hash of the worktree path; a deleted+recreated worktree
 * at the same path reuses the marker, which is the intended "don't re-run"
 * behaviour.
 */
export function worktreeInitMarkerPath(worktreePath: string): string {
  const hash = createHash("sha1").update(worktreePath).digest("hex").slice(0, 16)
  return join(roveStateDir(), "worktree-init", hash)
}
