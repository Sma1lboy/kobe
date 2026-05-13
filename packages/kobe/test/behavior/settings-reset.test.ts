/**
 * Behavior test for the Settings → Dev → Reset flow.
 *
 * Proves end-to-end that:
 *
 *   1. After a normal kobe boot, `~/.config/kobe/state.json` is
 *      populated by the persistence effects in `app.tsx` (theme, pane
 *      sizes, etc. — runs once per createEffect on creation).
 *   2. Settings → Dev → Reset → Confirm wipes BOTH the KV file
 *      (`state.json`) AND the task index (`tasks.json`), then exits
 *      kobe (the relaunch model — see KOB-12). Without exit, the
 *      live in-memory Solid signals would silently repopulate KV the
 *      next time any tracked dependency changes.
 *   3. The on-disk state.json after reset is `{}` (no leaked keys
 *      from a stray `kv.set` racing the cleared store).
 *   4. The on-disk tasks.json after reset is gone (Working session /
 *      Archive lists empty on next launch). Per Jackson's scope:
 *      kobe-owned data clears, worktree directories on disk are NOT
 *      touched.
 *
 * Why "exit then check the file" rather than "check the file in
 * place": `kv.clear()` flushes synchronously, but the persistence
 * effects can still re-fire from any unrelated signal change after
 * the clear. The relaunch contract is the actual product behavior,
 * so the test asserts on the contract: kobe must exit, and both
 * files must be cleared *after* exit.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

let kobe: KobeHandle | null = null
let tmpRoot: string | null = null

afterEach(async () => {
  if (kobe && !kobe.closed) {
    await kobe.exit()
  }
  kobe = null
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  tmpRoot = null
})

test("settings → Dev → Reset wipes state.json and exits kobe", async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-reset-"))
  const homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  const statePath = path.join(homeDir, ".config", "kobe", "state.json")
  const tasksPath = path.join(homeDir, ".kobe", "tasks.json")

  // Pre-seed a tasks.json so the test proves the reset actually
  // deletes the file (rather than the file just never existing in
  // a hermetic boot). Shape mirrors a v2 manifest with one task —
  // the contents don't matter, the test only asserts on the file's
  // post-reset existence.
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true })
  fs.writeFileSync(
    tasksPath,
    `${JSON.stringify(
      {
        version: 2,
        tasks: [
          {
            id: "01TESTRESETSEEDTASKID00",
            title: "seed task for reset test",
            repo: "/tmp/seed-repo",
            worktreePath: "/tmp/seed-worktree",
            status: "backlog",
            archived: false,
            sessionId: null,
            tabs: [{ id: "seedtab", sessionId: null, createdAt: "2026-05-10T00:00:00.000Z" }],
            activeTabId: "seedtab",
            createdAt: "2026-05-10T00:00:00.000Z",
            updatedAt: "2026-05-10T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  kobe = await spawnKobe({
    env: {
      HOME: homeDir,
      KOBE_HOME_DIR: homeDir,
    },
    cols: 120,
    rows: 30,
  })

  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)

  // Sanity: the persistence effects in app.tsx run once per createEffect
  // on mount, so state.json should be populated before we even open
  // settings. Poll for it to settle before the reset so we know the
  // reset actually had something to clear (not just "file never
  // existed in the first place").
  let preReset: Record<string, unknown> | null = null
  const preDeadline = Date.now() + 3_000
  while (Date.now() < preDeadline) {
    if (fs.existsSync(statePath)) {
      try {
        preReset = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>
        if (preReset && Object.keys(preReset).length > 0) break
      } catch {
        /* mid-write race — keep polling */
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  expect(preReset, "state.json should be populated before reset").not.toBeNull()
  expect(Object.keys(preReset ?? {}).length, "state.json should have at least one key before reset").toBeGreaterThan(0)

  // Open the Settings dialog. Same xterm modifyOtherKeys escape that
  // settings-theme-switch.test.ts uses to inject ctrl+, (charCode=44,
  // mod=5 = ctrl-only).
  await kobe.sendKeys("\x1b[27;5;44~")
  await kobe.waitFor((s) => {
    const flat = s.replace(/\s+/g, "")
    return flat.includes("Settings") && flat.includes("Theme")
  }, 5_000)

  // Move sidebar cursor from General → Accounts → Codex → Dev, then
  // drill into body (cursor on the Reset row).
  await kobe.sendKeys("\x1b[B\x1b[B\x1b[B") // arrow down → Dev section in sidebar
  await kobe.waitFor((s) => s.replace(/\s+/g, "").includes("ResetUIstate"), 5_000)
  await kobe.sendKeys("\r") // enter → drill into Dev body
  await kobe.sendKeys("\r") // enter → trigger confirmReset → DialogConfirm appears

  // Confirm dialog renders with title "Reset UI state?" and the
  // default-focused button is "Confirm" (DialogConfirm's store
  // initializes `active: "confirm"`). Pressing enter commits the
  // confirmation.
  await kobe.waitFor((s) => s.replace(/\s+/g, "").includes("ResetUIstate?"), 5_000)
  await kobe.sendKeys("\r") // enter → onConfirm → kv.clear() + renderer.destroy() + exit(0)

  // Wait for the spawned kobe to actually exit. Without the exit
  // step the bug regresses: state.json refills on the next tracked
  // signal change.
  const exitDeadline = Date.now() + 5_000
  while (!kobe.closed && Date.now() < exitDeadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  expect(kobe.closed, "kobe must exit after Reset confirmation").toBe(true)
  expect(kobe.exitCode, "kobe must exit cleanly (code 0) after Reset").toBe(0)

  // After exit, state.json must be a JSON object with NO keys.
  // (kv.clear() writes an empty object synchronously before the
  // process tears down.) We accept either an empty object or a
  // missing file — both are valid "clean slate" outcomes — but
  // assert no real keys remain.
  let postReset: Record<string, unknown> = {}
  if (fs.existsSync(statePath)) {
    postReset = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>
  }
  expect(Object.keys(postReset), "state.json should be empty after Reset").toEqual([])

  // tasks.json must be gone too. The reset deletes it via unlinkSync
  // (TaskIndexStore.load handles ENOENT cleanly, so the next kobe
  // launch starts with an empty index). We pre-seeded the file
  // above, so the assertion proves the reset removed something it
  // had to actively delete — not just "happens to not exist".
  expect(fs.existsSync(tasksPath), "tasks.json should be deleted after Reset").toBe(false)
}, 60_000)
