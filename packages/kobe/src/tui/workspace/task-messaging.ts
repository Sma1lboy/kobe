/** Minimal address handoff for cross-Task messaging. */

import type { Task } from "../../types/task.ts"

export function buildTaskContactPrompt(current: Task, peer: Task): string {
  return `[KOBE TASK CONTACT]

You can contact another Kobe Task when the user asks. This only gives you its address; it does not create a channel, persist a relationship, or fork either chat.

your_task_id: ${current.id}
peer_task_id: ${peer.id}
peer_task_title: ${peer.title}

Read the installed Kobe skill's "Cross-task messaging" section before sending. Use normal \`kobe api send\` with \`peer_task_id\` as the target. Every message must include \`reply_to_task_id: ${current.id}\` so the receiving Task knows where to reply. Your first message to this peer must explicitly tell the receiving agent to read that skill section before acting; later messages do not need to repeat it.

Do not contact the peer yet. Acknowledge this address briefly, then wait for the user's actual request.`
}
