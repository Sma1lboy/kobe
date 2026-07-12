/**
 * Pins the issue-chat first-prompt contract (state/issue-chat.ts) — web
 * quick-start parity: both prompts frame the story (#id + title + body) and
 * end with the daemon-owned `issue-set-status … done` instruction; the
 * worktree prompt carries the worktree/merge discipline, the project prompt
 * replaces it with the stay-on-checkout note. A drift here changes what
 * every story-spawned agent is told to do.
 */

import type { Issue } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { describe, expect, test } from "vitest"
import {
  ISSUE_CHAT_PLACEMENTS,
  issueChatTaskTitle,
  issueProjectPrompt,
  issueWorktreePrompt,
} from "../../src/state/issue-chat"

const story: Issue = {
  id: 7,
  title: "Fix the flake",
  status: "open",
  created: "2026-07-10",
  body: "repro steps here",
}

describe("issue-chat prompts", () => {
  test("task title is the web `#id title` shape", () => {
    expect(issueChatTaskTitle(story)).toBe("#7 Fix the flake")
  })

  test("worktree prompt: story + worktree/merge discipline + done instruction", () => {
    const prompt = issueWorktreePrompt(story, "bun kobe api")
    expect(prompt).toContain("Work on user story #7: Fix the flake")
    expect(prompt).toContain("repro steps here")
    expect(prompt).toContain("task worktree")
    expect(prompt).toContain("merge the task branch")
    expect(prompt).toContain("bun kobe api issue-set-status --repo . --id 7 --status done")
  })

  test("project prompt: stay on the checkout, no worktree/merge lines", () => {
    const prompt = issueProjectPrompt(story)
    expect(prompt).toContain("Work on user story #7: Fix the flake")
    expect(prompt).toContain("directly in the project checkout")
    expect(prompt).not.toContain("task worktree")
    expect(prompt).not.toContain("merge the task branch")
    expect(prompt).toContain("kobe api issue-set-status --repo . --id 7 --status done")
  })

  test("a blank body leaves no dangling blank section", () => {
    const prompt = issueWorktreePrompt({ ...story, body: "   " })
    expect(prompt).not.toContain("\n\n\n")
  })

  test("placement cycle order is worktree → worktreeBg → project", () => {
    expect(ISSUE_CHAT_PLACEMENTS).toEqual(["worktree", "worktreeBg", "project"])
  })
})
