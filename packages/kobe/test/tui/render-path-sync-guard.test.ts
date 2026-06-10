/**
 * CI guard: render processes must not run synchronous subprocesses.
 *
 * Why this matters (the 30GB-repo freeze): a `spawnSync git status` on
 * the sidebar's ~2s tick blocked the whole event loop for the duration
 * of an O(repo size) status walk — the Tasks pane hard-froze the moment
 * a huge repo's row rendered. Every `src/tui/**` file runs inside a
 * render process (the TUI itself or a tmux pane host), so a sync
 * subprocess anywhere in the tree is a freeze waiting for a big enough
 * repo. Live data belongs in `src/tui/lib/background-poll.ts`
 * (reactive read + fire-and-forget async poll); one-shot actions use
 * async spawn (`spawnCapture`) with await at the call site.
 *
 * This test scans `src/tui/**` source for `spawnSync` / `execSync` /
 * `execFileSync` imports-or-calls and fails unless the file is in the
 * whitelist below. Add to the whitelist only with a reason — and prefer
 * not adding at all.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const TUI_ROOT = fileURLToPath(new URL("../../src/tui", import.meta.url))

/**
 * Files (relative to src/tui) allowed to reference sync subprocess APIs,
 * each with a one-line reason. Everything else must stay async.
 */
const WHITELIST: Record<string, string> = {
  // Updater runs AFTER renderer.destroy() — intentional stdio-inherit block, no UI left to freeze.
  "update/host.tsx": "self-update runs after renderer.destroy(); intentional stdio-inherit block",
  // One-shot O(refs) git (rev-parse / for-each-ref) on explicit dialog actions — never on a render tick; header documents the rationale.
  "lib/git-snapshot.ts": "one-shot O(refs) git on explicit dialog actions; header documents the rationale",
  // Sync helper kept ONLY for one-shot CLI use (`kobe api`); its header documents the render-path ban.
  "panes/sidebar/worktree-changes.ts": "sync helper for one-shot CLI use only; header documents the ban",
}

const SYNC_NAMES = ["spawnSync", "execSync", "execFileSync"] as const

/** A call: `spawnSync(`, `execSync(`, `execFileSync(`. */
const CALL_RE = new RegExp(`\\b(?:${SYNC_NAMES.join("|")})\\s*\\(`)
/** An import/require line that binds one of the sync names from child_process. */
const IMPORT_RE = new RegExp(
  `\\b(?:${SYNC_NAMES.join("|")})\\b[^\\n]*?from\\s*["'](?:node:)?child_process["']|require\\(\\s*["'](?:node:)?child_process["']\\s*\\)`,
)

function listSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listSources(full, acc)
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full)
  }
  return acc
}

function usesSyncSubprocess(source: string): boolean {
  // Check imports line-by-line so a prose mention in a comment block
  // (e.g. "not `spawnSync`") doesn't false-positive, while a real
  // `import { spawnSync } from "node:child_process"` always trips.
  for (const line of source.split("\n")) {
    if (IMPORT_RE.test(line)) return true
    if (CALL_RE.test(line)) return true
  }
  return false
}

describe("render-path sync-subprocess guard", () => {
  const sources = listSources(TUI_ROOT)

  test("scans a plausible tree (sanity)", () => {
    expect(sources.length).toBeGreaterThan(50)
  })

  test("src/tui/** never runs synchronous subprocesses outside the whitelist", () => {
    const offenders: string[] = []
    for (const file of sources) {
      const rel = file.slice(TUI_ROOT.length + 1)
      if (!usesSyncSubprocess(readFileSync(file, "utf8"))) continue
      if (WHITELIST[rel]) continue
      offenders.push(rel)
    }
    expect(
      offenders,
      `render processes must not run synchronous subprocesses — use lib/background-poll or async spawn; see the whitelist in this test (test/tui/render-path-sync-guard.test.ts).\nOffenders: ${offenders.join(", ")}`,
    ).toEqual([])
  })

  test("whitelist entries still exist and still use sync subprocesses (no stale entries)", () => {
    for (const rel of Object.keys(WHITELIST)) {
      const source = readFileSync(join(TUI_ROOT, rel), "utf8") // throws if the file vanished
      expect(usesSyncSubprocess(source), `${rel} no longer uses sync subprocesses — drop it from the whitelist`).toBe(
        true,
      )
    }
  })
})
