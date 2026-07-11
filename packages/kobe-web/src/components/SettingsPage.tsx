/**
 * The Settings page frame — section nav, the load/error/loading states, and
 * routing to each section. Sections live in SettingsSections.tsx; the shared
 * Card/ToggleRow controls and the settings load/patch hook in
 * SettingsShared.tsx.
 */

import { useMemo, useState } from "react"
import {
  BoardSection,
  DevSection,
  EnginesSection,
  GeneralSection,
  NotificationsSection,
} from "./SettingsSections.tsx"
import { useSharedSettings } from "./SettingsShared.tsx"

const SECTIONS = [
  ["general", "General"],
  ["engines", "Engines"],
  ["board", "Board"],
  ["dev", "Dev"],
  ["notifications", "Notifications"],
] as const

type SectionId = (typeof SECTIONS)[number][0]

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("general")
  const { settings, loading, error, reload, patch } = useSharedSettings()
  const sectionTitle = useMemo(
    () => SECTIONS.find(([id]) => id === section)?.[1] ?? "Settings",
    [section],
  )

  return (
    <section data-settings-open className="flex min-w-0 flex-1 flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-surface px-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
          Settings
        </span>
        <button
          type="button"
          onClick={onClose}
          className="border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
        >
          Close
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[180px_minmax(0,1fr)] overflow-hidden">
        <nav className="min-h-0 overflow-auto border-r border-line bg-surface/60 p-2">
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              className={`mb-1 block w-full border px-2 py-2 text-left text-[12px] transition-colors ${
                section === id
                  ? "border-primary bg-inset text-fg"
                  : "border-transparent text-muted hover:border-line hover:bg-bg hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
        <main className="min-h-0 overflow-auto p-4">
          <div className="mx-auto max-w-4xl">
            <h1 className="mb-3 text-[13px] font-bold uppercase tracking-[0.12em] text-fg">
              {sectionTitle}
            </h1>
            {error ? (
              <div className="border border-line bg-surface p-4 text-[12px]">
                <p className="text-subtle">
                  Couldn't load settings (daemon web transport offline?)
                </p>
                <button
                  type="button"
                  onClick={reload}
                  className="mt-3 border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
                >
                  Retry
                </button>
              </div>
            ) : loading || !settings ? (
              <div className="border border-line bg-surface p-4 text-[12px] text-subtle">
                Loading settings...
              </div>
            ) : section === "general" ? (
              <GeneralSection />
            ) : section === "engines" ? (
              <EnginesSection settings={settings} patch={patch} />
            ) : section === "board" ? (
              <BoardSection />
            ) : section === "dev" ? (
              <DevSection settings={settings} patch={patch} />
            ) : (
              <NotificationsSection />
            )}
          </div>
        </main>
      </div>
    </section>
  )
}
