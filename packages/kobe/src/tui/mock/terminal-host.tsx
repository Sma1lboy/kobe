/**
 * `dev:mock-terminal` host — the embedded terminal pane against a REAL
 * in-process PTY, no engine/daemon/task involved (issue #16).
 *
 * Boots the revived Terminal pane with a throwaway command that prints a
 * greppable marker and then keeps an interactive `sh` alive, proving the
 * whole seam live: Bun.spawn PTY → @xterm/headless snapshot → StyledText
 * render → keyboard write-through. The smoke gate greps the marker from
 * the ANSI output; run it interactively to type into the shell.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootPaneHost } from "../lib/host-boot"
import { Terminal } from "../panes/terminal/Terminal"

const cwd = mkdtempSync(join(tmpdir(), "kobe-mock-terminal-"))

void bootPaneHost({
  providers: { kv: false, focus: false },
  setup: () => ({
    root: () => (
      <Terminal
        cwd={() => cwd}
        taskId={() => "mock-terminal"}
        command={["sh", "-c", 'echo TERMINAL-PANE-OK "(cwd: $PWD)"; exec sh -i']}
        focused={() => true}
      />
    ),
  }),
})
