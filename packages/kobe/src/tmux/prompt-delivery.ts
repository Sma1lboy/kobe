import type { FirstEngineMessage } from "../state/repo-init.ts"
import { capturePaneById, claudePaneId, claudePaneIdStrict, runTmux, sendKeyName } from "./client.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const SUBMIT_DELAY_MS = 150

export async function waitForEnginePane(session: string, fresh: boolean): Promise<{ pane: string; ready: boolean }> {
  let prev: string | null = null
  for (let attempt = 0; attempt < 24; attempt++) {
    const pane = await claudePaneIdStrict(session)
    if (pane) {
      if (!fresh) return { pane, ready: true }
      const cur = (await capturePaneById(pane)).trim()
      if (cur.length > 0 && cur === prev) return { pane, ready: true }
      prev = cur
    }
    await sleep(250)
  }
  const pane = (await claudePaneIdStrict(session)) || (await claudePaneId(session))
  return { pane, ready: false }
}

export async function pasteAndSubmit(pane: string, text: string): Promise<void> {
  const buffer = `kobe-api-${pane.replace(/[^A-Za-z0-9]/g, "")}`
  await runTmux(["set-buffer", "-b", buffer, "--", text])
  await runTmux(["paste-buffer", "-p", "-d", "-b", buffer, "-t", pane])
  await sleep(SUBMIT_DELAY_MS)
  await sendKeyName(pane, "Enter")
}

export async function deliverFirstEngineMessage(session: string, message: FirstEngineMessage): Promise<void> {
  const { pane } = await waitForEnginePane(session, true)
  if (!pane) return
  await pasteAndSubmit(pane, message.text)
}
