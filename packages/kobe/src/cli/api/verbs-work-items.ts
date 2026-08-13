/**
 * The `workitem` verb group — a READ-ONLY view of a repo's GitHub issues,
 * plus the one action that makes it worth having: start a task on one.
 *
 * Deliberately not an import into the local issue store: the tracker stays the
 * owner. Mechanics: `docs/design/work-items.md`.
 */

import { F } from "./flags.ts"
import { simpleRpc } from "./handler-helpers.ts"
import type { VerbSpec } from "./types.ts"

const WORK_ITEM_STATES = ["open", "closed", "all"] as const

export const WORK_ITEM_VERBS: readonly VerbSpec[] = [
  {
    name: "workitem-list",
    summary:
      "List a repo's GitHub issues through the `gh` CLI. Read-only — nothing is copied into Rove's own issue store.",
    flags: [
      F.repo(),
      { name: "state", type: "enum", values: WORK_ITEM_STATES, default: "open", description: "Issue state filter." },
      { name: "limit", type: "int", placeholder: "N", description: "Max items (1-50, default 20)." },
      { name: "search", type: "string", placeholder: "Q", description: "Free-text search passed to `gh --search`." },
      {
        name: "assignee",
        type: "string",
        placeholder: "USER",
        description: "Only items assigned to this user; `@me` for yourself.",
      },
      { name: "label", type: "string", placeholder: "L", description: "Only items carrying this label." },
    ],
    handler: (ctx) =>
      simpleRpc(ctx, "workitem.list", {
        repo: ctx.args.requirePath("repo"),
        ...(ctx.args.str("state") ? { state: ctx.args.str("state") } : {}),
        ...(ctx.args.int("limit") !== undefined ? { limit: ctx.args.int("limit") } : {}),
        ...(ctx.args.str("search") ? { search: ctx.args.str("search") } : {}),
        ...(ctx.args.str("assignee") ? { assignee: ctx.args.str("assignee") } : {}),
        ...(ctx.args.str("label") ? { labels: [ctx.args.str("label")] } : {}),
      }),
  },
  {
    name: "workitem-start",
    summary:
      "Start a task on one GitHub issue: creates a worktree + engine session whose first message carries the issue title, body, and URL. The task keeps a link back to the issue.",
    flags: [
      F.repo(),
      { name: "number", type: "int", required: true, placeholder: "N", description: "Issue number." },
      F.vendor(),
      { name: "base-branch", type: "string", placeholder: "B", description: "Base ref the worktree branches from." },
    ],
    handler: (ctx) =>
      simpleRpc(ctx, "workitem.start", {
        repo: ctx.args.requirePath("repo"),
        number: ctx.args.int("number"),
        ...(ctx.args.vendor() ? { vendor: ctx.args.vendor() } : {}),
        ...(ctx.args.str("base-branch") ? { baseRef: ctx.args.str("base-branch") } : {}),
      }),
  },
]
