import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import {
  ImeAnchorController,
  createImeAnchoredOutput,
  installRendererResizeForwarder,
} from "../../src/tui/lib/ime-anchor-output"

const SYNC_START = "\x1b[?2026h"
const SYNC_END = "\x1b[?2026l"
const HIDE_CURSOR = "\x1b[?25l"

function collectingOutput() {
  const chunks: Buffer[] = []
  const output = {
    columns: 80,
    rows: 24,
    isTTY: true,
    write(
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      maybeCallback?: (error?: Error | null) => void,
    ): boolean {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk))
      const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback
      callback?.(null)
      return true
    },
  } as unknown as NodeJS.WriteStream
  return {
    output,
    text: () => Buffer.concat(chunks).toString("utf8"),
  }
}

describe("ImeAnchorController", () => {
  it("lets only the current owner clear the shared anchor", () => {
    const controller = new ImeAnchorController()
    const oldPane = Symbol("old-pane")
    const focusedPane = Symbol("focused-pane")

    controller.claim(oldPane, { x: 3, y: 2 })
    controller.claim(focusedPane, { x: 7, y: 5 })

    expect(controller.release(oldPane)).toBe(false)
    expect(controller.current()).toEqual({ x: 7, y: 5 })
    expect(controller.release(focusedPane)).toBe(true)
    expect(controller.current()).toBeNull()
  })

  it("stores renderer screen coordinates as zero-based values", () => {
    const controller = new ImeAnchorController()

    controller.claim(Symbol("terminal"), { x: 0, y: 0 })

    expect(controller.current()).toEqual({ x: 0, y: 0 })
  })
})

describe("createImeAnchoredOutput", () => {
  it("passes renderer bytes through unchanged while no terminal owns the anchor", () => {
    const sink = collectingOutput()
    const controller = new ImeAnchorController()
    const anchored = createImeAnchoredOutput(sink.output, controller)
    const frame = `${SYNC_START}${HIDE_CURSOR}\x1b[2;3HA${SYNC_END}`

    anchored.stdout.write(frame)
    anchored.flush()

    expect(sink.text()).toBe(frame)
  })

  it("ends every animated diff frame at the same hidden IME anchor", () => {
    const sink = collectingOutput()
    const controller = new ImeAnchorController()
    const anchored = createImeAnchoredOutput(sink.output, controller)
    controller.claim(Symbol("terminal"), { x: 6, y: 4 })

    const leftFrame = `${SYNC_START}${HIDE_CURSOR}\x1b[2;3HL${SYNC_END}`
    const rightFrame = `${SYNC_START}${HIDE_CURSOR}\x1b[9;16HR${SYNC_END}`
    anchored.stdout.write(leftFrame)
    anchored.stdout.write(rightFrame)
    anchored.flush()

    const expectedAnchor = `\x1b[5;7H${HIDE_CURSOR}${SYNC_END}`
    expect(sink.text()).toBe(leftFrame.replace(SYNC_END, expectedAnchor) + rightFrame.replace(SYNC_END, expectedAnchor))
  })

  it("recognizes a synchronized-frame terminator split at every byte boundary", () => {
    const framePrefix = `${SYNC_START}${HIDE_CURSOR}\x1b[9;16HR`

    for (let split = 1; split < SYNC_END.length; split += 1) {
      const sink = collectingOutput()
      const controller = new ImeAnchorController()
      const anchored = createImeAnchoredOutput(sink.output, controller)
      controller.claim(Symbol(`terminal-${split}`), { x: 6, y: 4 })

      anchored.stdout.write(Buffer.from(framePrefix + SYNC_END.slice(0, split)))
      anchored.stdout.write(Buffer.from(SYNC_END.slice(split)))
      anchored.flush()

      expect(sink.text(), `split=${split}`).toBe(`${framePrefix}\x1b[5;7H${HIDE_CURSOR}${SYNC_END}`)
    }
  })

  it("flushes an incomplete terminator prefix without inventing a frame end", () => {
    const sink = collectingOutput()
    const controller = new ImeAnchorController()
    const anchored = createImeAnchoredOutput(sink.output, controller)
    controller.claim(Symbol("terminal"), { x: 6, y: 4 })

    anchored.stdout.write(`plain${SYNC_END.slice(0, 4)}`)
    anchored.flush()

    expect(sink.text()).toBe(`plain${SYNC_END.slice(0, 4)}`)
  })
})

describe("installRendererResizeForwarder", () => {
  it("forwards SIGWINCH using the real terminal size and removes its listener", () => {
    const signals = new EventEmitter()
    const resize = vi.fn()
    const terminal = { columns: 132, rows: 43 }
    const remove = installRendererResizeForwarder(
      { resize },
      terminal,
      signals as unknown as Pick<NodeJS.Process, "on" | "removeListener">,
    )

    signals.emit("SIGWINCH")
    expect(resize).toHaveBeenCalledWith(132, 43)

    remove()
    signals.emit("SIGWINCH")
    expect(resize).toHaveBeenCalledTimes(1)
  })
})
