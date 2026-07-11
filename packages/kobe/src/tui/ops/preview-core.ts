/**
 * Framework-free data half of the `kobe ops --preview <rel>` window,
 * extracted from `tui/ops/host.tsx` so the Solid and React previews (issue
 * #15, G3) share it. Vitest-safe: no @opentui imports (the theme-bound
 * SyntaxStyle builder lives in `./preview-syntax`), no framework.
 */

import { readWorktreeFile, runWorktreeGit } from "@/worktree/content"

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

export interface PreviewData {
  /** `diff` renders opentui `<diff>` (unified vs HEAD); `code` a plain `<code>` view. */
  readonly kind: "diff" | "code"
  readonly text: string
}

/**
 * Diff for `relPath`, otherwise its full content. `range` picks the diff:
 * omitted → uncommitted work (`git diff HEAD`); `{ base }` → everything this
 * branch changed vs its base (`git diff <base>...HEAD`, three-dot = against
 * the merge-base — the Changes tab's Branch scope). Either way, an empty diff
 * falls back to the file's current content.
 */
export async function loadPreviewData(
  worktree: string,
  relPath: string,
  range?: { base: string },
): Promise<PreviewData> {
  const spec = range ? `${range.base}...HEAD` : "HEAD"
  const res = await runWorktreeGit(worktree, ["diff", spec, "--", relPath])
  const diff = res.status === 0 ? res.stdout : ""
  if (diff.trim().length > 0) return { kind: "diff", text: diff }
  return { kind: "code", text: (await readWorktreeFile(worktree, relPath)) ?? "" }
}
