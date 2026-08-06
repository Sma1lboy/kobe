/** Canonical, UI-independent contract for directed Task delegation. */

export const KOBE_DELEGATION_PROTOCOL_VERSION = 2 as const
export const KOBE_DELEGATION_DEFAULT_MAX_HOPS = 2 as const

export const KOBE_DELEGATION_MESSAGE_KINDS = ["request", "result", "progress", "blocked", "cancel"] as const
export type KobeDelegationMessageKind = (typeof KOBE_DELEGATION_MESSAGE_KINDS)[number]

export const KOBE_DELEGATION_REPLY_POLICIES = ["required_once", "only_if_blocked", "none"] as const
export type KobeDelegationReplyPolicy = (typeof KOBE_DELEGATION_REPLY_POLICIES)[number]

export interface DelegationProtocolInput {
  readonly primaryTaskId?: string
  readonly subagentTaskId?: string
  readonly requestId?: string
  readonly maxHops?: number
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Machine-readable protocol exposed by `kobe api delegation-protocol`. */
export function describeDelegationProtocol(input: DelegationProtocolInput = {}) {
  const primaryTaskId = input.primaryTaskId ?? "<primary-task-id>"
  const subagentTaskId = input.subagentTaskId ?? "<subagent-task-id>"
  const requestId = input.requestId ?? "<request-id>"
  const maxHops = input.maxHops ?? KOBE_DELEGATION_DEFAULT_MAX_HOPS
  if (!Number.isInteger(maxHops) || maxHops < 2) throw new Error("delegation maxHops must be an integer of at least 2")
  const contractCommand = `kobe api delegation-protocol --primary-task-id ${shellQuote(primaryTaskId)} --subagent-task-id ${shellQuote(subagentTaskId)} --request-id ${shellQuote(requestId)} --max-hops ${maxHops} --pretty`
  return {
    name: "kobe.task-delegation",
    version: KOBE_DELEGATION_PROTOCOL_VERSION,
    sourceOfTruth: "kobe api delegation-protocol",
    defaults: { maxHops: KOBE_DELEGATION_DEFAULT_MAX_HOPS },
    messageKinds: KOBE_DELEGATION_MESSAGE_KINDS,
    replyPolicies: KOBE_DELEGATION_REPLY_POLICIES,
    semantics: {
      hop: "Increment once for every semantic message in one request chain; never send when hop would exceed max_hops.",
      templates:
        "resultTemplate is the immediate terminal response at hop 2. If a larger budget carries intervening messages, preserve request_id/max_hops/task ids and set hop to the actual next value.",
      replyPolicy: {
        required_once: "The recipient must send exactly one semantic response.",
        only_if_blocked: "Reply only when blocked; silence otherwise is expected.",
        none: "Terminal message; do not reply.",
      },
      delivery: "Transport success is not a semantic acknowledgement; never send acknowledgement-only turns.",
    },
    requestTemplate: `[KOBE DELEGATION MESSAGE v${KOBE_DELEGATION_PROTOCOL_VERSION}]
request_id: ${requestId}
kind: request
hop: 1
max_hops: ${maxHops}
reply_policy: required_once
target_task_id: ${subagentTaskId}
primary_task_id: ${primaryTaskId}
subagent_task_id: ${subagentTaskId}

objective: <one bounded outcome>
constraints: <scope, files, permissions, forbidden actions>
done_when: <observable acceptance evidence>
contract_command: ${contractCommand}`,
    resultTemplate: `[KOBE DELEGATION MESSAGE v${KOBE_DELEGATION_PROTOCOL_VERSION}]
request_id: ${requestId}
kind: result
hop: 2
max_hops: ${maxHops}
reply_policy: none
target_task_id: ${primaryTaskId}
primary_task_id: ${primaryTaskId}
subagent_task_id: ${subagentTaskId}

status: <completed | blocked | failed>
summary: <what changed or was learned>
evidence: <tests, files, commands, or observations>
artifact_refs: <paths, commits, diffs, or none>
risks: <remaining risks or none>`,
  } as const
}
