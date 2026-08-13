/**
 * Kimi's path-only history reader: the store layout is verified (live
 * install, 2026-08-13) even though the wire format isn't, which is exactly
 * enough for a cross-engine handoff — it hands over a PATH, not messages.
 */

import {
  type KimiHistoryDeps,
  listSessionIdsForWorktree,
  parseSessionIndex,
  transcriptPath,
} from "@/engine/kimi-local/history"
import { supportsStructuredHistory } from "@/engine/registry"
import { describe, expect, it } from "vitest"

const INDEX = [
  '{"sessionId":"session_a","sessionDir":"/home/.kimi-code/sessions/wd_p_1/session_a","workDir":"/wt"}',
  '{"sessionId":"session_b","sessionDir":"/home/.kimi-code/sessions/wd_p_1/session_b","workDir":"/wt"}',
  '{"sessionId":"session_c","sessionDir":"/home/.kimi-code/sessions/wd_q_2/session_c","workDir":"/other"}',
].join("\n")

/** mtimes keyed by wire path; a path absent from the map doesn't exist. */
function deps(index: string, mtimes: Record<string, number>): KimiHistoryDeps {
  return {
    kimiDir: () => "/home/.kimi-code",
    readFile: async (p) => (p.endsWith("session_index.jsonl") ? index : ""),
    stat: async (p) => {
      const m = mtimes[p]
      if (m === undefined) throw new Error("ENOENT")
      return { mtimeMs: m }
    },
  }
}

const wire = (id: string, dir = "wd_p_1") => `/home/.kimi-code/sessions/${dir}/${id}/agents/main/wire.jsonl`

describe("parseSessionIndex", () => {
  it("keeps complete records and skips a torn trailing line", () => {
    const entries = parseSessionIndex(`${INDEX}\n{"sessionId":"session_d","sessionD`)
    expect(entries.map((e) => e.sessionId)).toEqual(["session_a", "session_b", "session_c"])
  })

  it("skips a record missing a field rather than yielding a half entry", () => {
    expect(parseSessionIndex('{"sessionId":"x","workDir":"/wt"}')).toEqual([])
  })
})

describe("listSessionIdsForWorktree", () => {
  it("returns this worktree's sessions oldest-first by stream mtime", async () => {
    // Index order is a,b but b was touched FIRST — the handoff forks from
    // `.at(-1)`, which must be the most recently worked-in conversation.
    const d = deps(INDEX, { [wire("session_a")]: 200, [wire("session_b")]: 100 })
    expect(await listSessionIdsForWorktree("/wt", d)).toEqual(["session_b", "session_a"])
  })

  it("drops a session whose stream isn't on disk, and other worktrees", async () => {
    const d = deps(INDEX, { [wire("session_a")]: 1, [wire("session_c", "wd_q_2")]: 9 })
    expect(await listSessionIdsForWorktree("/wt", d)).toEqual(["session_a"])
  })

  it("returns nothing for an empty worktree or an unreadable index", async () => {
    expect(await listSessionIdsForWorktree("", deps(INDEX, {}))).toEqual([])
    expect(await listSessionIdsForWorktree("/wt", deps("", {}))).toEqual([])
  })
})

describe("transcriptPath", () => {
  it("names the MAIN agent's stream — sub-agents are internal fan-out", async () => {
    const d = deps(INDEX, { [wire("session_a")]: 5 })
    expect(await transcriptPath("session_a", d)).toBe(wire("session_a"))
  })

  it("returns null for an unknown id, and for an id whose file vanished", async () => {
    const d = deps(INDEX, { [wire("session_a")]: 5 })
    expect(await transcriptPath("session_zzz", d)).toBeNull()
    // In the index, but no stream on disk — briefing an agent with a path
    // that doesn't resolve is worse than refusing the handoff.
    expect(await transcriptPath("session_b", d)).toBeNull()
  })
})

describe("supportsStructuredHistory", () => {
  it("stays false for kimi: it resolves paths, but parses no messages", () => {
    expect(supportsStructuredHistory("kimi")).toBe(false)
    expect(supportsStructuredHistory("copilot")).toBe(true)
  })
})
