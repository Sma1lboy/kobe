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

import { createHash } from "node:crypto"
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
 * `KOBE_TUI=1` — experimental native opentui workspace. Instead of entering
 * the tmux handover, `kobe` boots a single-process Sidebar / center / Files
 * app. The center column is the embedded-terminal tab seam (issue #16):
 * an in-process PTY running the real engine CLI replaces the removed
 * native chat pane. See `src/tui/workspace/host.tsx`.
 */
export function nativeChatEnabled(): boolean {
  return process.env.KOBE_TUI === "1"
}

/**
 * `KOBE_HOME_DIR` — overrides `os.homedir()` for everything kobe
 * persists (state file, task index). Tests point this at a temp dir
 * so they don't trample the real `~/.kobe/`.
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
 * `src/state/repos.ts`. Defaults to `~/.config/kobe/state.json`;
 * honours `KOBE_HOME_DIR` so tests can isolate via tmpdir.
 *
 * All reads/writes of this file go through `src/state/store.ts` (the
 * single owner of state.json I/O — read-merge-write, atomic rename);
 * this accessor is the one place the path is spelled.
 */
export function kvStatePath(): string {
  return join(homeDir(), ".config", "kobe", "state.json")
}

/**
 * Directory for user-editable kobe settings files — `~/.kobe/settings/`.
 * Unlike the KV blob (`kvStatePath()`, machine-written JSON), files in
 * here are hand-authored YAML the user owns (keybindings today; future
 * settings files land alongside). Not created eagerly — readers treat a
 * missing dir as "no overrides", writers mkdir at the write site.
 */
export function kobeSettingsDir(): string {
  return join(kobeStateDir(), "settings")
}

/**
 * User keybinding overrides — `~/.kobe/settings/keybindings.yaml`.
 * Loaded once per process at TUI boot (see
 * `src/tui/context/keybindings-user.ts`) and applied onto `KobeKeymap`.
 * `.yml` is accepted as a fallback spelling when the `.yaml` file is
 * absent.
 */
export function keybindingsConfigPath(): string {
  return join(kobeSettingsDir(), "keybindings.yaml")
}

/**
 * Directory for issue-attachment uploads served by the web bridge —
 * `<home>/.kobe/issue-assets/`. Scoped per-repo (by a hex hash of the repo
 * root) one level down so an upload can happen before the issue exists. Not
 * created eagerly — the upload route mkdir's at the write site, readers treat
 * a missing dir as "no asset". Honours `KOBE_HOME_DIR` like every other state
 * path via {@link kobeStateDir}.
 */
export function issueAssetsDir(): string {
  return join(kobeStateDir(), "issue-assets")
}

/**
 * Directory for prompt attachments pasted into composers (clipboard
 * screenshots saved to disk so their path can travel in a prompt) —
 * `<home>/.kobe/attachments/`. Created lazily at the write site; files
 * are small PNGs named by timestamp+nonce so they never collide. Honours
 * `KOBE_HOME_DIR` via {@link kobeStateDir}.
 */
export function promptAttachmentsDir(): string {
  return join(kobeStateDir(), "attachments")
}

/**
 * SSH ControlMaster socket for a remote project — one multiplexed connection
 * per host/user/port, reused by every `ssh` kobe runs against that remote (see
 * `exec/exec-host.ts`). Lives under `<home>/.kobe/ssh/` like the daemon socket
 * so `kobe reset` cleans it. Keyed by a short hash so a long `user@host:port`
 * never blows past the ~104-char unix-socket path limit.
 */
export function remoteControlSocketPath(host: string, user: string, port?: number): string {
  const hash = createHash("sha1")
    .update(`${user}@${host}:${port ?? 22}`)
    .digest("hex")
    .slice(0, 16)
  return join(kobeStateDir(), "ssh", `${hash}.sock`)
}

/**
 * Per-worktree marker proving the repo's init script already ran for that
 * worktree (once-per-worktree semantics). Kept under `<home>/.kobe/` —
 * NOT inside the worktree — so it never shows up as an uncommitted change.
 * Keyed by a short hash of the worktree path; a deleted+recreated worktree
 * at the same path reuses the marker, which is the intended "don't re-run"
 * behaviour.
 */
export function worktreeInitMarkerPath(worktreePath: string): string {
  const hash = createHash("sha1").update(worktreePath).digest("hex").slice(0, 16)
  return join(kobeStateDir(), "worktree-init", hash)
}
