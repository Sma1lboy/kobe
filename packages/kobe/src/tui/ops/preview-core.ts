/**
 * Framework-free data half of the `kobe ops --preview <rel>` window,
 * extracted from `tui/ops/host.tsx` so the Solid and React previews (issue
 * #15, G3) share it. Vitest-safe: no @opentui imports (the theme-bound
 * SyntaxStyle builder lives in `./preview-syntax`), no framework.
 */

import { readWorktreeFile, runWorktreeGit, worktreeFileSize } from "@/worktree/content"

/** Map a file extension to an opentui tree-sitter grammar name. */
export function filetypeOf(relPath: string): string | undefined {
  const ext = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase()
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript"
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript"
    case "md":
    case "markdown":
      return "markdown"
    default:
      return undefined
  }
}

export type PreviewData =
  /** `diff` renders opentui `<diff>` (unified vs HEAD); `code` a plain `<code>` view. */
  | { readonly kind: "diff" | "code"; readonly text: string }
  /** Image/binary placeholder card — the TUI can't render these as text. */
  | { readonly kind: "binary"; readonly image: boolean; readonly sizeBytes: number | null }

/** Extensions the preview treats as images (→ binary card, no text read). */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "avif", "heic"])

export function isImagePath(relPath: string): boolean {
  return IMAGE_EXTS.has(relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase())
}

/** Null byte in the head of a utf8-decoded read = not renderable text. */
export function looksBinaryText(text: string): boolean {
  return text.slice(0, 8192).includes("\u0000")
}

/** `1.2 KB` / `340 B` — for the binary card's size line. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/**
 * Diff for `relPath`, otherwise its full content. `range` picks the diff:
 * omitted → uncommitted work (`git diff HEAD`); `{ base }` → everything this
 * branch changed vs its base (`git diff <base>...HEAD`, three-dot = against
 * the merge-base — the Changes tab's Branch scope). Either way, an empty diff
 * falls back to the file's current content.
 *
 * Images (by extension) and files whose content carries null bytes skip the
 * text path entirely and come back as a `binary` card — a PNG rendered as
 * utf8 is mojibake, not a preview.
 */
export async function loadPreviewData(
  worktree: string,
  relPath: string,
  range?: { base: string },
): Promise<PreviewData> {
  if (isImagePath(relPath)) {
    return { kind: "binary", image: true, sizeBytes: await worktreeFileSize(worktree, relPath) }
  }
  const spec = range ? `${range.base}...HEAD` : "HEAD"
  const res = await runWorktreeGit(worktree, ["diff", spec, "--", relPath])
  const diff = res.status === 0 ? res.stdout : ""
  if (diff.trim().length > 0) return { kind: "diff", text: diff }
  const text = (await readWorktreeFile(worktree, relPath)) ?? ""
  if (looksBinaryText(text)) {
    return { kind: "binary", image: false, sizeBytes: await worktreeFileSize(worktree, relPath) }
  }
  return { kind: "code", text }
}
