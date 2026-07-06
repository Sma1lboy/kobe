import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  submitFeedback: vi.fn(),
}))

vi.mock("../../src/lib/feedback.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/feedback.ts")>()
  return { ...actual, submitFeedback: mocks.submitFeedback }
})

import { parseFeedbackArgs, runFeedbackSubcommand } from "../../src/cli/feedback-cmd.ts"

let outSpy: MockInstance<typeof process.stdout.write>
let errSpy: MockInstance<typeof process.stderr.write>
let exitSpy: MockInstance<typeof process.exit>
let logSpy: MockInstance<typeof console.log>

beforeEach(() => {
  mocks.submitFeedback.mockReset().mockReturnValue({ number: 12, url: "https://github.com/x/y/discussions/12" })
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
})

afterEach(() => {
  outSpy.mockRestore()
  errSpy.mockRestore()
  logSpy.mockRestore()
  exitSpy.mockRestore()
})

function err(): string {
  return errSpy.mock.calls.map((c) => String(c[0])).join("")
}

describe("parseFeedbackArgs", () => {
  it("parses title/body/category", () => {
    expect(parseFeedbackArgs(["--title", "T", "--body", "B", "--category", "bugs"])).toEqual({
      help: false,
      title: "T",
      body: "B",
      category: "bugs",
    })
  })

  it("returns help for --help / -h / help", () => {
    expect(parseFeedbackArgs(["--help"]).help).toBe(true)
    expect(parseFeedbackArgs(["-h"]).help).toBe(true)
    expect(parseFeedbackArgs(["help"]).help).toBe(true)
  })

  it("rejects a flag missing its value with exit 2", () => {
    expect(() => parseFeedbackArgs(["--title"])).toThrow("exit 2")
    expect(err()).toContain("--title requires a value")
  })

  it("rejects an unexpected argument with exit 2", () => {
    expect(() => parseFeedbackArgs(["positional"])).toThrow("exit 2")
    expect(err()).toContain('unexpected argument "positional"')
  })
})

describe("runFeedbackSubcommand", () => {
  it("--help prints usage and submits nothing", async () => {
    await runFeedbackSubcommand(["--help"])
    expect(outSpy.mock.calls.join("")).toContain("Usage: kobe feedback")
    expect(mocks.submitFeedback).not.toHaveBeenCalled()
  })

  it("requires --title", async () => {
    await expect(runFeedbackSubcommand(["--body", "B"])).rejects.toThrow("exit 2")
    expect(err()).toContain("--title is required")
  })

  it("requires a body from --body or --body-file", async () => {
    await expect(runFeedbackSubcommand(["--title", "T"])).rejects.toThrow("exit 2")
    expect(err()).toContain("--body or --body-file is required")
  })

  it("rejects passing both --body and --body-file", async () => {
    await expect(runFeedbackSubcommand(["--title", "T", "--body", "B", "--body-file", "f"])).rejects.toThrow("exit 2")
    expect(err()).toContain("either --body or --body-file, not both")
  })

  it("submits title/body/category and prints the created Discussion", async () => {
    await runFeedbackSubcommand(["--title", "T", "--body", "B", "--category", "ideas"])
    expect(mocks.submitFeedback).toHaveBeenCalledWith({ title: "T", body: "B", categorySlug: "ideas" })
    expect(logSpy.mock.calls.join("")).toContain("created Discussion #12: https://github.com/x/y/discussions/12")
  })

  it("--body-file reads the body from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kobe-feedback-"))
    try {
      const file = join(dir, "body.md")
      writeFileSync(file, "from a file", "utf8")
      await runFeedbackSubcommand(["--title", "T", "--body-file", file])
      expect(mocks.submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ title: "T", body: "from a file" }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("submitFeedback (real module, scripted gh)", () => {
  async function realSubmit() {
    const actual = await vi.importActual<typeof import("../../src/lib/feedback.ts")>("../../src/lib/feedback.ts")
    return actual.submitFeedback
  }

  const categoriesReply = JSON.stringify({
    data: {
      repository: {
        id: "R_1",
        discussionCategories: {
          nodes: [{ id: "C_feedback", name: "Feedback", slug: "feedback" }],
        },
      },
    },
  })
  const createReply = JSON.stringify({
    data: { createDiscussion: { discussion: { number: 7, url: "https://github.com/o/r/discussions/7" } } },
  })

  it("resolves the category then creates the discussion via two gh graphql calls", async () => {
    const submit = await realSubmit()
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: categoriesReply, stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: createReply, stderr: "" })

    const result = submit(
      { title: "Bug title", body: "Bug body" },
      { spawn: spawn as never, repoSlug: () => "owner/repo" },
    )

    expect(result).toEqual({ number: 7, url: "https://github.com/o/r/discussions/7" })
    expect(spawn).toHaveBeenCalledTimes(2)
    const firstArgs = spawn.mock.calls[0][1] as string[]
    expect(firstArgs).toEqual(expect.arrayContaining(["api", "graphql", "-f", "owner=owner", "-f", "name=repo"]))
    const secondArgs = spawn.mock.calls[1][1] as string[]
    expect(secondArgs).toEqual(expect.arrayContaining(["-f", "repositoryId=R_1", "-f", "categoryId=C_feedback"]))
    const bodyArg = secondArgs.find((a) => a.startsWith("body="))
    expect(bodyArg).toContain("Bug body")
    expect(bodyArg).toContain("Submitted from kobe")
  })

  it("throws when the category slug does not exist", async () => {
    const submit = await realSubmit()
    const spawn = vi.fn().mockReturnValueOnce({ status: 0, stdout: categoriesReply, stderr: "" })
    expect(() =>
      submit({ title: "T", body: "B", categorySlug: "nope" }, { spawn: spawn as never, repoSlug: () => "o/r" }),
    ).toThrow("GitHub Discussion category not found: nope")
  })

  it("surfaces gh graphql errors by message", async () => {
    const submit = await realSubmit()
    const spawn = vi.fn().mockReturnValueOnce({
      status: 1,
      stdout: JSON.stringify({ errors: [{ message: "Bad credentials" }] }),
      stderr: "",
    })
    expect(() => submit({ title: "T", body: "B" }, { spawn: spawn as never, repoSlug: () => "o/r" })).toThrow(
      "Bad credentials",
    )
  })

  it("throws when the package repo is not a GitHub repository", async () => {
    const submit = await realSubmit()
    expect(() => submit({ title: "T", body: "B" }, { spawn: vi.fn() as never, repoSlug: () => null })).toThrow(
      "package repository is not a GitHub repository",
    )
  })

  it("rejects a blank title/body before spawning anything", async () => {
    const submit = await realSubmit()
    const spawn = vi.fn()
    expect(() => submit({ title: "  ", body: "B" }, { spawn: spawn as never, repoSlug: () => "o/r" })).toThrow(
      "feedback title is required",
    )
    expect(spawn).not.toHaveBeenCalled()
  })
})
