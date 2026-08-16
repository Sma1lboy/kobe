/**
 * Issue #25 wiring: a hosted engine tab whose spawn carries `firstMessage`
 * (paste-delivery vendor — kimi's positional argv slot is a subcommand, so
 * the prompt can't ride the launch line) must hand it to
 * `pastePromptWhenEngineUp` on a FRESH spawn only. A reattach to an
 * already-running session must NOT redeliver it — the same fresh-only rule
 * `initialInput` already follows.
 *
 * The pty-host socket is mocked (the engine/paste mechanics themselves are
 * pinned in test/engine/hosted-session.test.ts); `KOBE_HOME_DIR` isolates
 * the scrollback preference read.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  paste: vi.fn(async () => true),
  request: vi.fn(),
}))

vi.mock("../../src/engine/hosted-session.ts", () => ({ pastePromptWhenEngineUp: mocks.paste }))
vi.mock("../../src/tui/panes/terminal/pty-hosted-client.ts", () => ({
  getSharedPtyClient: async () => ({ request: mocks.request, onLifecycle: () => () => {} }),
  routeAdd: () => {},
  routeRemove: () => {},
  routeCount: () => 1,
  warmHostedShell: () => {},
}))

import { HostedTaskPty } from "../../src/tui/panes/terminal/pty-hosted.ts"

let tmpHome: string
let originalHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-pty-hosted-fm-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
  mocks.paste.mockClear()
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function openWith(result: unknown): void {
  mocks.request.mockImplementation((name: string) => {
    if (name === "pty.open") return Promise.resolve(result)
    return Promise.resolve({})
  })
}

describe("HostedTaskPty first-message paste (issue #25)", () => {
  it("hands firstMessage to pastePromptWhenEngineUp on a fresh spawn", async () => {
    openWith({ alive: true, created: true, replay: "", pid: 42, offset: 0 })
    const pty = new HostedTaskPty({
      taskId: "task-1::tab-1",
      cwd: "/repo/wt",
      command: ["kimi"],
      firstMessage: "fix it",
      engineBin: "kimi",
      cols: 60,
      rows: 12,
    })
    await vi.waitFor(() => expect(mocks.paste).toHaveBeenCalledOnce())
    expect(mocks.paste).toHaveBeenCalledWith(expect.anything(), "task-1::tab-1", "kimi", "fix it")
    pty.detach()
  })

  it("does NOT redeliver on a reattach to an existing session", async () => {
    openWith({ alive: true, created: false, replay: "", pid: 42, offset: 0 })
    const pty = new HostedTaskPty({
      taskId: "task-1::tab-1",
      cwd: "/repo/wt",
      command: ["kimi"],
      firstMessage: "fix it",
      engineBin: "kimi",
      cols: 60,
      rows: 12,
    })
    // Let the open settle; the paste must never fire.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.paste).not.toHaveBeenCalled()
    pty.detach()
  })

  it("does nothing when the spawn carries no firstMessage (argv vendors)", async () => {
    openWith({ alive: true, created: true, replay: "", pid: 42, offset: 0 })
    const pty = new HostedTaskPty({ taskId: "task-1::tab-1", cwd: "/repo/wt", command: ["claude"], cols: 60, rows: 12 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.paste).not.toHaveBeenCalled()
    pty.detach()
  })
})
