/** @jsxImportSource @opentui/react */

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootPaneHost } from "../lib/host-boot"
import { OpsShell } from "./host"

function makeFixtureWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "kobe-ops-mock-"))
  execFileSync("git", ["init", "-q"], { cwd: dir })
  writeFileSync(join(dir, "kobe-fixture-alpha.ts"), "export const alpha = 1\n")
  writeFileSync(join(dir, "kobe-fixture-readme.md"), "# ops mock fixture\n")
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src", "kobe-fixture-beta.ts"), "export const beta = 2\n")
  return dir
}

await bootPaneHost({
  logContext: "ops-mock",
  providers: { kv: false, focus: false },
  setup: () => {
    const worktree = makeFixtureWorktree()
    return {
      root: () => <OpsShell taskId="" worktree={worktree} targetPane={null} vendor="claude" />,
    }
  },
})
