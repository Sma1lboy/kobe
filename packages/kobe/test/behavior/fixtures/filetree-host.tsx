/**
 * Stream H — file tree pane behavior test host.
 *
 * Mounts ONLY the FileTree pane against a fixture worktree, so the
 * behavior test can drive the pane in isolation without waiting on
 * the full app.tsx integration to land. Wired into `src/cli/index.ts`
 * via the `KOBE_FILETREE_HOST=1` environment variable: when set, the
 * CLI dispatches to `startFileTreeHost()` here instead of the normal
 * `startTui()` mount.
 *
 * Why this hack: the brief (HARNESS.md, behavioral self-test
 * principle) requires every Wave 3 stream to ship a behavior test
 * that proves the visible pane works end-to-end. The pane is not
 * yet integrated into `app.tsx` — Wave 3's orchestrator does that at
 * merge time. This host file is the smallest possible bridge.
 *
 * Communication channel:
 *   - In:  `KOBE_FILETREE_WORKTREE` env var → worktree path passed to
 *          the pane.
 *   - Out: `onOpenFile(relPath)` writes the path to a file at
 *          `KOBE_FILETREE_OUTPUT` (or `<worktree>/.kobe-filetree-opened`
 *          as fallback). The behavior test reads this to assert that
 *          enter / click activated the right file.
 *
 * Theming + layout:
 *   - Same Theme + dialog providers as the real app. The pane behaves
 *     identically — what you see in this host is what you'd see
 *     embedded in the 5-pane shell.
 *   - We render a tiny header line ("kobe filetree host") so the
 *     behavior test can `waitFor("kobe")` to confirm the binary
 *     painted before asserting on pane contents.
 *
 * This file ships under `test/behavior/fixtures/` so it's clearly
 * test-only. It is deleted at Wave 3 integration when the
 * orchestrator wires the pane into `app.tsx` natively. Until then,
 * sister streams (G chat, I diff, J terminal) follow the same
 * pattern with their own `KOBE_<NAME>_HOST=1` flags.
 */

import fs from "node:fs"
import path from "node:path"
import { TextAttributes } from "@opentui/core"
import { render } from "@opentui/solid"
import { ThemeProvider, useTheme } from "../../../src/tui/context/theme"
import { FileTree } from "../../../src/tui/panes/filetree"
import { DialogProvider } from "../../../src/tui/ui/dialog"

const DEFAULT_THEME = "tokyonight"

function HostShell(props: { worktreePath: string; outputFile: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={theme.background}>
      <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingTop={1} paddingRight={2}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          kobe filetree host
        </text>
        <text fg={theme.textMuted}>worktree: {props.worktreePath}</text>
      </box>
      <FileTree
        worktreePath={() => props.worktreePath}
        onOpenFile={(rel) => {
          // Append-write so multiple opens in one session can be observed.
          fs.appendFileSync(props.outputFile, `${rel}\n`, "utf8")
        }}
      />
    </box>
  )
}

function HostApp(props: { worktreePath: string; outputFile: string }) {
  return (
    <ThemeProvider mode="dark" theme={DEFAULT_THEME}>
      <DialogProvider>
        <HostShell worktreePath={props.worktreePath} outputFile={props.outputFile} />
      </DialogProvider>
    </ThemeProvider>
  )
}

/**
 * Mount the host. Called by `src/cli/index.ts` when
 * `KOBE_FILETREE_HOST=1`.
 */
export async function startFileTreeHost(): Promise<void> {
  const worktreePath = process.env.KOBE_FILETREE_WORKTREE ?? ""
  if (!worktreePath) {
    // Helpful failure for an agent that misconfigured the env.
    // eslint-disable-next-line no-console
    console.error("[filetree-host] KOBE_FILETREE_WORKTREE not set")
    process.exit(2)
  }
  const outputFile = process.env.KOBE_FILETREE_OUTPUT ?? path.join(worktreePath, ".kobe-filetree-opened")
  // Ensure the file exists so the test can read-then-assert without
  // an ENOENT race.
  try {
    fs.writeFileSync(outputFile, "", "utf8")
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[filetree-host] cannot init output file:", err)
    process.exit(2)
  }
  await render(() => <HostApp worktreePath={worktreePath} outputFile={outputFile} />)
}
