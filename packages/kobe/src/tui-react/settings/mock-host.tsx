/** @jsxImportSource @opentui/react */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootPaneHost } from "../lib/host-boot"
import { SettingsPage } from "./host"

process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-mock-settings-"))

await bootPaneHost({
  logContext: "mock-settings",
  providers: { kv: true },
  setup: () => ({ root: () => <SettingsPage orchestrator={null} /> }),
})
