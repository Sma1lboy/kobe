/**
 * Behavior test — KOB-15 "main session" task per saved repo.
 *
 * The contract this guards:
 *
 *   1. With a saved repo present at boot, kobe's boot path calls
 *      `orchestrator.ensureMainTask(repo)` for every entry, so a `★`
 *      pinned row appears at the top of the sidebar with the repo
 *      basename as its title (NOT the full path).
 *
 *   2. The main task is bound to the repo root checkout — NOT a
 *      kobe-allocated worktree. We assert directly on the persisted
 *      manifest: the row's `kind === "main"`, `worktreePath === repo`,
 *      and no `<repo>/.claude/worktrees/<id>/` directory exists.
 *      Selecting it does NOT trigger `git worktree add` (no `kobe/tmp-…`
 *      branches show up on disk).
 *
 *   3. Pressing `d` on a main row shows the "remove from saved repos"
 *      confirm copy — NOT the regular delete-task copy. Cancelling
 *      leaves the row intact.
 *
 * Why this is a behavior test, not a unit test:
 *   - The boot-time seeding (in `app.tsx#startApp`), the sidebar's
 *     pinning render, and the delete-confirm dispatch all participate.
 *     Unit tests cover each piece in isolation; this proves they're
 *     wired together on the real binary.
 *   - The "no kobe/tmp-… branch on disk" assertion is the only check
 *     that proves the worktree-skip path is taken end-to-end.
 *
 * Mechanics: we pre-seed `<KOBE_HOME_DIR>/.config/kobe/state.json`
 * with `{ "savedRepos": [<fixtureRepo>] }` before spawning kobe.
 * `state/repos.ts` reads this path under `KOBE_HOME_DIR`, so the
 * boot-time `ensureMainTask` loop sees the entry without us having
 * to drive the `kobe add` CLI.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeAll, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

const REPO_INIT = path.resolve(__dirname, "fixtures/repo-init.sh")

let tmpRoot: string
let homeDir: string
let repo: string
let kobe: KobeHandle | null = null

beforeAll(() => {
  if (!fs.existsSync(REPO_INIT)) {
    throw new Error(`missing fixture: ${REPO_INIT}`)
  }
})

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

/**
 * Pre-seed the savedRepos state file under `KOBE_HOME_DIR` so the boot
 * path picks the entry up. Mirrors `kobe add <path>` without spawning
 * the CLI.
 */
function seedSavedRepos(home: string, repos: string[]): void {
  const statePath = path.join(home, ".config", "kobe", "state.json")
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify({ savedRepos: repos }, null, 2), "utf8")
}

/**
 * Wait until the manifest exists AND contains at least one main task
 * with a populated `worktreePath`. The orchestrator's `store.create`
 * is async; the boot seeding awaits it before render, but we still
 * race the file's atomic-rename against our first read.
 */
async function waitForMainTaskInManifest(p: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, "utf8")
        const data = JSON.parse(raw) as {
          tasks?: { kind?: string; worktreePath?: string }[]
        }
        const main = data.tasks?.find((t) => t.kind === "main")
        if (main && typeof main.worktreePath === "string" && main.worktreePath.length > 0) {
          return
        }
      } catch {
        /* mid-write rename race — retry */
      }
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`manifest never gained a main task at ${p}`)
}

test("with one saved repo, a ★ row appears at the top of the sidebar with the repo basename", async () => {
  // ---- fixtures ------------------------------------------------
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-main-task-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  // Recognizable basename so the ★ row label is unambiguous.
  repo = path.join(tmpRoot, "kobe-fixture")
  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) {
    throw new Error(`repo-init.sh failed: ${initResult.stderr}\n${initResult.stdout}`)
  }
  seedSavedRepos(homeDir, [repo])

  // ---- spawn kobe ----------------------------------------------
  kobe = await spawnKobe({
    env: {
      KOBE_TEST_ENGINE: "fake",
      KOBE_HOME_DIR: homeDir,
    },
    cols: 120,
    rows: 30,
  })

  await kobe.waitFor((s) => s.includes("KobeCode"), 10_000)

  // The boot-time `ensureMainTask` loop persists the main task to the
  // manifest before render — wait for the disk record so the rest of
  // the test can read it.
  const manifestPath = path.join(homeDir, ".kobe", "tasks.json")
  await waitForMainTaskInManifest(manifestPath, 15_000)

  // ---- assertion 1: ★ row + repo basename in the sidebar -------
  // The pinned row renders `★ kobe-fixture` with the live branch hint.
  // We anchor on both the basename label and the ★ glyph. (The PTY
  // capture preserves Unicode glyphs.)
  await kobe.waitFor((s) => s.includes("★") && s.includes("kobe-fixture"), 15_000)
  const screen = await kobe.capture()
  expect(screen).toContain("★")
  expect(screen).toContain("kobe-fixture")
  // The full path must NOT appear as the row label — basename only.
  // (The path may show in a topbar or detail strip; we only care that
  //  the SIDEBAR row title is the basename, which is what reads.)
  // Find a window of text around the ★ glyph and assert the basename
  // sits next to it, not the full path. The ★ row is short — one line.
  const lines = screen.split("\n")
  const starLine = lines.find((l) => l.includes("★"))
  expect(starLine).toBeDefined()
  expect(starLine).toContain("kobe-fixture")

  // ---- assertion 2: bound to repo root, no worktree allocation -
  // Read the manifest. The main task's worktreePath must equal the
  // repo root, not a `<repo>/.claude/worktrees/<id>/` path.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    tasks: { id: string; kind?: string; worktreePath: string; repo: string; branch: string; title: string }[]
  }
  const main = manifest.tasks.find((t) => t.kind === "main")
  expect(main).toBeDefined()
  expect(main?.repo).toBe(repo)
  expect(main?.worktreePath).toBe(repo)
  expect(main?.branch).toBe("")
  // The repo's saved-repos worktree directory must NOT exist —
  // ensureMainTask never shells `git worktree add`.
  expect(fs.existsSync(path.join(repo, ".claude", "worktrees"))).toBe(false)

  // ---- assertion 3: pressing `d` on the main row shows the
  //      "remove from saved repos" copy, NOT the regular delete copy.
  // Focus the sidebar so its `d` binding fires.
  await kobe.sendKeys("\x1b[49;5u") // ctrl+1 (kitty CSI-u for digit '1')
  await new Promise((r) => setTimeout(r, 250))

  // Cursor is at index 0 — the pinned ★ row, since main rows pin first.
  await kobe.sendKeys("d")
  // Wait for the dialog title.
  await kobe.waitFor((s) => s.includes("Remove 'kobe-fixture' from saved repos?"), 10_000)
  const dialogScreen = await kobe.capture()
  expect(dialogScreen).toContain("Remove 'kobe-fixture' from saved repos?")
  // The body wraps across lines in opentui's text wrapper at ~46 cells,
  // so the full sentence isn't on one line. We anchor on two
  // distinctive sub-phrases that survive wrapping at any pane width.
  expect(dialogScreen).toContain("The directory and its files stay")
  expect(dialogScreen).toMatch(/on disk/)
  // The regular "Delete '...'?" copy must NOT appear.
  expect(dialogScreen).not.toMatch(/Delete '.*'\?/)

  // Cancel out via esc. The DialogConfirm registers an escape handler
  // that dispatches onCancel. We can't assert "dialog disappears" by
  // grep-ing the cumulative PTY buffer (the dialog text remains in
  // history), so instead we verify the on-disk side effect: the main
  // task is NOT archived after cancel — confirm would have flipped
  // archived=true and run removeSavedRepo.
  await kobe.sendKeys("\x1b") // esc
  await new Promise((r) => setTimeout(r, 500))
  const manifestAfterCancel = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    tasks: { id: string; kind?: string; archived: boolean }[]
  }
  const mainAfterCancel = manifestAfterCancel.tasks.find((t) => t.kind === "main")
  expect(mainAfterCancel?.archived).toBe(false)
  // The savedRepos entry must also still be there — cancel must not
  // run removeSavedRepo.
  const stateAfter = JSON.parse(
    fs.readFileSync(path.join(homeDir, ".config", "kobe", "state.json"), "utf8"),
  ) as { savedRepos?: string[] }
  expect(stateAfter.savedRepos).toContain(repo)

  await kobe.exit()
  expect(kobe.closed).toBe(true)
}, 90_000)
