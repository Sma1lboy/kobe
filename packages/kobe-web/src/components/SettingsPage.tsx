import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { setNotificationsEnabled, useNotifyState } from "../lib/notify.ts"
import { fetchQuickPrompts, saveQuickPrompts } from "../lib/quick-prompts.ts"
import { DEFAULT_PR_TEMPLATE, defaultReviewTemplate } from "../lib/review.ts"
import {
  fetchSettings,
  saveSettings,
  type WebSettings,
  type WebSettingsEngine,
} from "../lib/settings.ts"
import { resetLayout } from "../lib/tabs.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import { ThemePicker } from "./ThemePicker.tsx"

const SECTIONS = [
  ["general", "General"],
  ["engines", "Engines"],
  ["board", "Board"],
  ["dev", "Dev"],
  ["notifications", "Notifications"],
] as const

type SectionId = (typeof SECTIONS)[number][0]

// A flat section: a BOLD CAPS header over its content, with NO enclosing
// border/fill. The controls inside (EngineRow, ToggleRow, inputs, textareas)
// already carry their own border, so wrapping them in a bordered card stacked a
// third concentric box (card → row → field) and read as over-nested. Dropping
// the card box leaves the header to group, the controls to delineate.
function Card({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-subtle">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[12px]">{children}</div>
    </section>
  )
}

function ToggleRow({
  label,
  detail,
  enabled,
  onToggle,
  disabled,
}: {
  label: string
  detail?: string
  enabled: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 border border-line bg-bg p-3">
      <div className="min-w-0">
        <div className="text-[12px] font-bold text-fg">{label}</div>
        {detail ? (
          <div className="mt-1 text-[11px] leading-relaxed text-subtle">
            {detail}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className={`shrink-0 border px-2 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          enabled
            ? "border-primary bg-inset text-fg"
            : "border-line bg-surface text-muted hover:border-primary hover:text-fg"
        }`}
      >
        {enabled ? "On" : "Off"}
      </button>
    </div>
  )
}

function useSharedSettings() {
  const [settings, setSettings] = useState<WebSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  // A failed load leaves `settings` null forever, so track the error
  // separately to show a retryable empty state instead of a stuck spinner.
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    setError(false)
    try {
      const next = await fetchSettings()
      if (seq === seqRef.current) setSettings(next)
    } catch (err) {
      if (seq === seqRef.current) setError(true)
      reportError("load settings", err)
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patch = async (delta: Parameters<typeof saveSettings>[0]) => {
    const next = await saveSettings(delta)
    setSettings(next)
    return next
  }

  return { settings, loading, error, reload: load, patch }
}

function GeneralSection() {
  return (
    <div className="space-y-6">
      <Card title="Dashboard theme">
        <p className="text-[11px] leading-relaxed text-subtle">
          Pick a theme for this browser, or follow the TUI's theme. This is a
          browser-local override — it never changes the TUI.
        </p>
        <ThemePicker />
      </Card>
    </div>
  )
}

function EngineRow({
  engine,
  onSave,
  onDefault,
  onRemove,
}: {
  engine: WebSettingsEngine
  onSave: (id: string, command: string, label: string) => void
  onDefault: (id: string) => void
  onRemove: (id: string) => void
}) {
  const [command, setCommand] = useState(engine.command)
  const [label, setLabel] = useState(engine.label)
  const labelLooksLikeCommand =
    /\s--[A-Za-z0-9][\w-]*/.test(label) &&
    !/\s--[A-Za-z0-9][\w-]*/.test(command)

  useEffect(() => {
    setCommand(engine.command)
    setLabel(engine.label)
  }, [engine.command, engine.label])

  return (
    <div className="border border-line bg-bg p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-fg">{engine.label}</span>
            {engine.isDefault ? (
              <span className="font-mono text-[10px] text-primary">
                default
              </span>
            ) : null}
            {engine.isCustom ? (
              <span className="font-mono text-[10px] text-subtle">custom</span>
            ) : null}
          </div>
          <div className="font-mono text-[10px] text-subtle">{engine.id}</div>
        </div>
        <button
          type="button"
          onClick={() => onDefault(engine.id)}
          className="shrink-0 border border-line bg-surface px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
        >
          Make default
        </button>
      </div>
      <label className="mt-3 block">
        <span className="text-[11px] text-muted">
          Display name (label only)
        </span>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className="mt-1 w-full border border-line bg-surface px-2 py-1 text-fg focus:border-line-active focus:outline-none"
        />
      </label>
      <label className="mt-2 block">
        <span className="text-[11px] text-muted">
          Launch command (argv that kobe runs)
        </span>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          className="mt-1 w-full border border-line bg-surface px-2 py-1 font-mono text-fg focus:border-line-active focus:outline-none"
        />
      </label>
      {labelLooksLikeCommand ? (
        <div className="mt-2 border border-kobe-yellow/40 bg-kobe-yellow/10 px-2 py-1 text-[11px] leading-relaxed text-kobe-yellow">
          This looks like a flag in the display name. Put permission/model flags
          in Launch command; the label is never executed.
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSave(engine.id, command, label)}
          className="border border-primary bg-inset px-2 py-1 text-[11px] text-fg"
        >
          Save
        </button>
        {engine.isCustom ? (
          <button
            type="button"
            onClick={() => onRemove(engine.id)}
            className="border border-kobe-red/40 bg-kobe-red/10 px-2 py-1 text-[11px] text-kobe-red"
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  )
}

function EnginesSection({
  settings,
  patch,
}: {
  settings: WebSettings
  patch: (delta: Parameters<typeof saveSettings>[0]) => Promise<WebSettings>
}) {
  const [id, setId] = useState("")
  const [command, setCommand] = useState("")
  const [label, setLabel] = useState("")
  const saveEngine = (
    engineId: string,
    nextCommand: string,
    nextLabel: string,
  ) =>
    void patch({
      engineUpdates: [{ id: engineId, command: nextCommand, label: nextLabel }],
    }).then(() => pushToast("success", "engine saved"))

  return (
    <div className="space-y-6">
      <Card title="Launch commands">
        <p className="text-[11px] leading-relaxed text-subtle">
          Same shared engine settings as the TUI. Built-ins can be renamed or
          pointed at a different command. Permission/model flags must live in
          Launch command, not Display name. Custom engines are available in new
          task and tab pickers.
        </p>
        <div className="space-y-2">
          {settings.engines.map((engine) => (
            <EngineRow
              key={engine.id}
              engine={engine}
              onSave={saveEngine}
              onDefault={(engineId) =>
                void patch({ defaultEngine: engineId }).then(() =>
                  pushToast("success", "default engine saved"),
                )
              }
              onRemove={(engineId) =>
                void patch({ removeEngine: engineId }).then(() =>
                  pushToast("success", "engine removed"),
                )
              }
            />
          ))}
        </div>
      </Card>
      <Card title="Add engine">
        <div className="grid gap-2 md:grid-cols-3">
          <input
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="id, e.g. aider"
            className="border border-line bg-bg px-2 py-1 text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
          />
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="command"
            className="border border-line bg-bg px-2 py-1 font-mono text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
          />
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="display name"
            className="border border-line bg-bg px-2 py-1 text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() =>
            void patch({ addEngine: { id, command, label } })
              .then(() => {
                setId("")
                setCommand("")
                setLabel("")
                pushToast("success", "engine added")
              })
              .catch((err: unknown) => reportError("add engine", err))
          }
          className="border border-primary bg-inset px-2 py-1 text-[11px] text-fg"
        >
          Add engine
        </button>
      </Card>
    </div>
  )
}

function BoardSection() {
  const [review, setReview] = useState("")
  const [pr, setPr] = useState("")
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetchQuickPrompts()
      .then((prompts) => {
        if (cancelled) return
        setReview(prompts.review ?? "")
        setPr(prompts.pr ?? "")
        setLoaded(true)
      })
      .catch((err: unknown) => {
        // Surface the failure instead of leaving the form silently disabled
        // forever. Stay !loaded (disabled) on purpose: enabling with empty
        // values would let a Save overwrite the user's saved templates with
        // blanks on a transient load failure.
        if (!cancelled) reportError("load quick-action templates", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Card title="Board quick actions">
      <label className="block">
        <span className="text-muted">Review template</span>
        <textarea
          value={review}
          onChange={(event) => setReview(event.target.value)}
          placeholder={`default: ${defaultReviewTemplate("claude")}`}
          rows={3}
          disabled={!loaded}
          className="mt-1 w-full resize-y border border-line bg-bg p-2 font-mono text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
        />
      </label>
      <label className="block">
        <span className="text-muted">Open-PR template</span>
        <textarea
          value={pr}
          onChange={(event) => setPr(event.target.value)}
          placeholder={`default:\n${DEFAULT_PR_TEMPLATE}`}
          rows={5}
          disabled={!loaded}
          className="mt-1 w-full resize-y border border-line bg-bg p-2 font-mono text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
        />
      </label>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-subtle">
          Empty = built-in default. kobe appends its status/URL guardrails at
          send time.
        </span>
        <button
          type="button"
          onClick={() =>
            void saveQuickPrompts({ review, pr })
              .then(() => pushToast("success", "quick-action templates saved"))
              .catch((err: unknown) => reportError("save templates", err))
          }
          disabled={!loaded}
          className="shrink-0 border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
        >
          Save
        </button>
      </div>
    </Card>
  )
}

function DevSection({
  settings,
  patch,
}: {
  settings: WebSettings
  patch: (delta: Parameters<typeof saveSettings>[0]) => Promise<WebSettings>
}) {
  const [armed, setArmed] = useState(false)
  const navigate = useNavigate()
  return (
    <div className="space-y-6">
      <Card title="Experimental gates">
        <ToggleRow
          label="Remote projects"
          detail="Enables SSH-backed remote project setup in the CLI."
          enabled={settings.remoteProjects}
          onToggle={() =>
            void patch({ remoteProjects: !settings.remoteProjects })
          }
        />
        <ToggleRow
          label="Auto status flow"
          detail="Moves backlog tasks to in progress on turn start and injects the self-report protocol."
          enabled={settings.autoStatus}
          onToggle={() => void patch({ autoStatus: !settings.autoStatus })}
        />
        <ToggleRow
          label="Dispatcher"
          detail="Enables the field-notes dispatcher protocol for repo main sessions."
          enabled={settings.dispatcher}
          onToggle={() => void patch({ dispatcher: !settings.dispatcher })}
        />
      </Card>
      <Card title="Browser workspace">
        <p className="text-[11px] leading-relaxed text-subtle">
          Reset the per-task tab layout (open tabs, splits, selection). Pure
          browser state: tasks, worktrees, notes, and engines are untouched.
        </p>
        <button
          type="button"
          onClick={() => {
            if (!armed) {
              setArmed(true)
              return
            }
            resetLayout()
            void navigate({ to: "/" })
            setArmed(false)
          }}
          onBlur={() => setArmed(false)}
          className={`border px-3 py-1.5 text-[11px] transition-colors ${
            armed
              ? "border-kobe-red/50 bg-kobe-red/10 text-kobe-red"
              : "border-line bg-bg text-muted hover:border-primary hover:text-fg"
          }`}
        >
          {armed ? "Click again to reset layout" : "Reset layout"}
        </button>
      </Card>
    </div>
  )
}

function NotificationsSection() {
  const { supported, permission, enabled } = useNotifyState()
  return (
    <div className="space-y-6">
      <Card title="Notifications">
        {supported ? (
          <ToggleRow
            label="Desktop notifications"
            detail="Get pinged when a task needs input or errors while this browser tab is in the background."
            enabled={enabled}
            onToggle={() => void setNotificationsEnabled(!enabled)}
            disabled={permission === "denied" && !enabled}
          />
        ) : (
          <p className="text-[11px] leading-relaxed text-subtle">
            This browser does not support desktop notifications.
          </p>
        )}
        {permission === "denied" && !enabled ? (
          <p className="text-[11px] leading-relaxed text-kobe-yellow">
            Notifications are blocked for this site. Allow them in your
            browser's site settings to turn this on.
          </p>
        ) : null}
      </Card>
    </div>
  )
}

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
                  Couldn't load settings (daemon/bridge offline?)
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
