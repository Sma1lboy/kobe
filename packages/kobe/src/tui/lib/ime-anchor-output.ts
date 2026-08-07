/**
 * macOS IME cursor anchoring at the OpenTUI output boundary.
 *
 * OpenTUI restores a visible cursor after each diff frame, but a hidden
 * cursor is left at the last painted cell. macOS input methods use that real
 * terminal cursor for preedit/candidate placement. This adapter buffers each
 * synchronized update as one transaction and inserts the focused embedded
 * terminal's hidden cursor position immediately before its terminator. A
 * truncated frame is therefore discarded before any partial paint can reach
 * the outer terminal.
 */

const SYNC_START = Buffer.from("\x1b[?2026h")
const SYNC_END = Buffer.from("\x1b[?2026l")
const HIDE_CURSOR = "\x1b[?25l"

export interface ImeAnchor {
  readonly x: number
  readonly y: number
}

/** Single-owner state: stale split-pane cleanup cannot clear a newer claim. */
export class ImeAnchorController {
  private owner: symbol | null = null
  private anchor: ImeAnchor | null = null

  claim(owner: symbol, anchor: ImeAnchor): void {
    this.owner = owner
    this.anchor = {
      x: Math.max(0, Math.trunc(anchor.x)),
      y: Math.max(0, Math.trunc(anchor.y)),
    }
  }

  release(owner: symbol): boolean {
    if (this.owner !== owner) return false
    this.owner = null
    this.anchor = null
    return true
  }

  current(): ImeAnchor | null {
    return this.anchor
  }
}

export const imeAnchorController = new ImeAnchorController()

class ImeAnchorFrameTransformer {
  private pending = Buffer.alloc(0)
  private frame = Buffer.alloc(0)

  constructor(private readonly controller: ImeAnchorController) {}

  push(chunk: Buffer): Buffer {
    const data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk
    this.pending = Buffer.alloc(0)
    const output: Buffer[] = []
    let offset = 0

    while (offset < data.length) {
      if (this.frame.length === 0) {
        const start = data.indexOf(SYNC_START, offset)
        if (start < 0) {
          const tail = data.subarray(offset)
          const pendingLength = longestMarkerPrefixSuffix(tail, [SYNC_START])
          const safeLength = tail.length - pendingLength
          if (safeLength > 0) output.push(tail.subarray(0, safeLength))
          if (pendingLength > 0) this.pending = Buffer.from(tail.subarray(safeLength))
          break
        }

        if (start > offset) output.push(data.subarray(offset, start))
        this.frame = Buffer.from(SYNC_START)
        offset = start + SYNC_START.length
        continue
      }

      const end = data.indexOf(SYNC_END, offset)
      const restart = data.indexOf(SYNC_START, offset)
      if (restart >= 0 && (end < 0 || restart < end)) {
        // A new transaction means the prior one was truncated. Nothing from
        // it has reached the terminal, so discard it and recover at the new
        // frame boundary instead of exposing a half-painted screen.
        this.frame = Buffer.from(SYNC_START)
        offset = restart + SYNC_START.length
        continue
      }

      if (end >= 0) {
        if (end > offset) this.frame = Buffer.concat([this.frame, data.subarray(offset, end)])
        output.push(this.frame)
        const anchor = this.controller.current()
        // Renderer coordinates are zero-based; ANSI CUP rows/columns are one-based.
        if (anchor) output.push(Buffer.from(`\x1b[${anchor.y + 1};${anchor.x + 1}H${HIDE_CURSOR}`))
        output.push(SYNC_END)
        this.frame = Buffer.alloc(0)
        offset = end + SYNC_END.length
        continue
      }

      const tail = data.subarray(offset)
      const pendingLength = longestMarkerPrefixSuffix(tail, [SYNC_START, SYNC_END])
      const safeLength = tail.length - pendingLength
      if (safeLength > 0) this.frame = Buffer.concat([this.frame, tail.subarray(0, safeLength)])
      if (pendingLength > 0) this.pending = Buffer.from(tail.subarray(safeLength))
      break
    }

    return output.length > 0 ? Buffer.concat(output) : Buffer.alloc(0)
  }

  flush(): Buffer {
    // Never expose an incomplete synchronized update during teardown. The
    // terminal never saw its opener, so dropping it preserves the last fully
    // committed screen. A partial opener outside a frame is ordinary pending
    // output and still needs to be restored verbatim.
    if (this.frame.length > 0) {
      this.frame = Buffer.alloc(0)
      this.pending = Buffer.alloc(0)
      return Buffer.alloc(0)
    }
    const pending = this.pending
    this.pending = Buffer.alloc(0)
    return pending
  }
}

function longestMarkerPrefixSuffix(bytes: Buffer, markers: readonly Buffer[]): number {
  const max = Math.min(bytes.length, Math.max(...markers.map((marker) => marker.length - 1)))
  for (let length = max; length > 0; length -= 1) {
    const suffix = bytes.subarray(bytes.length - length)
    if (markers.some((marker) => length < marker.length && suffix.equals(marker.subarray(0, length)))) return length
  }
  return 0
}

function asBuffer(
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
): Buffer {
  if (typeof chunk !== "string") return Buffer.from(chunk)
  const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined
  return Buffer.from(chunk, encoding)
}

function writeCallback(
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  maybeCallback?: (error?: Error | null) => void,
): ((error?: Error | null) => void) | undefined {
  return typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback
}

export interface ImeAnchoredOutput {
  readonly stdout: NodeJS.WriteStream
  flush(): void
}

export interface HostImeOutput {
  readonly active: boolean
  readonly rendererOptions: Readonly<{ stdout?: NodeJS.WriteStream; remote?: false }>
  attach(renderer: { resize(width: number, height: number): void }): () => void
  flush(): void
}

/**
 * Return a TTY-compatible proxy whose distinct identity selects OpenTUI's
 * ordered NativeSpanFeed, while every property except `write` delegates to
 * the real terminal stream.
 */
export function createImeAnchoredOutput(
  target: NodeJS.WriteStream,
  controller: ImeAnchorController = imeAnchorController,
): ImeAnchoredOutput {
  const transformer = new ImeAnchorFrameTransformer(controller)
  const write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean => {
    const transformed = transformer.push(asBuffer(chunk, encodingOrCallback))
    const callback = writeCallback(encodingOrCallback, maybeCallback)
    if (transformed.length === 0) {
      if (callback) queueMicrotask(() => callback(null))
      return true
    }
    return callback ? target.write(transformed, callback) : target.write(transformed)
  }
  let exposedWrite: unknown = write

  const stdout = new Proxy(target, {
    get(stream, property) {
      if (property === "write") return exposedWrite
      const value = Reflect.get(stream, property, stream)
      return typeof value === "function" ? value.bind(stream) : value
    },
    set(stream, property, value) {
      if (property === "write") {
        exposedWrite = value
        return true
      }
      return Reflect.set(stream, property, value, stream)
    },
  }) as NodeJS.WriteStream

  return {
    stdout,
    flush() {
      const pending = transformer.flush()
      if (pending.length > 0) target.write(pending)
    },
  }
}

/** Select the custom output path only for the affected fullscreen macOS TUI. */
export function createHostImeOutput(opts: {
  readonly platform: NodeJS.Platform
  readonly fullscreen: boolean
  readonly stdout: NodeJS.WriteStream
  readonly controller?: ImeAnchorController
}): HostImeOutput {
  if (opts.platform !== "darwin" || !opts.fullscreen) {
    return {
      active: false,
      rendererOptions: {},
      attach: () => () => {},
      flush: () => {},
    }
  }

  const output = createImeAnchoredOutput(opts.stdout, opts.controller)
  return {
    active: true,
    rendererOptions: { stdout: output.stdout, remote: false },
    attach: (renderer) => installRendererResizeForwarder(renderer, opts.stdout),
    flush: () => output.flush(),
  }
}

/** Restore the resize handling OpenTUI omits when stdout is a custom stream. */
export function installRendererResizeForwarder(
  renderer: { resize(width: number, height: number): void },
  terminal: Pick<NodeJS.WriteStream, "columns" | "rows">,
  signals: Pick<NodeJS.Process, "on" | "removeListener"> = process,
): () => void {
  const onResize = (): void => {
    const width = terminal.columns
    const height = terminal.rows
    if (!width || !height) return
    renderer.resize(width, height)
  }
  signals.on("SIGWINCH", onResize)
  return () => signals.removeListener("SIGWINCH", onResize)
}
