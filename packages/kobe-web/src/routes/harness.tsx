import { createFileRoute } from "@tanstack/react-router"
import { ChatTerminal } from "../components/ChatTerminal.tsx"

/**
 * `/harness` — a bare full-screen xterm for UI e2e / manual dev.
 * (Named `/harness`, not `/pty-*`: the Vite dev `/pty` proxy would capture the
 * route and forward it to the PTY sidecar → 404.)
 *
 * It mounts a single {@link ChatTerminal} whose PTY runs whatever
 * `KOBE_PTY_DEV_COMMAND` the sidecar was launched with (`bun run dev:mock` /
 * `dev:sandbox`), bypassing the daemon + task machinery (see pty-server.mjs
 * `fetchSpec` override). Playwright drives the real TUI through this terminal.
 * Not linked from the app; `taskId` is ignored by the overridden spec.
 */
function PtyHarness() {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#141413" }}>
      <ChatTerminal tabId="e2e" taskId="e2e" mode="shell" />
    </div>
  )
}

export const Route = createFileRoute("/harness")({ component: PtyHarness })
