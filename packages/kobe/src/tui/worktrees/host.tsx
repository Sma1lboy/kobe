import { connectIfRunning } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { WorktreesPage } from "../component/worktrees-page.tsx"
import { bootPaneHost } from "../lib/host-boot"

export async function startWorktreesHost(): Promise<void> {
  await bootPaneHost({
    setup: async () => {
      let orch: RemoteOrchestrator | null = null
      try {
        const client = await connectIfRunning()
        if (client) {
          const remote = new RemoteOrchestrator(client)
          await remote.init()
          orch = remote
        } else {
          console.error("[kobe worktrees] no daemon running; nothing to list")
        }
      } catch (err) {
        console.error("[kobe worktrees] daemon unavailable:", err)
      }
      return {
        root: () => <WorktreesPage orchestrator={orch} onClose={() => process.exit(0)} />,
        onDestroy: () => {
          orch?.dispose()
        },
      }
    },
  })
}
