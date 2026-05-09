/**
 * Type-level tests for src/types/worktree.ts.
 */
import { describe, expectTypeOf, it } from "vitest"
import type { WorktreeInfo, WorktreeManager } from "../../src/types/worktree.ts"

describe("WorktreeInfo", () => {
  it("has the four documented readonly fields", () => {
    expectTypeOf<WorktreeInfo["path"]>().toEqualTypeOf<string>()
    expectTypeOf<WorktreeInfo["branch"]>().toEqualTypeOf<string>()
    expectTypeOf<WorktreeInfo["head"]>().toEqualTypeOf<string>()
    expectTypeOf<WorktreeInfo["dirty"]>().toEqualTypeOf<boolean>()
  })

  it("rejects excess properties", () => {
    const _good: WorktreeInfo = { path: "/p", branch: "b", head: "abc", dirty: false }
    void _good
    // @ts-expect-error — `extra` is not part of WorktreeInfo
    const _bad: WorktreeInfo = { ..._good, extra: 1 }
    void _bad
  })
})

describe("WorktreeManager", () => {
  it("exposes the five documented methods", () => {
    expectTypeOf<keyof WorktreeManager>().toEqualTypeOf<"create" | "remove" | "list" | "isDirty" | "currentBranch">()
  })

  it("create returns Promise<WorktreeInfo>", () => {
    expectTypeOf<WorktreeManager["create"]>().parameters.toEqualTypeOf<[string, string, string]>()
    expectTypeOf<WorktreeManager["create"]>().returns.toEqualTypeOf<Promise<WorktreeInfo>>()
  })

  it("remove takes optional force flag", () => {
    expectTypeOf<WorktreeManager["remove"]>().parameters.toEqualTypeOf<[string, { readonly force?: boolean }?]>()
    expectTypeOf<WorktreeManager["remove"]>().returns.toEqualTypeOf<Promise<void>>()
  })

  it("list returns readonly snapshot", () => {
    expectTypeOf<WorktreeManager["list"]>().returns.toEqualTypeOf<Promise<readonly WorktreeInfo[]>>()
  })

  it("isDirty returns Promise<boolean>", () => {
    expectTypeOf<WorktreeManager["isDirty"]>().parameters.toEqualTypeOf<[string]>()
    expectTypeOf<WorktreeManager["isDirty"]>().returns.toEqualTypeOf<Promise<boolean>>()
  })

  it("currentBranch returns Promise<string>", () => {
    expectTypeOf<WorktreeManager["currentBranch"]>().parameters.toEqualTypeOf<[string]>()
    expectTypeOf<WorktreeManager["currentBranch"]>().returns.toEqualTypeOf<Promise<string>>()
  })

  it("a structurally compatible impl is assignable", () => {
    class Impl implements WorktreeManager {
      async create(_repo: string, branch: string, path: string): Promise<WorktreeInfo> {
        return { path, branch, head: "0".repeat(40), dirty: false }
      }
      async remove(_path: string, _opts?: { readonly force?: boolean }): Promise<void> {}
      async list(_repo: string): Promise<readonly WorktreeInfo[]> {
        return []
      }
      async isDirty(_path: string): Promise<boolean> {
        return false
      }
      async currentBranch(_path: string): Promise<string> {
        return "main"
      }
    }
    expectTypeOf<Impl>().toMatchTypeOf<WorktreeManager>()
  })
})
