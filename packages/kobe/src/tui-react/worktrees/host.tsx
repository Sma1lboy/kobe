/** @jsxImportSource @opentui/react */
/**
 * `kobe worktrees` — React host (issue #15/#23), the
 * `src/tui/worktrees/host.tsx` counterpart. React is the default runtime
 * since 2026-07-07 (`uiFramework()` in `src/env.ts`); `KOBE_SOLID=1` is the
 * legacy escape hatch back to the Solid host in `src/cli/commands-tui.ts`.
 * Same contract: the worktree-management page rendered as its own
 * full-window surface (mirrors `tui-react/settings/host.tsx`'s shape
 * exactly). Opened by `openWorktreesTab`, which spawns this as a new
 * window via `kobe worktrees`; closing it (q / esc / Ctrl+C) exits the
 * process, so tmux closes the window and returns to the previous tab.
 *
 * Connects to the daemon itself (RemoteOrchestrator) since it runs as its
 * own process, same as the Tasks pane and Settings. The connect is
 * NON-spawning (`connectIfRunning`): a worktrees window opened from a
 * detached tmux session must never boot a daemon — doing so would leave a
 * gui-less daemon that never idle-stops. With no daemon up, the page
 * renders empty (nothing to list).
 */

import { connectPaneOrchestrator } from "../../client/connect-pane-orchestrator"
import { WorktreesPage } from "../component/worktrees-page.tsx"
import { bootPaneHost } from "../lib/host-boot"

export async function startWorktreesHost(): Promise<void> {
  await bootPaneHost({
    setup: async () => {
      // NON-spawning: connect ONLY to a daemon that's already running —
      // same contract as `kobe settings` (see file header), via the shared
      // seam (which logs the cause and disposes a half-built orchestrator
      // on failure). `null` → the page renders empty.
      const orch = await connectPaneOrchestrator({ logTag: "worktrees" })
      if (!orch) console.error("[kobe worktrees] no daemon running; nothing to list")
      return {
        root: () => <WorktreesPage orchestrator={orch} onClose={() => process.exit(0)} />,
        onDestroy: () => {
          orch?.dispose()
        },
      }
    },
  })
}
