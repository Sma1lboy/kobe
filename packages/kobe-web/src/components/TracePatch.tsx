import { useMemo } from "react"
import { rowClass } from "../lib/diff-display.ts"
import { parseDiffRows } from "../lib/diff-rows.ts"
import { CopyButton } from "./CopyButton.tsx"
import "./diff-view.css"

/** Read-only patch viewer for engine-declared `change` trace nodes. */
export function TracePatch({ patch }: { patch: string }) {
  const rows = useMemo(() => parseDiffRows(patch), [patch])
  return (
    <section className="border border-line bg-surface">
      <header className="flex h-9 items-center gap-2 border-b border-line px-3">
        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted">
          Patch
        </span>
        <CopyButton text={patch} label="Copy patch" className="ml-auto" />
      </header>
      <div className="kobe-diff kobe-diff-wrap max-h-[48vh] overflow-auto py-2 font-mono text-[11px] leading-[1.15rem]">
        {rows.length === 0 ? (
          <div className="px-3 py-2 text-subtle">(empty patch)</div>
        ) : (
          rows.map((row, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: patch rows are positional.
              key={index}
              className={`kobe-diff-row ${rowClass(row.kind)}`}
            >
              <span className="kobe-diff-gutter">{row.oldLn ?? ""}</span>
              <span className="kobe-diff-gutter">{row.newLn ?? ""}</span>
              <span className="kobe-diff-text">
                {row.text === "" ? " " : row.text}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
