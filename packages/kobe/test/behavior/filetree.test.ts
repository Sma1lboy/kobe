/**
 * Wave 3 Stream H — file tree pane behavior tests.
 *
 * Mounts the FileTree pane via the test-only host
 * (`test/behavior/fixtures/filetree-host.tsx`), drives it with
 * keystrokes, and asserts on visible state. The pane is not yet
 * integrated into `app.tsx` (the orchestrator does that at Wave 3
 * merge); the host is the bridge that lets us self-validate the pane
 * before integration. See `filetree-host.tsx` and Stream H's brief
 * for the rationale.
 *
 * The fixture (`fixtures/repo-with-changes.sh`) builds a small repo
 * with a known set of committed files and a known set of pending
 * changes:
 *
 *   committed:  README.md, src/index.ts, src/util.ts, .gitignore
 *   modified:    M src/index.ts
 *   untracked:   ? new-file.txt
 *   gitignored:  secret.log (must NOT appear)
 *
 * What we assert:
 *   1. On the All tab, expected committed + untracked files appear,
 *      and the gitignored file does not.
 *   2. Pressing `2` switches to the Changes tab and only the modified
 *      and untracked files show, prefixed with M / ?.
 *   3. Pressing `enter` on a row writes the selected path to the
 *      output file we read back to verify `onOpenFile` fired.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeAll, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

const REPO_INIT = path.resolve(__dirname, "fixtures/repo-with-changes.sh")

let kobe: KobeHandle | null = null
let tmpRoot: string | null = null

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
  tmpRoot = null
})

/** Build a fresh fixture repo + output file path under a temp root. */
function buildFixture(): { tmpRoot: string; repo: string; outputFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-filetree-"))
  const repo = path.join(root, "repo")
  const outputFile = path.join(root, "opened.log")
  const initResult = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (initResult.status !== 0) {
    throw new Error(`repo-with-changes.sh failed: ${initResult.stderr}\n${initResult.stdout}`)
  }
  return { tmpRoot: root, repo, outputFile }
}

// ---------------------------------------------------------------------
// (a) All tab — lists all gitignore-respecting files.
// ---------------------------------------------------------------------

test("filetree H — All tab lists committed + untracked files, hides gitignored", async () => {
  const fixture = buildFixture()
  tmpRoot = fixture.tmpRoot

  kobe = await spawnKobe({
    env: {
      KOBE_FILETREE_HOST: "1",
      KOBE_FILETREE_WORKTREE: fixture.repo,
      KOBE_FILETREE_OUTPUT: fixture.outputFile,
    },
    cols: 120,
    rows: 30,
  })

  // Wait for the host header to paint — proves the binary booted.
  await kobe.waitFor((s) => s.includes("kobe filetree host"), 10_000)

  // Wait for at least one file row to render. We pick `README.md`
  // because it's a committed file every run includes.
  const allScreen = await kobe.waitFor((s) => s.includes("README.md"), 10_000)

  // Files we expect on the All tab:
  expect(allScreen).toContain("README.md")
  expect(allScreen).toContain("src/index.ts")
  expect(allScreen).toContain("src/util.ts")
  expect(allScreen).toContain(".gitignore")
  expect(allScreen).toContain("new-file.txt")

  // Files / strings we expect NOT to see:
  expect(allScreen).not.toContain("secret.log")

  await kobe.exit()
}, 30_000)

// ---------------------------------------------------------------------
// (b) Changes tab — only the modified + untracked files, with prefix.
// ---------------------------------------------------------------------

test("filetree H — pressing 2 shows Changes tab with only modified files", async () => {
  const fixture = buildFixture()
  tmpRoot = fixture.tmpRoot

  kobe = await spawnKobe({
    env: {
      KOBE_FILETREE_HOST: "1",
      KOBE_FILETREE_WORKTREE: fixture.repo,
      KOBE_FILETREE_OUTPUT: fixture.outputFile,
    },
    cols: 120,
    rows: 30,
  })

  await kobe.waitFor((s) => s.includes("kobe filetree host"), 10_000)
  // Wait for All tab to populate first so we know the pane is alive.
  await kobe.waitFor((s) => s.includes("README.md"), 10_000)

  // Switch to Changes tab.
  await kobe.sendKeys("2")

  // The PTY's screen buffer is cumulative — every frame the renderer
  // paints is appended, ANSI cursor jumps and all. After we strip
  // ANSI, lines from prior frames still show up in the captured
  // string. We can therefore reliably assert that the *new* content
  // appears (which only the Changes tab paints) but not that
  // committed-only file names like `src/util.ts` are absent — they'll
  // remain in the historical-frame portion of the buffer.
  //
  // The right contract for "Changes tab is showing the right rows"
  // here is the unique-to-Changes signature: each modified row is
  // prefixed with its single-char status code adjacent to the path
  // ("M src/index.ts" / "? new-file.txt"). On the All tab we render
  // bare paths with no prefix glyph, so a positive match on these
  // patterns proves the tab swap landed AND the parser fed the right
  // status codes through.
  const changesScreen = await kobe.waitFor((s) => /M\s+src\/index\.ts/.test(s) && /\?\s+new-file\.txt/.test(s), 10_000)

  expect(changesScreen).toMatch(/M\s+src\/index\.ts/)
  expect(changesScreen).toMatch(/\?\s+new-file\.txt/)

  // The Changes tab must NOT introduce any bare-no-prefix row for a
  // committed-only file. We assert that within the most recent frame
  // — the last 500 chars of the captured screen, after the tab
  // switch — neither `src/util.ts` (committed, unchanged) nor a row
  // that looks like a bare All-tab entry for it appears. This keeps
  // the test honest about what's currently rendered without
  // depending on the buffer being clean.
  const tail = changesScreen.slice(-500)
  expect(tail).not.toContain("src/util.ts")

  await kobe.exit()
}, 30_000)

// ---------------------------------------------------------------------
// (c) enter on a file fires onOpenFile (host writes to output file).
// ---------------------------------------------------------------------

test("filetree H — enter on a row fires onOpenFile with the relative path", async () => {
  const fixture = buildFixture()
  tmpRoot = fixture.tmpRoot

  kobe = await spawnKobe({
    env: {
      KOBE_FILETREE_HOST: "1",
      KOBE_FILETREE_WORKTREE: fixture.repo,
      KOBE_FILETREE_OUTPUT: fixture.outputFile,
    },
    cols: 120,
    rows: 30,
  })

  await kobe.waitFor((s) => s.includes("kobe filetree host"), 10_000)
  await kobe.waitFor((s) => s.includes("README.md"), 10_000)

  // The cursor starts on the first row. Press enter — the host
  // should append the row's path to the output file.
  await kobe.sendKeys("\r")

  // Poll the output file until something appears. We allow up to
  // 5 seconds because the render → keypress → fs.appendFileSync
  // chain has multiple async hops.
  const deadline = Date.now() + 5_000
  let contents = ""
  while (Date.now() < deadline) {
    contents = fs.readFileSync(fixture.outputFile, "utf8")
    if (contents.length > 0) break
    await new Promise((r) => setTimeout(r, 50))
  }

  expect(contents.length).toBeGreaterThan(0)
  // The first row in the All tab is the alphabetically-first file.
  // From listFiles' sort, that's `.gitignore`. We don't hardcode
  // that here because a future fixture tweak could change the
  // first row — instead, assert the captured string is one of the
  // files we know exist in the worktree.
  const opened = contents.split("\n").filter((l) => l.length > 0)
  expect(opened.length).toBeGreaterThan(0)
  const first = opened[0]
  expect(first).toBeDefined()
  const knownFiles = ["README.md", ".gitignore", "src/index.ts", "src/util.ts", "new-file.txt"]
  expect(knownFiles).toContain(first as string)

  await kobe.exit()
}, 30_000)
