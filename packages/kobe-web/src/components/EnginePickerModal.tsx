/**
 * Engine picker — the /chat shell's ctrl+e modal. Mirrors the TUI's
 * chat.tab.chooseEngine: pick a vendor, then the caller opens a new tab
 * pinned to it. Keyboard 1:1 with ChatInbox (j/k/arrows, enter, esc).
 */

import { useEffect, useState } from "react"
import { useEngines } from "../lib/engines.ts"
import { engineLabel } from "../lib/vendor.ts"

export function EnginePickerModal({
  onPick,
  onPickShell,
  onClose,
}: {
  onPick: (vendor: string) => void
  onPickShell: () => void
  onClose: () => void
}) {
  const engines = useEngines()
  const [cursor, setCursor] = useState(0)
  // engines + Claude·ACP (experimental structured link) + one Shell row.
  const rowCount = engines.length + 2

  useEffect(() => {
    if (cursor >= rowCount) setCursor(Math.max(0, rowCount - 1))
  }, [cursor, rowCount])

  // The modal owns the keyboard — drop focus left in the sidebar search.
  useEffect(() => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const last = Math.max(0, rowCount - 1)
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault()
        event.stopPropagation()
        setCursor((cur) => Math.min(last, cur + 1))
        return
      }
      if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault()
        event.stopPropagation()
        setCursor((cur) => Math.max(0, cur - 1))
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        event.stopPropagation()
        if (cursor === engines.length) {
          onPick("claude-acp")
          return
        }
        if (cursor === engines.length + 1) {
          onPickShell()
          return
        }
        const engine = engines[cursor]
        if (engine) onPick(engine.id)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [cursor, engines, onClose, onPick, onPickShell, rowCount])

  const acpActive = cursor === engines.length
  const shellActive = cursor === engines.length + 1

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-away; escape is handled globally above
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[18vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="pop-in w-[22rem] overflow-hidden rounded-lg border border-line bg-menu font-mono shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-fg">
            New tab
          </span>
          <span className="text-[11px] text-subtle">esc closes</span>
        </div>
        <div className="max-h-[50vh] overflow-y-auto pb-2 pt-1">
          {engines.map((engine, i) => {
            const active = cursor === i
            return (
              <button
                key={engine.id}
                type="button"
                onClick={() => onPick(engine.id)}
                className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left hover:bg-inset${
                  active ? " bg-inset" : ""
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
                  {engineLabel(engines, engine.id)}
                </span>
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => onPick("claude-acp")}
            className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left hover:bg-inset${
              acpActive ? " bg-inset" : ""
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
              Claude · ACP
            </span>
            <span className="text-[11px] text-kobe-violet">experimental</span>
          </button>
          <button
            type="button"
            onClick={onPickShell}
            className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left hover:bg-inset${
              shellActive ? " bg-inset" : ""
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
              Shell
            </span>
            <span className="text-[11px] text-subtle">native terminal</span>
          </button>
        </div>
      </div>
    </div>
  )
}
