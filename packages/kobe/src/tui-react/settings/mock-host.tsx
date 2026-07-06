/** @jsxImportSource @opentui/react */
/**
 * React settings-page mock host (`bun run dev:mock-react-settings`). Renders
 * the real SettingsPage with no daemon (orchestrator null → "Restart
 * backend" hidden) against an ISOLATED throwaway home, so browsing/toggling
 * in the mock can never touch the real `~/.config/kobe/state.json`.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootPaneHost } from "../lib/host-boot"
import { SettingsPage } from "./host"

// Env is read lazily (kvStatePath()/homeDir() resolve per call), so setting
// it here — before bootPaneHost mounts the KVProvider — isolates every read
// and write this process makes.
process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-mock-settings-"))

await bootPaneHost({
  logContext: "mock-settings",
  providers: { kv: true },
  setup: () => ({ root: () => <SettingsPage orchestrator={null} /> }),
})
