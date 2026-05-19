/**
 * Pure stateful parser for the tmux -CC ("control mode") line protocol.
 *
 * Used by `control-client.ts` to turn the raw byte stream coming from a
 * `tmux -CC` subprocess into typed events the daemon can react to.
 * Library code only: no I/O, no timers, no process spawning. Drive it
 * with `feed(chunk)` and either consume the returned `TmuxEvent[]` or
 * subscribe via `setVisitor(...)`.
 *
 * Protocol shape (man tmux, CONTROL MODE):
 *
 *   - Output is line-based, `\n`-terminated. Lines arrive split across
 *     chunks; the parser buffers a trailing partial line until the next
 *     `feed()` call.
 *   - A "response block" begins with `%begin <unix-seconds> <cmd-num>
 *     <flags>`, followed by zero or more body lines that are the literal
 *     stdout/err of the tmux command being run, terminated by `%end ...`
 *     (success) or `%error ...` (failure). Body lines inside the block
 *     are NOT re-parsed as notifications even if they start with `%`.
 *   - Outside a block, any line starting with `%` is a notification
 *     (`%output`, `%layout-change`, `%window-close`, …).
 *
 * Octal escapes: `%output` and `%extended-output` payloads encode each
 * non-printable byte (and `\\` itself) as `\` followed by three octal
 * digits. The payload field is decoded back to a `Uint8Array` because
 * the underlying pty produces arbitrary bytes, not a UTF-8 stream.
 *
 * Unknown notification names emit `{ type: "unknown", line }` rather
 * than throwing — tmux occasionally adds new `%foo` notifications, and
 * the daemon should keep running on unrecognized lines instead of
 * dying.
 */

export type TmuxEvent =
  | {
      readonly type: "response"
      readonly commandNumber: number
      readonly success: boolean
      readonly body: readonly string[]
      readonly flags: string
      readonly timestamp: number
    }
  | { readonly type: "output"; readonly paneId: string; readonly data: Uint8Array }
  | {
      readonly type: "extended-output"
      readonly paneId: string
      readonly age: number
      readonly extra: readonly string[]
      readonly data: Uint8Array
    }
  | { readonly type: "session-window-changed"; readonly sessionId: string; readonly windowId: string }
  | { readonly type: "window-add"; readonly windowId: string }
  | { readonly type: "window-close"; readonly windowId: string }
  | { readonly type: "window-renamed"; readonly windowId: string; readonly name: string }
  | { readonly type: "window-pane-changed"; readonly windowId: string; readonly paneId: string }
  | { readonly type: "unlinked-window-add"; readonly windowId: string }
  | { readonly type: "unlinked-window-close"; readonly windowId: string }
  | { readonly type: "unlinked-window-renamed"; readonly windowId: string; readonly name: string }
  | {
      readonly type: "layout-change"
      readonly windowId: string
      readonly layout: string
      readonly visibleLayout: string
      readonly flags: string
    }
  | { readonly type: "session-changed"; readonly sessionId: string; readonly name: string }
  | { readonly type: "session-renamed"; readonly name: string }
  | { readonly type: "sessions-changed" }
  | {
      readonly type: "client-session-changed"
      readonly client: string
      readonly sessionId: string
      readonly name: string
    }
  | { readonly type: "client-detached"; readonly client: string }
  | { readonly type: "pane-mode-changed"; readonly paneId: string }
  | { readonly type: "continue"; readonly paneId: string }
  | { readonly type: "pause"; readonly paneId: string }
  | { readonly type: "paste-buffer-changed"; readonly name: string }
  | { readonly type: "paste-buffer-deleted"; readonly name: string }
  | { readonly type: "message"; readonly message: string }
  | { readonly type: "config-error"; readonly error: string }
  | { readonly type: "exit"; readonly reason: string | null }
  | {
      readonly type: "subscription-changed"
      readonly name: string
      readonly sessionId: string
      readonly windowId: string
      readonly windowIndex: string
      readonly paneId: string
      readonly extra: readonly string[]
      readonly data: Uint8Array
    }
  | { readonly type: "unknown"; readonly line: string }

export type TmuxEventType = TmuxEvent["type"]

export type TmuxEventVisitor = (event: TmuxEvent) => void

export class TmuxProtocolParser {
  private buffer = ""
  private inBlock = false
  private blockCmd = 0
  private blockFlags = ""
  private blockTs = 0
  private blockBody: string[] = []
  private visitor: TmuxEventVisitor | null = null

  setVisitor(visitor: TmuxEventVisitor | null): void {
    this.visitor = visitor
  }

  feed(chunk: string | Uint8Array | Buffer): TmuxEvent[] {
    const text = typeof chunk === "string" ? chunk : bytesToLatin1(chunk)
    this.buffer += text
    const events: TmuxEvent[] = []
    while (true) {
      const i = this.buffer.indexOf("\n")
      if (i < 0) break
      let line = this.buffer.slice(0, i)
      if (line.endsWith("\r")) line = line.slice(0, -1)
      this.buffer = this.buffer.slice(i + 1)
      this.consumeLine(line, events)
    }
    return events
  }

  reset(): void {
    this.buffer = ""
    this.inBlock = false
    this.blockBody = []
    this.blockCmd = 0
    this.blockFlags = ""
    this.blockTs = 0
  }

  /** Currently buffered (incomplete) trailing line, for debugging. */
  pendingBuffer(): string {
    return this.buffer
  }

  private consumeLine(line: string, out: TmuxEvent[]): void {
    if (this.inBlock) {
      if (line === "%end" || line.startsWith("%end ")) {
        this.emit(
          {
            type: "response",
            commandNumber: this.blockCmd,
            success: true,
            body: this.blockBody,
            flags: this.blockFlags,
            timestamp: this.blockTs,
          },
          out,
        )
        this.inBlock = false
        this.blockBody = []
        return
      }
      if (line === "%error" || line.startsWith("%error ")) {
        this.emit(
          {
            type: "response",
            commandNumber: this.blockCmd,
            success: false,
            body: this.blockBody,
            flags: this.blockFlags,
            timestamp: this.blockTs,
          },
          out,
        )
        this.inBlock = false
        this.blockBody = []
        return
      }
      this.blockBody.push(line)
      return
    }
    if (line.startsWith("%begin")) {
      const rest = line.slice("%begin".length).trim()
      const args = rest.length > 0 ? rest.split(/\s+/) : []
      this.blockTs = toInt(args[0])
      this.blockCmd = toInt(args[1])
      this.blockFlags = args[2] ?? ""
      this.inBlock = true
      this.blockBody = []
      return
    }
    if (line.length === 0) return
    if (line.startsWith("%")) {
      this.emit(parseNotification(line), out)
      return
    }
    this.emit({ type: "unknown", line }, out)
  }

  private emit(event: TmuxEvent, out: TmuxEvent[]): void {
    out.push(event)
    this.visitor?.(event)
  }
}

function parseNotification(line: string): TmuxEvent {
  const [head, rest] = splitFirst(line, " ")
  const name = head.startsWith("%") ? head.slice(1) : head
  switch (name) {
    case "output": {
      const [paneId, value] = splitFirst(rest, " ")
      return { type: "output", paneId, data: decodeOctalPayload(value) }
    }
    case "extended-output": {
      return parseExtendedOutput(rest, line)
    }
    case "session-window-changed": {
      const [sessionId, windowId] = splitFirst(rest, " ")
      return { type: "session-window-changed", sessionId, windowId: trimOrEmpty(windowId) }
    }
    case "window-add":
      return { type: "window-add", windowId: rest }
    case "window-close":
      return { type: "window-close", windowId: rest }
    case "window-renamed": {
      const [windowId, n] = splitFirst(rest, " ")
      return { type: "window-renamed", windowId, name: n }
    }
    case "window-pane-changed": {
      const [windowId, paneId] = splitFirst(rest, " ")
      return { type: "window-pane-changed", windowId, paneId }
    }
    case "unlinked-window-add":
      return { type: "unlinked-window-add", windowId: rest }
    case "unlinked-window-close":
      return { type: "unlinked-window-close", windowId: rest }
    case "unlinked-window-renamed": {
      const [windowId, n] = splitFirst(rest, " ")
      return { type: "unlinked-window-renamed", windowId, name: n }
    }
    case "layout-change": {
      const parts = rest.split(/\s+/)
      const windowId = parts[0] ?? ""
      const layout = parts[1] ?? ""
      const visibleLayout = parts[2] ?? ""
      const flags = parts[3] ?? ""
      return { type: "layout-change", windowId, layout, visibleLayout, flags }
    }
    case "session-changed": {
      const [sessionId, n] = splitFirst(rest, " ")
      return { type: "session-changed", sessionId, name: n }
    }
    case "session-renamed":
      return { type: "session-renamed", name: rest }
    case "sessions-changed":
      return { type: "sessions-changed" }
    case "client-session-changed": {
      const [client, after1] = splitFirst(rest, " ")
      const [sessionId, n] = splitFirst(after1, " ")
      return { type: "client-session-changed", client, sessionId, name: n }
    }
    case "client-detached":
      return { type: "client-detached", client: rest }
    case "pane-mode-changed":
      return { type: "pane-mode-changed", paneId: rest }
    case "continue":
      return { type: "continue", paneId: rest }
    case "pause":
      return { type: "pause", paneId: rest }
    case "paste-buffer-changed":
      return { type: "paste-buffer-changed", name: rest }
    case "paste-buffer-deleted":
      return { type: "paste-buffer-deleted", name: rest }
    case "message":
      return { type: "message", message: rest }
    case "config-error":
      return { type: "config-error", error: rest }
    case "exit":
      return { type: "exit", reason: rest.length > 0 ? rest : null }
    case "subscription-changed":
      return parseSubscriptionChanged(rest, line)
    default:
      return { type: "unknown", line }
  }
}

function parseExtendedOutput(rest: string, line: string): TmuxEvent {
  const sepIdx = rest.indexOf(" : ")
  if (sepIdx < 0) return { type: "unknown", line }
  const head = rest.slice(0, sepIdx)
  const value = rest.slice(sepIdx + 3)
  const parts = head.split(/\s+/)
  const paneId = parts[0] ?? ""
  const age = toInt(parts[1])
  const extra = parts.slice(2)
  return { type: "extended-output", paneId, age, extra, data: decodeOctalPayload(value) }
}

function parseSubscriptionChanged(rest: string, line: string): TmuxEvent {
  const sepIdx = rest.indexOf(" : ")
  if (sepIdx < 0) return { type: "unknown", line }
  const head = rest.slice(0, sepIdx)
  const value = rest.slice(sepIdx + 3)
  const parts = head.split(/\s+/)
  if (parts.length < 5) return { type: "unknown", line }
  return {
    type: "subscription-changed",
    name: parts[0] ?? "",
    sessionId: parts[1] ?? "",
    windowId: parts[2] ?? "",
    windowIndex: parts[3] ?? "",
    paneId: parts[4] ?? "",
    extra: parts.slice(5),
    data: decodeOctalPayload(value),
  }
}

function splitFirst(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep)
  if (i < 0) return [s, ""]
  return [s.slice(0, i), s.slice(i + sep.length)]
}

function trimOrEmpty(s: string): string {
  return s ?? ""
}

function toInt(s: string | undefined): number {
  if (s === undefined) return 0
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : 0
}

function bytesToLatin1(buf: Uint8Array | Buffer): string {
  // Latin-1 preserves every input byte 1:1 in the string's char codes,
  // which keeps `%output` payload bytes intact through the string
  // decode boundary. Subsequent octal-decode reads them back via
  // `charCodeAt() & 0xff`.
  let s = ""
  for (let i = 0; i < buf.length; i++) {
    s += String.fromCharCode(buf[i] ?? 0)
  }
  return s
}

const OCT_0 = 0x30
const OCT_7 = 0x37

function isOctalDigit(ch: number): boolean {
  return ch >= OCT_0 && ch <= OCT_7
}

export function decodeOctalPayload(value: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < value.length; ) {
    const ch = value.charCodeAt(i)
    if (ch === 0x5c /* \ */) {
      const a = i + 1 < value.length ? value.charCodeAt(i + 1) : -1
      const b = i + 2 < value.length ? value.charCodeAt(i + 2) : -1
      const c = i + 3 < value.length ? value.charCodeAt(i + 3) : -1
      if (a >= 0 && b >= 0 && c >= 0 && isOctalDigit(a) && isOctalDigit(b) && isOctalDigit(c)) {
        const byte = ((a - OCT_0) << 6) | ((b - OCT_0) << 3) | (c - OCT_0)
        out.push(byte & 0xff)
        i += 4
        continue
      }
      // The strict tmux protocol always emits 3-octal-digit escapes, but
      // we accept `\\` → `\` too: some upstream tests / older tmux
      // builds emit it, and decoding it explicitly is safer than
      // dropping or doubling the backslash.
      if (a === 0x5c) {
        out.push(0x5c)
        i += 2
        continue
      }
      out.push(0x5c)
      i += 1
      continue
    }
    out.push(ch & 0xff)
    i += 1
  }
  return new Uint8Array(out)
}
