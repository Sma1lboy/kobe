import { nativeChatEnabled } from "../env.ts"
import { maybeHintSkillInstall } from "../lib/skill-install.ts"

export async function startTui(): Promise<void> {
  maybeHintSkillInstall()

  if (nativeChatEnabled()) {
    const { startWorkspaceHost } = await import("./workspace/host")
    await startWorkspaceHost()
    return
  }

  const { startDirectTmux } = await import("./direct")
  await startDirectTmux()
}
