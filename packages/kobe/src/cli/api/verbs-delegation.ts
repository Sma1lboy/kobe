/** Offline discovery surface for the canonical Task delegation protocol. */

import { KOBE_DELEGATION_DEFAULT_MAX_HOPS, describeDelegationProtocol } from "../../core/task-delegation-protocol.ts"
import { ulid } from "../../orchestrator/index/ulid.ts"
import { ApiError, type VerbSpec, helpStep } from "./types.ts"

const PROTOCOL_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const DELEGATION_PROTOCOL_VERB: VerbSpec = {
  name: "delegation-protocol",
  summary:
    "Return the canonical directed-delegation v2 contract and ready-to-send request/result templates. Offline; with both task ids it assigns a fresh request id.",
  flags: [
    {
      name: "primary-task-id",
      type: "string",
      placeholder: "ID",
      description: "Primary Task id used to address the result template.",
    },
    {
      name: "subagent-task-id",
      type: "string",
      placeholder: "ID",
      description: "Subagent Task id used to address the request template.",
    },
    {
      name: "request-id",
      type: "string",
      placeholder: "ID",
      description: "Existing request chain id; omit for a fresh id when both task ids are present.",
    },
    {
      name: "max-hops",
      type: "int",
      default: String(KOBE_DELEGATION_DEFAULT_MAX_HOPS),
      placeholder: "N",
      description: "Semantic-message budget for this request chain; minimum 2 (request + result).",
    },
  ],
  offline: true,
  handler: async (ctx) => {
    const primaryTaskId = ctx.args.str("primary-task-id")
    const subagentTaskId = ctx.args.str("subagent-task-id")
    if (Boolean(primaryTaskId) !== Boolean(subagentTaskId)) {
      throw new ApiError(
        "--primary-task-id and --subagent-task-id must be provided together",
        "MISSING_FLAG",
        helpStep("delegation-protocol"),
      )
    }
    const maxHops = ctx.args.int("max-hops") ?? KOBE_DELEGATION_DEFAULT_MAX_HOPS
    if (maxHops < 2) {
      throw new ApiError(
        "--max-hops must be at least 2 (request + result)",
        "BAD_FLAG",
        helpStep("delegation-protocol"),
      )
    }
    const requestId = ctx.args.str("request-id") ?? (primaryTaskId ? `req_${ulid()}` : undefined)
    for (const [flag, value] of [
      ["primary-task-id", primaryTaskId],
      ["subagent-task-id", subagentTaskId],
      ["request-id", requestId],
    ] as const) {
      if (value !== undefined && !PROTOCOL_TOKEN_RE.test(value)) {
        throw new ApiError(`--${flag} must be a safe protocol token (1-128 letters, digits, . _ : -)`, "BAD_FLAG")
      }
    }
    return describeDelegationProtocol({ primaryTaskId, subagentTaskId, requestId, maxHops })
  },
}
