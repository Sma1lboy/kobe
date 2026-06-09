import type { spawnSync } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import { submitFeedback } from "../../src/lib/feedback.ts"

function ok(stdout: unknown) {
  return {
    status: 0,
    stdout: JSON.stringify(stdout),
    stderr: "",
    error: undefined,
  }
}

describe("submitFeedback", () => {
  it("creates a GitHub Discussion through gh GraphQL", () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce(
        ok({
          data: {
            repository: {
              id: "repo-id",
              discussionCategories: {
                nodes: [{ id: "cat-id", name: "General", slug: "general" }],
              },
            },
          },
        }),
      )
      .mockReturnValueOnce(
        ok({
          data: {
            createDiscussion: {
              discussion: {
                number: 42,
                url: "https://github.com/Sma1lboy/kobe/discussions/42",
              },
            },
          },
        }),
      ) as unknown as typeof spawnSync

    const result = submitFeedback(
      { title: "A small idea", body: "Please add the thing." },
      { spawn, repoSlug: () => "Sma1lboy/kobe" },
    )

    expect(result).toEqual({
      number: 42,
      url: "https://github.com/Sma1lboy/kobe/discussions/42",
    })
    expect(spawn).toHaveBeenCalledTimes(2)
    const secondArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as string[]
    expect(secondArgs).toContain("repositoryId=repo-id")
    expect(secondArgs).toContain("categoryId=cat-id")
    expect(secondArgs).toContain("title=A small idea")
    expect(secondArgs.some((arg) => arg.includes("Submitted from kobe"))).toBe(true)
  })

  it("fails clearly when the configured Discussion category is absent", () => {
    const spawn = vi.fn().mockReturnValueOnce(
      ok({
        data: {
          repository: {
            id: "repo-id",
            discussionCategories: {
              nodes: [{ id: "cat-id", name: "Ideas", slug: "ideas" }],
            },
          },
        },
      }),
    ) as unknown as typeof spawnSync

    expect(() =>
      submitFeedback(
        { title: "Bug", body: "Something happened.", categorySlug: "general" },
        { spawn, repoSlug: () => "Sma1lboy/kobe" },
      ),
    ).toThrow("GitHub Discussion category not found: general")
  })
})
