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
