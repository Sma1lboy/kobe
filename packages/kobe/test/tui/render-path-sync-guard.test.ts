import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const TUI_ROOT = fileURLToPath(new URL("../../src/tui", import.meta.url))

const WHITELIST: Record<string, string> = {
  "update/host.tsx": "self-update runs after renderer.destroy(); intentional stdio-inherit block",
  "lib/git-snapshot.ts": "one-shot O(refs) git on explicit dialog actions; header documents the rationale",
  "panes/sidebar/worktree-changes.ts": "sync helper for one-shot CLI use only; header documents the ban",
}

const SYNC_NAMES = ["spawnSync", "execSync", "execFileSync"] as const

const CALL_RE = new RegExp(`\\b(?:${SYNC_NAMES.join("|")})\\s*\\(`)
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
      const source = readFileSync(join(TUI_ROOT, rel), "utf8")
      expect(usesSyncSubprocess(source), `${rel} no longer uses sync subprocesses — drop it from the whitelist`).toBe(
        true,
      )
    }
  })
})
