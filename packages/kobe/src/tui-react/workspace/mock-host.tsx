/** @jsxImportSource @opentui/react */
/**
 * `dev:mock-react-workspace` — the ported `TerminalTabs` cluster (tab
 * strip, terminal split, engine picker, rename dialog, turn polls) against
 * REAL in-process PTYs, no daemon/orchestrator/engine involved — same
 * "prove the seam live, no fake" convention as `tui/mock/terminal-host.tsx`
 * (`dev:mock-terminal`). `getDefaultPtyRegistry()` has no injectable mock
 * factory (only `Terminal.tsx`'s standalone pane accepts a `registry`
 * prop), so every tab/split leaf here runs a REAL throwaway shell instead
 * of a scripted transcript: ctrl+t/ctrl+w/F2/ctrl+]/[ (tabs), ctrl+e
 * (engine picker — picks a real vendor binary if one is on PATH, else
 * degrades to a shell when it exits missing), ctrl+\ / ctrl+= (split).
 * `WorkspaceRoot`'s Sidebar/FileTree/orchestrator wiring is NOT exercised
 * here — that needs a real daemon (`KOBE_REACT=1 bun run dev:sandbox` is
 * the faithful end-to-end path for the full host).
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootPaneHost } from "../lib/host-boot"
import { TerminalTabs } from "./TerminalTabs"

const cwd = mkdtempSync(join(tmpdir(), "kobe-mock-react-workspace-"))

void bootPaneHost({
  logContext: "workspace-mock",
  providers: { kv: true, focus: false, notifications: true },
  setup: () => ({
    root: () => (
      <TerminalTabs
        taskId="mock-workspace-task"
        worktree={cwd}
        command={["sh", "-c", 'echo WORKSPACE-TABS-OK "(cwd: $PWD)"; exec sh -i']}
        vendor="claude"
        focused={true}
      />
    ),
  }),
})
