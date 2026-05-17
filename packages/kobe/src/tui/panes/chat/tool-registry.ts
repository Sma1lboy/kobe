/**
 * Per-vendor tool metadata for the chat renderer.
 *
 * `MessageList.tsx`'s `ToolRow` used to spell out tool-name comparisons
 * inline (`r().name === "Edit" || r().name === "Write"` …). When a
 * second vendor lands (Codex), those if-trees would have to grow new
 * arms for every Codex tool that needs custom rendering. This file
 * centralises the lookup so:
 *
 *   - Adding / renaming a Claude tool only touches `claudeRegistry`.
 *   - Adding a Codex vendor only adds `codexRegistry` (no MessageList
 *     edits except the actual JSX for any new render strategies).
 *   - `classifyTool` (used by the tool-fold summary) reads from the
 *     same table, so the bucket vocabulary stays consistent.
 *
 * Why we don't ship JSX components in the registry today: the existing
 * banners/bodies live in `MessageList.tsx` and `bash-render.ts` /
 * `edit-diff.ts` / `tool-banners.ts`, and lifting them into a registry
 * value would be ~400 lines of churn for no behavior change. The flag
 * shape here is enough to drive the conditional render strategy from
 * outside the if-tree.
 */

import type { VendorId } from "@/types/vendor"

/**
 * Coarse tool category for the fold summary
 * ("Searched 3 patterns, read 2 files…"). Matches the bucket vocabulary
 * `summarizeToolRun` consumes.
 */
export type ToolBucket = "search" | "read" | "list" | "bash" | "other"

/**
 * Render strategy for a tool's banner (the `<prefix> <name>(<args>)` line).
 *
 *   - `default` — render `<bold name>(<arg-preview>)`. Used for tools
 *     with no purpose-built banner.
 *   - `bash` — multi-line banner showing `$ <command>` (see `BashBanner`).
 *   - `read-grep-glob` — banner shows the target / pattern (see
 *     `ReadGrepGlobBanner`).
 */
export type ToolBannerStrategy = "default" | "bash" | "read-grep-glob"

/**
 * Render strategy for a tool's body (what comes under the banner).
 *
 *   - `default` — collapsed: `⎿ <output-preview>`. Expanded: input + output
 *     JSON dumps.
 *   - `edit-diff` — inline diff (Edit / Write).
 *   - `multi-edit-diff` — stacked per-edit diff (MultiEdit).
 *   - `bash-output` — stdout/stderr block under the Bash banner.
 *   - `read-grep-glob` — banner already carries the summary; expanded
 *     view shows the raw output dump but no input block.
 *   - `subagent` — Agent/Task invocation. Body renders the subagent's
 *     nested tool steps (collected on the row's `children`): a
 *     collapsed progress summary, expandable to the per-step list.
 */
export type ToolBodyStrategy =
  | "default"
  | "edit-diff"
  | "multi-edit-diff"
  | "bash-output"
  | "read-grep-glob"
  | "subagent"

export interface ToolMeta {
  readonly bucket: ToolBucket
  readonly banner: ToolBannerStrategy
  readonly body: ToolBodyStrategy
}

const DEFAULT_META: ToolMeta = {
  bucket: "other",
  banner: "default",
  body: "default",
}

const claudeRegistry: Readonly<Record<string, ToolMeta>> = {
  Edit: { bucket: "other", banner: "default", body: "edit-diff" },
  Write: { bucket: "other", banner: "default", body: "edit-diff" },
  MultiEdit: { bucket: "other", banner: "default", body: "multi-edit-diff" },
  Bash: { bucket: "bash", banner: "bash", body: "bash-output" },
  BashOutput: { bucket: "bash", banner: "default", body: "default" },
  KillShell: { bucket: "bash", banner: "default", body: "default" },
  Read: { bucket: "read", banner: "read-grep-glob", body: "read-grep-glob" },
  NotebookRead: { bucket: "read", banner: "default", body: "default" },
  Grep: { bucket: "search", banner: "read-grep-glob", body: "read-grep-glob" },
  Glob: { bucket: "list", banner: "read-grep-glob", body: "read-grep-glob" },
  LS: { bucket: "list", banner: "default", body: "default" },
  // Subagent invocation. Claude Code names the tool `Task`; older
  // builds / docs also use `Agent` — register both so either spelling
  // gets the nested-steps body.
  Task: { bucket: "other", banner: "default", body: "subagent" },
  Agent: { bucket: "other", banner: "default", body: "subagent" },
}

const registries: Readonly<Record<VendorId, Readonly<Record<string, ToolMeta>>>> = {
  claude: claudeRegistry,
  codex: {},
  gemini: {},
}

/**
 * Resolve a tool name → render strategy + bucket.
 *
 * `vendor` defaults to `"claude"` because the chat renderer doesn't yet
 * track which vendor produced each tool call — once `Task.vendor` lands
 * (KOB-49 follow-up), callers should plumb it through.
 *
 * Unknown tools (including all Codex tools today) fall through to
 * {@link DEFAULT_META}: generic `name(args)` banner, generic preview body,
 * bucketed as `"other"` so the fold summary says "Used N other tools."
 */
export function lookupToolMeta(name: string, vendor: VendorId = "claude"): ToolMeta {
  return registries[vendor][name] ?? DEFAULT_META
}

/** Convenience alias kept for `groupRenderItems` (the fold-summary call site). */
export function classifyTool(name: string, vendor: VendorId = "claude"): ToolBucket {
  return lookupToolMeta(name, vendor).bucket
}

/**
 * True for Agent/Task tools that own nested subagent steps. The chat's
 * tool-fold groups consecutive tool rows into a single summary; a
 * subagent row carries its own progress UI and must stay un-folded, so
 * `groupRenderItems` treats it as a fold boundary. Lives here (not as a
 * literal name check in `tool-fold`) to keep vendor strings in the
 * registry.
 */
export function isSubagentTool(name: string, vendor: VendorId = "claude"): boolean {
  return lookupToolMeta(name, vendor).body === "subagent"
}
