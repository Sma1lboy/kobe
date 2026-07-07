/**
 * kobe TUI bootstrap.
 *
 * Thin entry point: `kobe` goes straight into the tmux workspace
 * (`direct.ts`). The opentui outer monitor (`app.tsx`) and its
 * `KOBE_OUTER_MONITOR` / `KOBE_NO_DAEMON` escape hatches were retired —
 * see docs/design/app-retirement.md. Daemon recovery is `kobe doctor` /
 * `kobe reset`, not a daemon-less in-process Orchestrator.
 */

import { nativeChatEnabled, uiFramework } from "../env.ts"
import { maybeHintSkillInstall } from "../lib/skill-install.ts"

export async function startTui(): Promise<void> {
  // One-time nudge (before the tmux takeover): if the kobe agent
  // skill isn't installed, tell the user how. Best-effort — the reliable
  // check is `kobe doctor`. No-op when installed or already shown once.
  maybeHintSkillInstall()

  if (nativeChatEnabled()) {
    // React is the default runtime for the native workspace (issue #16);
    // `uiFramework()` (env.ts) is the ONE place that decides — same seam
    // as the settings/help/history/ops subcommands in commands-tui.ts.
    const { startWorkspaceHost } =
      uiFramework() === "solid" ? await import("./workspace/host") : await import("../tui-react/workspace/host.tsx")
    await startWorkspaceHost()
    return
  }

  const { startDirectTmux } = await import("./direct")
  await startDirectTmux()
}
