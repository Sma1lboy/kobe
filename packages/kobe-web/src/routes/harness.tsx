import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { ChatTerminal, type WsStatus } from "../components/ChatTerminal.tsx"

/**
 * `/harness` — the one fixed-viewport observation surface for the real
 * OpenTUI. The PTY runs `KOBE_PTY_DEV_COMMAND`; visual acceptance always sets
 * that to `dev:sandbox`. The hidden buffer is synchronization/diagnostics only
 * — screenshots still capture xterm's rendered pixels.
 */
function PtyHarness() {
  const rawRun =
    new URLSearchParams(window.location.search).get("run") ?? "manual"
  const runId = rawRun.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "manual"
  const sessionId = `visual-${runId}`
  const [status, setStatus] = useState<WsStatus>("connecting")
  const [buffer, setBuffer] = useState("")

  return (
    <div
      data-testid="opentui-harness"
      data-pty-status={status}
      style={{ position: "fixed", inset: 0, background: "#141413" }}
    >
      <ChatTerminal
        tabId={sessionId}
        taskId={sessionId}
        mode="shell"
        testId="opentui-terminal"
        disableWebgl={true}
        onStatusChange={setStatus}
        onBufferChange={setBuffer}
      />
      <pre data-testid="opentui-buffer" style={{ display: "none" }}>
        {buffer}
      </pre>
    </div>
  )
}

export const Route = createFileRoute("/harness")({ component: PtyHarness })
