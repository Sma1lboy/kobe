/**
 * The React-free core of the Create-PR action (`createPRAction`): the
 * target-branch toast and both stale-continuation identity guards. Git IO
 * is injected, so these pin the control flow, not the prompt content.
 */

import { describe, expect, test } from "vitest"
import { createPRAction } from "../../src/tui-react/workspace/use-create-pr"

type Sent = string[]

function deps(over: Partial<Parameters<typeof createPRAction>[0]> = {}) {
  const sent: Sent = []
  const errors: string[] = []
  const send = (text: string) => void sent.push(text)
  const base = {
    worktree: "/wt/a",
    sendToEngineFn: { current: send },
    selectedWorktreeRef: { current: "/wt/a" },
    notifyError: (message: string) => void errors.push(message),
    t: (key: string) => key,
    gather: async () => ({ branch: "feat/x", targetBranch: "main" }) as never,
    build: async () => "PR PROMPT",
    ...over,
  }
  return { base, sent, errors }
}

describe("createPRAction", () => {
  test("sends the built prompt into the live session", async () => {
    const { base, sent, errors } = deps()
    await createPRAction(base)()
    expect(sent).toEqual(["PR PROMPT"])
    expect(errors).toEqual([])
  })

  test("toasts instead of sending when already on the target branch", async () => {
    const { base, sent, errors } = deps({
      gather: async () => ({ branch: "main", targetBranch: "main" }) as never,
    })
    await createPRAction(base)()
    expect(sent).toEqual([])
    expect(errors).toEqual(["files.toast.prOnTargetBranch"])
  })

  test("drops a stale continuation when the selected worktree changed mid-await", async () => {
    const { base, sent } = deps()
    const selectedWorktreeRef = { current: "/wt/a" }
    const action = createPRAction({
      ...base,
      selectedWorktreeRef,
      gather: async () => {
        selectedWorktreeRef.current = "/wt/OTHER"
        return { branch: "feat/x", targetBranch: "main" } as never
      },
    })
    await action()
    expect(sent).toEqual([])
  })

  test("drops a stale continuation when the terminal mount behind the ref changed", async () => {
    const { base, sent } = deps()
    const action = createPRAction({
      ...base,
      build: async () => {
        base.sendToEngineFn.current = () => {}
        return "PR PROMPT"
      },
    })
    await action()
    expect(sent).toEqual([])
  })

  test("no-ops without a worktree or a live session", async () => {
    const a = deps({ worktree: null })
    await createPRAction(a.base)()
    const b = deps({ sendToEngineFn: { current: null } })
    await createPRAction(b.base)()
    expect(a.sent).toEqual([])
    expect(b.sent).toEqual([])
  })
})
