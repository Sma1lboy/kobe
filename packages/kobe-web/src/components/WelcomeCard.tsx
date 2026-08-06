/**
 * WelcomeCard — the session-open banner (lib/claude-tty.ts `welcome` block)
 * re-laid-out as a compact selected-state card: left column holds the fox
 * logo, product + version badge, and model/billing + cwd lines; right column
 * (sm+) auto-loads the version's changelog (lib/changelog.ts) as a compact
 * "What's new" panel. Replaces the raw art rows the CLI drew so the header
 * reads as chrome, not transcript.
 */

import { Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { type ChangelogEntry, changelogFor } from "../lib/changelog.ts"
import type { WelcomeInfo } from "../lib/claude-tty.ts"

export function WelcomeCard({ welcome }: { welcome: WelcomeInfo }) {
  const { logo, product, version, info } = welcome
  const [entry, setEntry] = useState<ChangelogEntry | null>(null)
  const [state, setState] = useState<"loading" | "empty" | "ready">("loading")

  // Auto-load this version's notes on mount (mirrors the CLI welcome banner's
  // right-hand "What's new" column — no click-to-expand).
  useEffect(() => {
    let cancelled = false
    setState("loading")
    void changelogFor(version).then((e) => {
      if (cancelled) return
      setEntry(e)
      setState(e ? "ready" : "empty")
    })
    return () => {
      cancelled = true
    }
  }, [version])

  return (
    <div className="fade-up my-3 rounded-xl border border-primary/40 bg-inset px-4 py-3">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <pre className="shrink-0 self-center whitespace-pre pr-1 font-mono text-[13px] leading-none text-primary">
            {logo.join("\n")}
          </pre>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-fg">{product}</span>
              <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary">
                v{version}
              </span>
            </div>
            {info.map((line) => (
              <div key={line} className="mt-0.5 truncate text-[12px] text-muted">
                {line}
              </div>
            ))}
          </div>
        </div>
        <div className="hidden min-w-0 flex-1 border-l border-line pl-4 sm:block">
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-subtle">
            What's new
          </div>
          {state === "loading" ? (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-subtle">
              <Loader2 size={11} className="animate-spin" />
              Loading changelog…
            </div>
          ) : state === "empty" || !entry ? (
            <div className="mt-1.5 text-[11px] text-subtle">
              Changelog unavailable offline.
            </div>
          ) : (
            <>
              <ul className="mt-1.5 space-y-0.5">
                {entry.notes.slice(0, 4).map((note) => (
                  <li
                    key={note}
                    className="flex gap-1.5 truncate text-[12px] text-muted"
                  >
                    <span className="shrink-0 text-primary/60">·</span>
                    <span className="min-w-0 truncate">{note}</span>
                  </li>
                ))}
              </ul>
              {entry.notes.length > 0 && (
                <div className="mt-1 text-[11px] text-subtle">
                  /release-notes for more
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
