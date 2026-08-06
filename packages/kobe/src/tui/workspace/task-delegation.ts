/** Framework-free prompt contract for a directed primary -> subagent Task link. */

import type { Task } from "../../types/task.ts"

/**
 * Deliberately self-contained. An installed Kobe skill gives broader API
 * guidance, but a stale/missing skill must not make a user-created link
 * unusable.
 */
export function buildDelegationBootstrapPrompt(primary: Task, subagent: Task): string {
  return `[KOBE DELEGATION LINK v1]

You are the PRIMARY agent. Kobe has linked an existing Task as your SUBAGENT; no chat was forked and no shared channel was created.

primary_task_id: ${primary.id}
primary_task_title: ${primary.title}
subagent_task_id: ${subagent.id}
subagent_task_title: ${subagent.title}

Read the installed Kobe skill before using the control plane. Keep this relationship asymmetric: you own user communication, decomposition, integration, and final verification. The subagent only owns work you explicitly delegate.

To delegate one bounded unit of work, send one complete turn with the explicit target id:

kobe api send --task-id ${subagent.id} --prompt "<complete scoped request>"

Start every request with this envelope so the subagent can reply without discovering ids:

[KOBE DELEGATION REQUEST v1]
primary_task_id: ${primary.id}
subagent_task_id: ${subagent.id}
objective: <one bounded outcome>
constraints: <scope, files, permissions, forbidden actions>
done_when: <observable acceptance evidence>
reply_via: kobe api send --task-id ${primary.id} --prompt "<structured result>"

Protocol boundaries:
- Every send is a full agent turn: batch useful information; do not ping, poll, or create an open-ended chatter loop.
- Do not recursively delegate unless the user explicitly asks for it.
- Task/worktree isolation remains in force. Never edit the other Task's worktree directly.
- Destructive actions, commits, pushes, PRs, and merges require their normal authorization; this link grants none.
- Treat a subagent reply as a claim with evidence, not as verified truth. You remain responsible for acceptance.
- If the current user goal has no clearly bounded work to delegate, do not send a greeting; briefly acknowledge that the link is ready.
`
}
