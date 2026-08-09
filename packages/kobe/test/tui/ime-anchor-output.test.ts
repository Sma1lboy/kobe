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
  it("isolates renderer write reassignment from the real terminal stream", () => {
    const sink = collectingOutput()
    const originalWrite = sink.output.write
    const anchored = createImeAnchoredOutput(sink.output, new ImeAnchorController())
    const adapterWrite = anchored.stdout.write.bind(anchored.stdout)
    const rendererWrite = vi.fn(() => true) as unknown as NodeJS.WriteStream["write"]

    anchored.stdout.write = rendererWrite

    expect(anchored.stdout.write).toBe(rendererWrite)
    expect(sink.output.write).toBe(originalWrite)
    adapterWrite("frame")
    expect(sink.text()).toBe("frame")
  })

  it("passes renderer bytes through unchanged while no terminal owns the anchor", () => {
    const sink = collectingOutput()
    const controller = new ImeAnchorController()
    const anchored = createImeAnchoredOutput(sink.output, controller)
    const frame = `${SYNC_START}${HIDE_CURSOR}\x1b[2;3HA${SYNC_END}`

    anchored.stdout.write(frame)
    anchored.flush()

    expect(sink.text()).toBe(frame)
  })

  it("withholds a synchronized update until the complete frame can be written atomically", () => {
    const sink = collectingOutput()
    const anchored = createImeAnchoredOutput(sink.output, new ImeAnchorController())

    anchored.stdout.write(`${SYNC_START}${HIDE_CURSOR}\x1b[2;3HA`)
    expect(sink.text()).toBe("")

    anchored.stdout.write(SYNC_END)
    expect(sink.text()).toBe(`${SYNC_START}${HIDE_CURSOR}\x1b[2;3HA${SYNC_END}`)
  })

  it("recognizes a synchronized-frame opener split at every byte boundary", () => {
    for (let split = 1; split < SYNC_START.length; split += 1) {
      const sink = collectingOutput()
      const anchored = createImeAnchoredOutput(sink.output, new ImeAnchorController())

      anchored.stdout.write(Buffer.from(`plain${SYNC_START.slice(0, split)}`))
      anchored.stdout.write(Buffer.from(`${SYNC_START.slice(split)}frame${SYNC_END}`))
      anchored.flush()

      expect(sink.text(), `split=${split}`).toBe(`plain${SYNC_START}frame${SYNC_END}`)
    }
  })

  it("drops a truncated update when a fresh synchronized frame starts", () => {
    const sink = collectingOutput()
    const anchored = createImeAnchoredOutput(sink.output, new ImeAnchorController())
    const complete = `${SYNC_START}\x1b[4;5Hnew${SYNC_END}`

    anchored.stdout.write(`${SYNC_START}\x1b[2;3Hstale`)
    anchored.stdout.write(complete)

    expect(sink.text()).toBe(complete)
  })

  it("keeps a high-churn sequence complete across rotating chunk boundaries", () => {
    const sink = collectingOutput()
    const anchored = createImeAnchoredOutput(sink.output, new ImeAnchorController())
    const expected: string[] = []

    for (let frame = 0; frame < 250; frame += 1) {
      const transaction = `${SYNC_START}\x1b[${(frame % 40) + 1};1Hframe-${frame}${SYNC_END}`
      expected.push(transaction)
      for (let offset = 0; offset < transaction.length; ) {
        const width = (frame + offset) % 11 || 1
        anchored.stdout.write(transaction.slice(offset, offset + width))
        offset += width
      }
    }

    anchored.flush()
    expect(sink.text()).toBe(expected.join(""))
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

  it("drops an incomplete synchronized update on flush", () => {
    const sink = collectingOutput()
    const controller = new ImeAnchorController()
    const anchored = createImeAnchoredOutput(sink.output, controller)
    controller.claim(Symbol("terminal"), { x: 6, y: 4 })

    anchored.stdout.write(`${SYNC_START}plain${SYNC_END.slice(0, 4)}`)
    anchored.flush()

    expect(sink.text()).toBe("")
  })

  it("flushes a partial frame opener outside a transaction verbatim", () => {
    const sink = collectingOutput()
    const anchored = createImeAnchoredOutput(sink.output, new ImeAnchorController())

    anchored.stdout.write(`plain${SYNC_START.slice(0, 4)}`)
    anchored.flush()

    expect(sink.text()).toBe(`plain${SYNC_START.slice(0, 4)}`)
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
