/**
 * WelcomeCard — the session-open banner (lib/claude-tty.ts `welcome` block)
 * re-laid-out as a compact selected-state card: the fox logo, a product +
 * version badge, the model/billing + cwd lines, and a "What's new" expander
 * that pulls the version's changelog on demand (lib/changelog.ts). Replaces the
 * raw art rows the CLI drew so the header reads as chrome, not transcript.
 */

import { ChevronRight, Loader2 } from "lucide-react"
import { useState } from "react"
import { type ChangelogEntry, changelogFor } from "../lib/changelog.ts"
import type { WelcomeInfo } from "../lib/claude-tty.ts"

export function WelcomeCard({ welcome }: { welcome: WelcomeInfo }) {
  const { logo, product, version, info } = welcome
  const [open, setOpen] = useState(false)
  const [entry, setEntry] = useState<ChangelogEntry | null>(null)
  const [state, setState] = useState<"idle" | "loading" | "empty">("idle")

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && state === "idle") {
      setState("loading")
      void changelogFor(version).then((e) => {
        setEntry(e)
        setState(e ? "idle" : "empty")
      })
    }
  }

  return (
    <div className="my-3 rounded-xl border border-primary/40 bg-inset px-4 py-3">
      <div className="flex items-start gap-2">
        <pre className="-my-0.5 shrink-0 whitespace-pre font-mono text-[13px] leading-[1.1] text-primary">
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
          <button
            type="button"
            onClick={toggle}
            className="mt-2 flex items-center gap-1 text-[11px] text-subtle transition-colors hover:text-fg"
          >
            <ChevronRight
              size={12}
              strokeWidth={2}
              className={`transition-transform ${open ? "rotate-90" : ""}`}
            />
            What's new
          </button>
          {open && (
            <div className="mt-1.5 border-t border-line pt-1.5">
              {state === "loading" ? (
                <div className="flex items-center gap-1.5 text-[11px] text-subtle">
                  <Loader2 size={11} className="animate-spin" />
                  Loading changelog…
                </div>
              ) : state === "empty" || !entry ? (
                <div className="text-[11px] text-subtle">
                  Changelog unavailable offline.
                </div>
              ) : (
                <>
                  <div className="mb-1 font-mono text-[11px] text-subtle">
                    v{entry.version}
                  </div>
                  <ul className="space-y-1">
                    {entry.notes.slice(0, 12).map((note) => (
                      <li
                        key={note}
                        className="flex gap-1.5 text-[12px] leading-relaxed text-muted"
                      >
                        <span className="text-primary/60">·</span>
                        <span className="min-w-0">{note}</span>
                      </li>
                    ))}
                  </ul>
                  {entry.notes.length > 12 && (
                    <div className="mt-1 text-[11px] text-subtle">
                      +{entry.notes.length - 12} more
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
