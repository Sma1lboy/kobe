import { createFileRoute } from "@tanstack/react-router"
import { ChatTerminal } from "../components/ChatTerminal.tsx"

function PtyHarness() {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#141413" }}>
      <ChatTerminal tabId="e2e" taskId="e2e" mode="shell" />
    </div>
  )
}

export const Route = createFileRoute("/harness")({ component: PtyHarness })
