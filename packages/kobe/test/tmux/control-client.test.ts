/**
 * Unit tests for `TmuxControlClient`. The tmux subprocess is faked
 * via `_mock.ts` so we don't need an actual tmux binary; we feed
 * canned protocol output in and assert on what the client writes
 * back on stdin plus which typed events it emits.
 */

import { describe, expect, it } from "vitest"
import { type SpawnControlClientOptions, TmuxCommandError, TmuxControlClient } from "../../src/tmux/control-client.ts"
import type { TmuxEvent } from "../../src/tmux/protocol-parser.ts"
import { makeMockTmuxChild, writesAsText } from "./_mock.ts"

function makeClient(opts: Partial<SpawnControlClientOptions> = {}) {
  const mock = makeMockTmuxChild()
  const client = new TmuxControlClient({ session: "test", ...opts })
  client.attachTo(mock.child)
  return { client, mock }
}

describe("TmuxControlClient — send/response", () => {
  it("writes the command to stdin terminated by \\n and resolves with the response body", async () => {
    const { client, mock } = makeClient()
    const pending = client.send("display-message", "hi")
    await Promise.resolve() // let the write hit the sink
    expect(writesAsText(mock.stdinChunks)).toBe("display-message hi\n")

    mock.simulateOutput("%begin 1700 1 0\nhello back\n%end 1700 1 0\n")
    await expect(pending).resolves.toEqual(["hello back"])
  })

  it("resolves two interleaved sends in FIFO order as their %end blocks arrive", async () => {
    const { client, mock } = makeClient()
    const a = client.send("first-cmd")
    const b = client.send("second-cmd")
    await Promise.resolve()
    expect(writesAsText(mock.stdinChunks)).toBe("first-cmd\nsecond-cmd\n")

    mock.simulateOutput("%begin 1 1 0\nA body\n%end 1 1 0\n")
    mock.simulateOutput("%begin 2 2 0\nB body\n%end 2 2 0\n")
    await expect(a).resolves.toEqual(["A body"])
    await expect(b).resolves.toEqual(["B body"])
  })

  it("rejects the in-flight promise with TmuxCommandError carrying the error body", async () => {
    const { client, mock } = makeClient()
    const pending = client.send("kill-pane", "-t", "%999")
    await Promise.resolve()

    mock.simulateOutput("%begin 1 1 0\nno such pane: %999\n%error 1 1 0\n")
    await expect(pending).rejects.toBeInstanceOf(TmuxCommandError)
    await pending.catch((err: TmuxCommandError) => {
      expect(err.message).toContain("no such pane: %999")
      expect(err.cmdLine.trim()).toBe("kill-pane -t %999")
      expect(err.body).toEqual(["no such pane: %999"])
    })
  })

  it("ignores unsolicited response blocks (e.g. the connection handshake's cmd-num 0 block)", async () => {
    const { client, mock } = makeClient()
    let unsolicited: TmuxEvent | null = null
    client.on("unsolicited-response", (ev: TmuxEvent) => {
      unsolicited = ev
    })
    mock.simulateOutput("%begin 1 0 0\nconfig\n%end 1 0 0\n")
    await new Promise((r) => setImmediate(r))
    expect(unsolicited).not.toBeNull()

    const pending = client.send("display-message", "x")
    await Promise.resolve()
    mock.simulateOutput("%begin 1 1 0\nout\n%end 1 1 0\n")
    await expect(pending).resolves.toEqual(["out"])
  })
})

describe("TmuxControlClient — notifications", () => {
  it("re-emits parser notifications as typed events", async () => {
    const { client, mock } = makeClient()
    const seen: { name: string; payload: unknown }[] = []
    client.on("layout-change", (ev) => seen.push({ name: "layout-change", payload: ev }))
    client.on("window-close", (ev) => seen.push({ name: "window-close", payload: ev }))
    client.on("output", (ev) => seen.push({ name: "output", payload: ev }))

    mock.simulateOutput("%layout-change @1 abc abc 0\n")
    mock.simulateOutput("%window-close @1\n")
    mock.simulateOutput("%output %2 hi\n")
    await new Promise((r) => setImmediate(r))

    expect(seen.map((s) => s.name)).toEqual(["layout-change", "window-close", "output"])
  })

  it("emits close when the child exits and rejects pending sends with the exit reason", async () => {
    const { client, mock } = makeClient()
    let closeMeta: unknown = null
    client.on("close", (meta) => {
      closeMeta = meta
    })
    const pending = client.send("display-message", "still pending")
    await Promise.resolve()
    mock.simulateStderr("server exited\n")
    mock.simulateExit(0, "SIGTERM")
    await expect(pending).rejects.toBeInstanceOf(TmuxCommandError)
    await pending.catch((err: TmuxCommandError) => {
      expect(err.message).toContain("tmux exited before response")
    })
    expect(closeMeta).not.toBeNull()
  })
})

describe("TmuxControlClient — typed helpers", () => {
  it("splitWindow builds the right argv with direction, target, size, command", async () => {
    const { client, mock } = makeClient()
    void client.splitWindow({
      target: "%3",
      direction: "h",
      size: 20,
      command: "echo hi",
      detached: true,
    })
    await Promise.resolve()
    expect(writesAsText(mock.stdinChunks)).toBe('split-window -h -l 20 -d -t %3 "echo hi"\n')
  })

  it("killPane builds `kill-pane -t %N`", async () => {
    const { client, mock } = makeClient()
    void client.killPane({ target: "%5" })
    await Promise.resolve()
    expect(writesAsText(mock.stdinChunks)).toBe("kill-pane -t %5\n")
  })

  it("listPanes with target+format builds `list-panes -t @1 -F #{pane_id}`", async () => {
    const { client, mock } = makeClient()
    const pending = client.listPanes({ target: "@1", format: "#{pane_id}" })
    await Promise.resolve()
    expect(writesAsText(mock.stdinChunks)).toBe('list-panes -t @1 -F "#{pane_id}"\n')
    mock.simulateOutput("%begin 1 1 0\n%1\n%2\n%end 1 1 0\n")
    await expect(pending).resolves.toEqual(["%1", "%2"])
  })

  it("displayMessage quotes arguments with spaces", async () => {
    const { client, mock } = makeClient()
    void client.displayMessage({ message: "hello world" })
    await Promise.resolve()
    expect(writesAsText(mock.stdinChunks)).toBe('display-message "hello world"\n')
  })
})

describe("TmuxControlClient — dispose", () => {
  it("close() writes detach-client, closes stdin, and resolves once the child has exited", async () => {
    const { client, mock } = makeClient()
    const closed = client.close()
    // The simulated child must actually exit for close() to resolve;
    // schedule the exit on the next tick to mirror how a real tmux
    // child would reply to `detach-client`.
    setImmediate(() => mock.simulateExit(0))
    await closed
    expect(writesAsText(mock.stdinChunks)).toContain("detach-client\n")
  })
})
