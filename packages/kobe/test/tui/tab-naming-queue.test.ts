import { afterEach, describe, expect, it, vi } from "vitest"
import { TabNamingQueue, type TabNamingTarget } from "../../src/tui/workspace/tab-naming-queue"

const target = (n: number, sessionId = `session-${n}`): TabNamingTarget => ({
  tabId: `tab-${n}`,
  sessionId,
  vendor: "codex",
  trigger: "immediate",
})

afterEach(() => vi.useRealTimers())

describe("TabNamingQueue", () => {
  it("starts immediately and deduplicates repeated observations of one session", async () => {
    let resolveRead: (title: string) => void = () => {}
    const readTitle = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
    )
    const applyTitle = vi.fn()
    const queue = new TabNamingQueue({ readTitle, isCurrent: () => true, applyTitle })

    queue.enqueue([target(1)])
    queue.enqueue([target(1)])
    expect(readTitle).toHaveBeenCalledTimes(1)
    resolveRead("可读标题")
    await vi.waitFor(() => expect(applyTitle).toHaveBeenCalledWith(target(1), "可读标题"))
  })

  it("shares one resolved session title across tabs without another read", async () => {
    const readTitle = vi.fn().mockResolvedValue("共享会话标题")
    const applyTitle = vi.fn()
    const queue = new TabNamingQueue({ readTitle, isCurrent: () => true, applyTitle })

    queue.enqueue([target(1, "shared")])
    await vi.waitFor(() => expect(applyTitle).toHaveBeenCalledWith(target(1, "shared"), "共享会话标题"))
    queue.enqueue([target(2, "shared")])

    expect(readTitle).toHaveBeenCalledTimes(1)
    expect(applyTitle).toHaveBeenCalledWith(target(2, "shared"), "共享会话标题")
  })

  it("applies one in-flight session read to every tab that joins it", async () => {
    let resolveRead: (title: string) => void = () => {}
    const readTitle = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
    )
    const applyTitle = vi.fn()
    const queue = new TabNamingQueue({ readTitle, isCurrent: () => true, applyTitle })

    queue.enqueue([target(1, "shared")])
    queue.enqueue([target(2, "shared")])
    resolveRead("共享会话标题")
    await vi.waitFor(() => expect(applyTitle).toHaveBeenCalledTimes(2))

    expect(readTitle).toHaveBeenCalledTimes(1)
    expect(applyTitle).toHaveBeenCalledWith(target(1, "shared"), "共享会话标题")
    expect(applyTitle).toHaveBeenCalledWith(target(2, "shared"), "共享会话标题")
  })

  it("does not share cached titles across vendors", async () => {
    const codex = target(1, "same-id")
    const claude = { ...target(2, "same-id"), vendor: "claude" as const }
    const readTitle = vi.fn().mockResolvedValueOnce("Codex title").mockResolvedValueOnce("Claude title")
    const applyTitle = vi.fn()
    const queue = new TabNamingQueue({ readTitle, isCurrent: () => true, applyTitle })

    queue.enqueue([codex])
    await vi.waitFor(() => expect(applyTitle).toHaveBeenCalledWith(codex, "Codex title"))
    queue.enqueue([claude])
    await vi.waitFor(() => expect(applyTitle).toHaveBeenCalledWith(claude, "Claude title"))

    expect(readTitle).toHaveBeenCalledTimes(2)
  })

  it("caps concurrent history reads while draining many new tabs", async () => {
    const resolvers: Array<(title: string) => void> = []
    const readTitle = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const queue = new TabNamingQueue({ readTitle, isCurrent: () => true, applyTitle: vi.fn(), maxConcurrent: 3 })

    queue.enqueue([target(1), target(2), target(3), target(4), target(5)])
    expect(readTitle).toHaveBeenCalledTimes(3)
    resolvers[0]?.("one")
    await vi.waitFor(() => expect(readTitle).toHaveBeenCalledTimes(4))
  })

  it("retries an unwritten transcript with short backoff", async () => {
    vi.useFakeTimers()
    const readTitle = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("落盘后的标题")
    const applyTitle = vi.fn()
    const queue = new TabNamingQueue({
      readTitle,
      isCurrent: () => true,
      applyTitle,
      retryDelaysMs: [250],
    })

    queue.enqueue([target(1)])
    await vi.runAllTicks()
    expect(readTitle).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(249)
    expect(readTitle).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(readTitle).toHaveBeenCalledTimes(2)
    await vi.runAllTicks()
    expect(applyTitle).toHaveBeenCalledWith(target(1), "落盘后的标题")
  })

  it("honors the target engine's retry policy", async () => {
    vi.useFakeTimers()
    const readTitle = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("vendor title")
    const applyTitle = vi.fn()
    const queue = new TabNamingQueue({
      readTitle,
      isCurrent: () => true,
      applyTitle,
      retryDelaysMs: [9_999],
    })

    queue.enqueue([{ ...target(1), retryDelaysMs: [75] }])
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(74)
    expect(readTitle).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(readTitle).toHaveBeenCalledTimes(2)
    await vi.runAllTicks()
    expect(applyTitle).toHaveBeenCalledWith(expect.objectContaining({ tabId: "tab-1" }), "vendor title")
  })

  it("retries a failed history read and follows the configured backoff steps", async () => {
    vi.useFakeTimers()
    const readTitle = vi
      .fn()
      .mockRejectedValueOnce(new Error("not written"))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("第三次读到")
    const applyTitle = vi.fn()
    const queue = new TabNamingQueue({
      readTitle,
      isCurrent: () => true,
      applyTitle,
      retryDelaysMs: [250, 1_000],
    })

    queue.enqueue([target(1)])
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(250)
    expect(readTitle).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(readTitle).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(readTitle).toHaveBeenCalledTimes(3)
    await vi.runAllTicks()
    expect(applyTitle).toHaveBeenCalledWith(target(1), "第三次读到")
  })

  it("stops pending reads and retries without applying stale titles", async () => {
    vi.useFakeTimers()
    let resolveRead: (title: string) => void = () => {}
    const readTitle = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
    )
    const applyTitle = vi.fn()
    const queue = new TabNamingQueue({ readTitle, isCurrent: () => true, applyTitle, retryDelaysMs: [250] })

    queue.enqueue([target(1)])
    queue.stop()
    resolveRead("stale")
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(applyTitle).not.toHaveBeenCalled()
    expect(readTitle).toHaveBeenCalledTimes(1)
  })

  it("cancels a scheduled retry when stopped while waiting", async () => {
    vi.useFakeTimers()
    const readTitle = vi.fn().mockResolvedValue("")
    const queue = new TabNamingQueue({
      readTitle,
      isCurrent: () => true,
      applyTitle: vi.fn(),
      retryDelaysMs: [250],
    })

    queue.enqueue([target(1)])
    await vi.runAllTicks()
    queue.stop()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(readTitle).toHaveBeenCalledTimes(1)
  })

  it("does not apply a title when the running target changes session", async () => {
    let currentSession = "session-1"
    let resolveRead: (title: string) => void = () => {}
    const applyTitle = vi.fn()
    const queue = new TabNamingQueue({
      readTitle: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
      isCurrent: (item) => item.sessionId === currentSession,
      applyTitle,
    })

    queue.enqueue([target(1)])
    currentSession = "session-2"
    resolveRead("旧会话标题")
    await vi.waitFor(() => expect(applyTitle).not.toHaveBeenCalled())
  })

  it("drops a tab that changed session before its queued read starts", async () => {
    const live = new Set(["tab-1", "tab-2"])
    let releaseFirst: (title: string) => void = () => {}
    const readTitle = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseFirst = resolve
          }),
      )
      .mockResolvedValue("second")
    const applyTitle = vi.fn()
    const queue = new TabNamingQueue({
      readTitle,
      isCurrent: (item) => live.has(item.tabId),
      applyTitle,
      maxConcurrent: 1,
    })

    queue.enqueue([target(1), target(2)])
    live.delete("tab-2")
    releaseFirst("first")
    await vi.waitFor(() => expect(applyTitle).toHaveBeenCalledWith(target(1), "first"))
    expect(readTitle).toHaveBeenCalledTimes(1)
  })
})
