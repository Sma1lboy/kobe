/** Primary-task bootstrap for the canonical directed-delegation contract. */

import { KOBE_DELEGATION_PROTOCOL_VERSION } from "../../core/task-delegation-protocol.ts"
import type { Task } from "../../types/task.ts"

/**
 * Link bootstrap contains addressing and discovery only. Exact message fields,
 * defaults, and semantics come from `describeDelegationProtocol`; the skill
 * and design docs intentionally do not carry another schema copy.
 */
export function buildDelegationBootstrapPrompt(primary: Task, subagent: Task): string {
  return `[KOBE DELEGATION LINK v${KOBE_DELEGATION_PROTOCOL_VERSION}]

You are the PRIMARY agent. Kobe has linked an existing Task as your SUBAGENT; no chat was forked and no shared channel was created.

primary_task_id: ${primary.id}
primary_task_title: ${primary.title}
subagent_task_id: ${subagent.id}
subagent_task_title: ${subagent.title}

Read the installed Kobe skill before using the control plane. Keep this relationship asymmetric: you own user communication, decomposition, integration, and final verification. The subagent only owns work you explicitly delegate.

Before every new delegated request, obtain a fresh request_id and the canonical v${KOBE_DELEGATION_PROTOCOL_VERSION} message templates from the Kobe binary:

kobe api delegation-protocol --primary-task-id ${primary.id} --subagent-task-id ${subagent.id} --pretty

Send the returned requestTemplate as one complete turn:

kobe api send --task-id ${subagent.id} --prompt "<requestTemplate>"

The subagent replies to task ${primary.id} using the matching resultTemplate. The templates, enum values, hop rules, and defaults returned by the delegation-protocol command are authoritative.

Protocol boundaries:
- Every send is a full agent turn. Do not send acknowledgement-only messages or exceed max_hops.
- Do not recursively delegate unless the user explicitly asks for it.
- Task/worktree isolation remains in force. Never edit the other Task's worktree directly.
- Destructive actions, commits, pushes, PRs, and merges require their normal authorization; this link grants none.
- Treat a subagent reply as a claim with evidence, not as verified truth. You remain responsible for acceptance.
- If the current user goal has no clearly bounded work to delegate, do not send a greeting; briefly acknowledge that the link is ready.
`
}
