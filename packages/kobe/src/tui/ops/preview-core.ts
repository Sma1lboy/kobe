import { readWorktreeFile, runWorktreeGit } from "@/worktree/content"

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
  readonly kind: "diff" | "code"
  readonly text: string
}

export async function loadPreviewData(worktree: string, relPath: string): Promise<PreviewData> {
  const res = await runWorktreeGit(worktree, ["diff", "HEAD", "--", relPath])
  const diff = res.status === 0 ? res.stdout : ""
  if (diff.trim().length > 0) return { kind: "diff", text: diff }
  return { kind: "code", text: (await readWorktreeFile(worktree, relPath)) ?? "" }
}
