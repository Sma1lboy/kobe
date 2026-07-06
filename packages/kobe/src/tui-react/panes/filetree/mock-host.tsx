/** @jsxImportSource @opentui/react */
/**
 * React file-tree mock host (`bun run dev:mock-react-filetree`) — the live
 * render proof for the ported pane. The pane reads real git, so the fixture
 * is a throwaway `git init` repo in the OS tempdir with deterministic
 * `kobe-fixture-*` file names: the All tab lists them via
 * `git ls-files --others`, no commit required, and the smoke greps one of
 * them out of the captured ANSI output.
 */

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootPaneHost } from "../../lib/host-boot"
import { FileTree } from "./FileTree"

function makeFixtureWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "kobe-filetree-mock-"))
  execFileSync("git", ["init", "-q"], { cwd: dir })
  writeFileSync(join(dir, "kobe-fixture-alpha.ts"), "export const alpha = 1\n")
  writeFileSync(join(dir, "kobe-fixture-readme.md"), "# filetree mock fixture\n")
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src", "kobe-fixture-beta.ts"), "export const beta = 2\n")
  return dir
}

// Same minimal provider set as the Ops pane host that mounts the Solid
// FileTree: Theme > Dialog only, no KV / Focus.
await bootPaneHost({
  logContext: "filetree-mock",
  providers: { kv: false, focus: false },
  setup: () => {
    const worktree = makeFixtureWorktree()
    return {
      root: () => (
        <FileTree
          worktreePath={worktree}
          onOpenFile={() => {}}
          cornerBadge={{ text: "mock", active: true }}
          onCreatePR={() => {}}
        />
      ),
    }
  },
})
