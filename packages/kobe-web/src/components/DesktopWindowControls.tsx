import { desktopWindowControls, isDesktopMode } from "../lib/desktop.ts"

function WindowDot({
  label,
  tone,
  onClick,
}: {
  label: string
  tone: "close" | "minimize" | "zoom"
  onClick: () => void
}) {
  const color =
    tone === "close"
      ? "bg-[#ff5f57]"
      : tone === "minimize"
        ? "bg-[#febc2e]"
        : "bg-[#28c840]"
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`h-3 w-3 rounded-full border border-black/20 ${color}`}
    />
  )
}

export function DesktopWindowControls() {
  if (!isDesktopMode()) return null
  const controls = desktopWindowControls()
  return (
    <fieldset
      data-kobe-window-controls
      className="m-0 flex min-w-0 shrink-0 items-center gap-2 border-0 p-0"
    >
      <legend className="sr-only">Window controls</legend>
      <WindowDot
        label="Close window"
        tone="close"
        onClick={() => controls?.close()}
      />
      <WindowDot
        label="Minimize window"
        tone="minimize"
        onClick={() => controls?.minimize()}
      />
      <WindowDot
        label="Zoom window"
        tone="zoom"
        onClick={() => controls?.toggleMaximize()}
      />
    </fieldset>
  )
}
