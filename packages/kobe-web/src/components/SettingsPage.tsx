/**
 * The Settings page frame — ONE quiet scrolling column plus a sticky
 * right-side TOC (scroll-spy anchors). Every group stacks under an uppercase
 * label + hairline, the sidebar's grouping grammar. Sections live in
 * SettingsSections.tsx; shared controls + the load/patch hook in
 * SettingsShared.tsx.
 */

import { useEffect, useRef, useState } from "react"
import {
  BoardSection,
  DevSection,
  EnginesSection,
  GeneralSection,
  NotificationsSection,
} from "./SettingsSections.tsx"
import { useSharedSettings } from "./SettingsShared.tsx"

const TOC = [
  ["theme", "Theme"],
  ["notifications", "Notifications"],
  ["engines", "Engines"],
  ["board", "Board quick actions"],
  ["dev", "Dev"],
] as const

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const { settings, loading, error, reload, patch } = useSharedSettings()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<string>(TOC[0][0])

  // `esc · close` must actually mean it — bound while mounted, skipped when
  // an inner field has focus (esc there should just blur/cancel the field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return
      const t = event.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return
      onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // Scroll-spy: the topmost section crossing the upper quarter is active.
  useEffect(() => {
    const root = scrollRef.current
    if (!root || !settings) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        const id = visible[0]?.target.getAttribute("data-toc")
        if (id) setActive(id)
      },
      { root, rootMargin: "0px 0px -70% 0px" },
    )
    for (const el of root.querySelectorAll("[data-toc]")) observer.observe(el)
    return () => observer.disconnect()
  }, [settings])

  const jump = (id: string): void => {
    scrollRef.current
      ?.querySelector(`[data-toc="${id}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <section
      data-settings-open
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg"
    >
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
          Settings
        </span>
        <span className="text-[11px] text-subtle">
          shared with the TUI where noted
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-[11px] text-subtle transition-colors hover:text-fg"
        >
          esc · close
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={() => {
          // Bottom clamp: the last section may be too short to reach the spy
          // band — hitting the end marks it active anyway.
          const el = scrollRef.current
          if (!el) return
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 8)
            setActive(TOC[TOC.length - 1]?.[0] ?? active)
        }}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
      >
        {error ? (
          <div className="text-[12px] text-subtle">
            Couldn't load settings (daemon web transport offline?)
            <button
              type="button"
              onClick={reload}
              className="ml-2 text-[11px] text-primary hover:underline"
            >
              retry
            </button>
          </div>
        ) : loading || !settings ? (
          <div className="text-[12px] text-subtle">Loading settings…</div>
        ) : (
          <div className="flex gap-10">
            <div className="min-w-0 max-w-2xl flex-1 space-y-8 pb-16">
              <div data-toc="theme">
                <GeneralSection />
              </div>
              <div data-toc="notifications">
                <NotificationsSection />
              </div>
              <div data-toc="engines">
                <EnginesSection settings={settings} patch={patch} />
              </div>
              <div data-toc="board">
                <BoardSection />
              </div>
              <div data-toc="dev">
                <DevSection settings={settings} patch={patch} />
              </div>
            </div>
            {/* Sticky TOC fills the right void — click jumps, scroll follows. */}
            <nav className="sticky top-0 hidden w-44 shrink-0 self-start pt-1 lg:block">
              {TOC.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => jump(id)}
                  className={`block w-full border-l-2 py-1 pl-3 text-left text-[11px] transition-colors ${
                    active === id
                      ? "border-primary text-fg"
                      : "border-line text-subtle hover:text-fg"
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>
        )}
      </div>
    </section>
  )
}
