/**
 * Prompt attachments — multimodal inputs for the quick-task composer.
 *
 * Two paste flows land here (pattern lifted from refs/claude-code
 * `utils/imagePaste.ts`, trimmed to kobe's needs — no resizing/base64,
 * engines read files from disk themselves):
 *
 *   1. Pasted TEXT that is a file path (Finder copy → paste, drag-drop):
 *      {@link asAttachmentPaths} recognises image/PDF paths and the
 *      composer attaches them in place of inserting the text.
 *   2. A raw clipboard IMAGE (screenshot): no text arrives on paste, so
 *      the composer binds ctrl+v → {@link captureClipboardAttachment},
 *      which asks the OS clipboard. A copied FILE resolves to its own
 *      path; raw image bytes are saved under `~/.kobe/attachments/` and
 *      that saved path is attached.
 *
 * Attachments render as `images[0]` / `pdf[1]` chips in the composer and
 * are appended to the delivered prompt as `label: /path` lines via
 * {@link appendAttachmentRefs} — the engine reads the files itself.
 */

import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { promptAttachmentsDir } from "../../env.ts"

/** Extensions the engines can ingest as prompt attachments. */
const ATTACHMENT_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|pdf)$/i
const PDF_EXTENSION_REGEX = /\.pdf$/i

/** Strip one layer of outer quotes (terminals quote dragged paths). */
function removeOuterQuotes(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Remove shell escape backslashes (`name\ \(1\).png` → `name (1).png`).
 * Double backslashes survive as literal ones.
 */
function stripBackslashEscapes(path: string): string {
  const salt = randomBytes(8).toString("hex")
  const placeholder = `__DOUBLE_BACKSLASH_${salt}__`
  return path.replace(/\\\\/g, placeholder).replace(/\\(.)/g, "$1").replaceAll(placeholder, "\\")
}

/**
 * Normalize one pasted line to an attachment path, or null when it isn't
 * one. Requires an ABSOLUTE path that exists on disk — a relative name
 * can't be resolved reliably from the composer's cwd, and attaching a
 * non-existent path would just hand the engine a broken reference.
 */
export function asAttachmentPath(text: string, exists: (p: string) => boolean = existsSync): string | null {
  const cleaned = stripBackslashEscapes(removeOuterQuotes(text.trim()))
  if (!ATTACHMENT_EXTENSION_REGEX.test(cleaned)) return null
  if (!isAbsolute(cleaned)) return null
  return exists(cleaned) ? cleaned : null
}

/**
 * Parse a whole paste payload as attachment paths. A Finder multi-file
 * copy pastes newline-separated paths — ALL non-empty lines must resolve,
 * otherwise the paste is ordinary text (return null so it falls through
 * to the input).
 */
export function asAttachmentPaths(pasted: string, exists: (p: string) => boolean = existsSync): string[] | null {
  const lines = pasted
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return null
  const paths: string[] = []
  for (const line of lines) {
    const p = asAttachmentPath(line, exists)
    if (!p) return null
    paths.push(p)
  }
  return paths
}

/** Chip / prompt-line label: `images[0]` for images, `pdf[1]` for PDFs. */
export function attachmentLabel(path: string, index: number): string {
  return PDF_EXTENSION_REGEX.test(path) ? `pdf[${index}]` : `images[${index}]`
}

/**
 * Append attachment references to the outgoing prompt:
 *
 *   <prompt>
 *
 *   images[0]: /path/a.png
 *   pdf[1]: /path/b.pdf
 */
export function appendAttachmentRefs(prompt: string, attachments: readonly string[]): string {
  if (attachments.length === 0) return prompt
  const refs = attachments.map((p, i) => `${attachmentLabel(p, i)}: ${p}`).join("\n")
  return `${prompt}\n\n${refs}`
}

/** Run a shell command, capturing stdout. Null on failure. Best-effort. */
async function capture(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? out : null
  } catch {
    return null
  }
}

/**
 * Read the OS clipboard for an attachable payload (ctrl+v flow):
 *
 *   1. A copied FILE (Finder cmd+c): resolve its path — attach directly,
 *      no copy made.
 *   2. Raw image bytes (screenshot): write a PNG under
 *      `~/.kobe/attachments/` and attach the saved path.
 *
 * macOS via osascript; Linux via wl-paste/xclip. Returns null when the
 * clipboard has nothing attachable (or on an unsupported platform).
 */
export async function captureClipboardAttachment(): Promise<string | null> {
  if (process.platform === "darwin") {
    const furl = await capture(["osascript", "-e", "get POSIX path of (the clipboard as «class furl»)"])
    const fromFile = furl ? asAttachmentPath(furl) : null
    if (fromFile) return fromFile

    const dest = newAttachmentPath()
    const saved = await capture([
      "osascript",
      "-e",
      "set png_data to (the clipboard as «class PNGf»)",
      "-e",
      `set fp to open for access POSIX file "${dest}" with write permission`,
      "-e",
      "write png_data to fp",
      "-e",
      "close access fp",
    ])
    return saved !== null && existsSync(dest) ? dest : null
  }

  if (process.platform === "linux") {
    // wl-paste (Wayland) then xclip (X11); either exits non-zero when the
    // clipboard has no image target.
    for (const cmd of [
      ["wl-paste", "--type", "image/png"],
      ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
    ]) {
      try {
        const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
        const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
        if ((await proc.exited) === 0 && bytes.length > 0) {
          const dest = newAttachmentPath()
          writeFileSync(dest, bytes)
          return dest
        }
      } catch {
        // binary not installed — try the next one
      }
    }
    return null
  }

  return null
}

/** Fresh collision-free save path under `~/.kobe/attachments/`. */
function newAttachmentPath(): string {
  const dir = promptAttachmentsDir()
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "")
  return join(dir, `paste-${stamp}-${randomBytes(4).toString("hex")}.png`)
}
