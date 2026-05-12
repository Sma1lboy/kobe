/**
 * Image-paste core for the chat composer.
 *
 * Why this module exists:
 *
 *   - The `claude` CLI doesn't accept inline base64 image blocks via
 *     `-p` (we shell out to `claude --print --output-format stream-json
 *     -p "<text>"` from `engine/claude-code-local/spawn.ts`). Its only
 *     image-input channel is in-prompt `@/abs/path` references, which
 *     it resolves to file reads on its side. So the composer's job is
 *     to (a) get image bytes onto disk and (b) put a `@path` reference
 *     into the submitted text.
 *   - We don't paste the raw `@path` into the textarea — too noisy,
 *     and a 200-char absolute path crowds out the user's actual
 *     prompt. Instead we insert a `[Image #N]` placeholder token,
 *     keep an in-memory map of token → path, and expand on submit.
 *     This mirrors claude-code's `pastedContents` UX
 *     (refs/claude-code/src/components/PromptInput/PromptInput.tsx).
 *
 * Lifecycle:
 *
 *   - One {@link ImagePasteRegistry} per Composer instance.
 *   - `saveBytes` / `saveFromClipboard` register an entry, write the
 *     PNG to `~/.kobe/pasted-images/<uuid>.png`, and return the
 *     placeholder token to insert at the cursor.
 *   - `expand(text)` is called on submit. It walks `[Image #N]` tokens
 *     and rewrites each into ` @<absPath> ` (single space on either
 *     side so the path doesn't fuse with adjacent words).
 *   - `clear()` is called after submit so the next image starts at
 *     `#1` again. Files on disk are *not* deleted — the user (or a
 *     follow-up GC pass) owns cleanup. Persisting the file means a
 *     recalled history entry containing `@/abs/path/foo.png` still
 *     resolves on the engine side.
 *
 * Edge cases worth knowing:
 *
 *   - If the user types `[Image #N]` literally where the registry
 *     happens to have id `N`, expansion will fire on that text too.
 *     Acceptable for v1 — registry IDs reset on submit, so the
 *     collision window is one composer turn.
 *   - Tokens that don't match any registry entry pass through
 *     unchanged (e.g. recall of an old draft after `clear()`). This
 *     keeps `expand` total/safe even when the registry is stale.
 */
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { kobeStateDir } from "../../../../env"
import { clipboardImageSupported, readClipboardImageToFile } from "./clipboard-image"

export interface PastedImage {
  readonly id: number
  readonly absPath: string
  readonly displayName: string
}

export interface ImagePasteResult {
  readonly token: string
  readonly entry: PastedImage
}

const IMAGE_TOKEN_RE = /\[Image #(\d+)\]/g

/** Directory we write pasted images to. Lives under kobe's state dir
 *  so it's user-scoped and survives `bun run dev` restarts (which lets
 *  history-recalled prompts containing `@/path/...` still resolve). */
export function pastedImagesDir(): string {
  return join(kobeStateDir(), "pasted-images")
}

/**
 * Per-composer registry of pasted images. Owns disk writes (so the
 * composer doesn't have to know about the filesystem) and the
 * placeholder bookkeeping.
 */
export class ImagePasteRegistry {
  private nextId = 1
  private readonly entries = new Map<number, PastedImage>()

  /**
   * Persist raw bytes to disk and return the placeholder token to
   * insert into the textarea. Used by the bracketed-paste path when a
   * terminal forwards image bytes through `PasteEvent`.
   */
  saveBytes(bytes: Uint8Array, mimeType: string): ImagePasteResult {
    const ext = mimeTypeToExt(mimeType)
    const absPath = mintPath(ext)
    mkdirSync(pastedImagesDir(), { recursive: true })
    writeFileSync(absPath, bytes)
    return this.register(absPath)
  }

  /**
   * Try to read an image off the OS clipboard and persist it. Returns
   * null when no image is on the clipboard or the platform isn't
   * supported — caller surfaces "no image on clipboard" / "not yet
   * supported on $platform" accordingly.
   */
  saveFromClipboard(): ImagePasteResult | null {
    if (!clipboardImageSupported()) return null
    const absPath = mintPath(".png")
    mkdirSync(pastedImagesDir(), { recursive: true })
    const meta = readClipboardImageToFile(absPath)
    if (!meta) return null
    return this.register(absPath)
  }

  /**
   * Replace `[Image #N]` tokens in `text` with ` @<absPath> ` per the
   * registry. Tokens with no matching id pass through unchanged.
   */
  expand(text: string): string {
    return text.replace(IMAGE_TOKEN_RE, (match, idStr: string) => {
      const id = Number.parseInt(idStr, 10)
      const entry = this.entries.get(id)
      if (!entry) return match
      return ` @${entry.absPath} `
    })
  }

  /** True iff at least one image has been registered (used to gate
   *  `expand` calls — skip the regex pass when nothing was pasted). */
  hasEntries(): boolean {
    return this.entries.size > 0
  }

  /** Drop every entry. Files on disk are kept. Called after submit. */
  clear(): void {
    this.entries.clear()
    this.nextId = 1
  }

  private register(absPath: string): ImagePasteResult {
    const id = this.nextId++
    const displayName = `Image #${id}`
    const entry: PastedImage = { id, absPath, displayName }
    this.entries.set(id, entry)
    return { token: `[${displayName}]`, entry }
  }
}

/**
 * Inverse of {@link ImagePasteRegistry.expand} for *display* only.
 * Walks `text` and replaces ` @<pastedImagesDir>/<file> ` references
 * (the form `expand` wrote to the engine prompt) with `[Image #N]`
 * placeholders, numbered in the order they appear.
 *
 * Why this lives outside the registry: by the time we render a user
 * message back in the transcript, the registry has already been
 * cleared, and the chat history persists the *expanded* path string
 * (so a recalled prompt still resolves on the engine side). The
 * renderer just needs to know "this @-ref points at our paste dir,
 * collapse it for human eyes". Match scope is intentionally tight
 * — only paths under `pastedImagesDir()` — so a real `@/some/file.png`
 * the user typed by hand keeps its literal form.
 *
 * Numbering restarts per call (per message), matching the user's
 * mental model in the composer: each turn starts at `#1`.
 */
export function prettifyPastedImageRefs(text: string): string {
  if (!text.includes("@")) return text
  const dirPattern = escapeRegExp(pastedImagesDir())
  // Match all surrounding whitespace so we can fold the double / triple
  // spaces `expand` plus the composer's ` [Image] ` insertion produce
  // back to single spaces. The path body is `[^\s]+` to swallow the
  // uuid + extension without running across a word boundary.
  const re = new RegExp(`(\\s*)@${dirPattern}/[^\\s]+(\\s*)`, "g")
  let n = 0
  return text.replace(re, (match, lead: string, trail: string, offset: number) => {
    n++
    // Collapse to a single space on each side. Drop the side-space
    // entirely when the match touches a string boundary so we don't
    // synthesise leading/trailing whitespace the user never typed.
    const atStart = offset === 0
    const atEnd = offset + match.length === text.length
    const left = !atStart && lead.length > 0 ? " " : ""
    const right = !atEnd && trail.length > 0 ? " " : ""
    return `${left}[Image #${n}]${right}`
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Map a clipboard mime type to a file extension (with leading dot).
 * Defaults to `.png` for anything we don't recognise — Claude's
 * file-type detection is content-based, so the extension is mostly
 * cosmetic for the user's own filesystem browsing.
 */
function mimeTypeToExt(mimeType: string): string {
  const lower = mimeType.toLowerCase()
  if (lower === "image/png") return ".png"
  if (lower === "image/jpeg" || lower === "image/jpg") return ".jpg"
  if (lower === "image/gif") return ".gif"
  if (lower === "image/webp") return ".webp"
  if (lower === "image/bmp") return ".bmp"
  return ".png"
}

/** Mint a unique destination path under {@link pastedImagesDir}. */
function mintPath(ext: string): string {
  return join(pastedImagesDir(), `${randomUUID()}${ext}`)
}
