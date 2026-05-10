/**
 * Behavior test — new-task dialog validates the repo path before
 * committing.
 *
 * The contract this guards:
 *   - When the user types a repo path that exists but is not a git
 *     repository and presses enter, the dialog refuses to submit and
 *     surfaces a plain-English `※ not a git repository: <path>` row.
 *   - The dialog stays open (no task is created in the sidebar) so
 *     the user can correct the typo and try again.
 *
 * Why this matters:
 *   - Without the validator, a typo'd path would persist as
 *     `lastNewTaskRepo` and the orchestrator's `git worktree add`
 *     would fail dozens of times in a row, surfacing as a dense
 *     `runTask failed: <git noise>` banner in chat. The dialog catches
 *     it once, up front, with a message a user can act on.
 *
 * Why a behavior test (not just unit): `validateRepoPath` itself has
 * unit coverage. This test asserts the *user flow* — the rejection
 * lands in the dialog, the dialog stays open, the sidebar doesn't
 * grow a phantom task. Regressions in the wiring (e.g. the dialog
 * silently commits anyway, or the validator runs but its message is
 * thrown away) would slip past unit tests.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

let tmpRoot: string
let kobe: KobeHandle | null = null

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
})

test("new-task dialog rejects a non-git directory with a friendly message", async () => {
  // ---- fixtures ------------------------------------------------
  // A real, existing directory that is NOT a git repo. The validator
  // makes two checks (exists + is-a-git-repo); we want to fail the
  // second, not the first, so the path must really exist.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-not-git-"))
  const homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  const notARepo = path.join(tmpRoot, "not-a-repo")
  fs.mkdirSync(notARepo, { recursive: true })

  // ---- spawn kobe ----------------------------------------------
  // Use the fake engine so the dialog flow doesn't try to spawn a
  // real `claude` binary if the validator regresses and lets a
  // submit through. KOBE_HOME_DIR isolates the manifest so this
  // test doesn't touch the user's real ~/.kobe.
  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_TEST_FAKE_PORT: "0",
      KOBE_HOME_DIR: homeDir,
    },
    cols: 120,
    rows: 30,
  })
  await kobe.waitFor((s) => s.includes("kobe"), 10_000)

  // ---- open new-task dialog -----------------------------------
  await kobe.sendKeys("n")
  await kobe.waitFor((s) => s.includes("New task"), 5_000)
  await new Promise((r) => setTimeout(r, 250))

  // The repo field is focused on open and is pre-filled with the
  // launch cwd. Wipe it before typing the bad path. 200 backspaces
  // is well above the longest realistic launch cwd we'd see in
  // CI / dev, and is a no-op once the field is empty.
  for (let i = 0; i < 200; i++) {
    await kobe.sendKeys("\x7f")
  }
  await kobe.typeText(notARepo)

  // Submit. Validator should refuse and show the inline message.
  await kobe.sendKeys("\r")

  // ---- assertions ---------------------------------------------
  // The friendly error appears inline, prefixed with `※`. We assert
  // on a substring of the validator's message so a small wording
  // tweak doesn't break the test.
  const screen = await kobe.waitFor((s) => s.includes("not a git repository"), 5_000)
  expect(screen).toContain("not a git repository")
  // Dialog is still open — the "New task" header is still on screen
  // and the repo field still shows our bad path.
  expect(screen).toContain("New task")
  expect(screen).toContain(notARepo)

  // Manifest should be empty: the validator blocked submit, so no
  // task should have been created. (The orchestrator persists tasks
  // via the manifest at $KOBE_HOME_DIR/.kobe/tasks.json.)
  const manifestPath = path.join(homeDir, ".kobe", "tasks.json")
  if (fs.existsSync(manifestPath)) {
    const raw = fs.readFileSync(manifestPath, "utf8")
    const parsed = JSON.parse(raw) as { tasks?: unknown[] }
    expect(parsed.tasks ?? []).toHaveLength(0)
  }

  await kobe.exit()
  expect(kobe.closed).toBe(true)
}, 60_000)
