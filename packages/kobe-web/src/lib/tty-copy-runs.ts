import type { TtyBlock } from "./claude-tty.ts"

export type CopyRunItem =
  | { kind: "run"; blocks: TtyBlock[]; text: string }
  | { kind: "single"; block: TtyBlock }

/** Chunk consecutive plain line/gap blocks into hover-copyable runs — the
 *  assistant prose between structural blocks (bubbles, menus, cards). */
export function groupCopyRuns(blocks: readonly TtyBlock[]): CopyRunItem[] {
  const out: CopyRunItem[] = []
  let run: TtyBlock[] = []
  const flush = (): void => {
    if (run.length === 0) return
    const text = run
      // Copy the prose, not the terminal dressing: drop the `● ` bullet and
      // its matching 2-space continuation indent (deeper indents survive).
      .map((b) =>
        b.kind === "line"
          ? b.line.text.replace(/^[●⏺]\s/, "").replace(/^ {2}/, "")
          : "",
      )
      .join("\n")
      .replace(/^\n+|\n+$/g, "")
    if (text.trim() === "")
      out.push(...run.map((b) => ({ kind: "single" as const, block: b })))
    else out.push({ kind: "run", blocks: run, text })
    run = []
  }
  for (const block of blocks) {
    if (block.kind === "line" || block.kind === "gap") run.push(block)
    else {
      flush()
      out.push({ kind: "single", block })
    }
  }
  flush()
  return out
}
