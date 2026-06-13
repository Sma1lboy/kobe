import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { setNotificationsEnabled, useNotifyState } from "../lib/notify.ts"
import { fetchQuickPrompts, saveQuickPrompts } from "../lib/quick-prompts.ts"
import { DEFAULT_PR_TEMPLATE, defaultReviewTemplate } from "../lib/review.ts"
import {
  fetchSettings,
  saveSettings,
  type WebSettings,
  type WebSettingsEngine,
} from "../lib/settings.ts"
import { useAppState } from "../lib/store.ts"
import { resetLayout } from "../lib/tabs.ts"
import { clearPreferredTheme, useThemeState } from "../lib/theme.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import { ThemePicker } from "./ThemePicker.tsx"

const SECTIONS = [
  ["general", "General"],
  ["engines", "Engines"],
  ["board", "Board"],
  ["accounts", "Accounts"],
  ["keys", "Keybindings"],
  ["feedback", "Feedback"],
  ["dev", "Dev"],
  ["status", "Status"],
] as const

type SectionId = (typeof SECTIONS)[number][0]

function Card({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="border border-line bg-surface p-4">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-subtle">
        {title}
      </div>
      <div className="mt-4 space-y-3 text-[12px]">{children}</div>
    </div>
  )
}

function ToggleRow({
  label,
  detail,
  enabled,
  onToggle,
}: {
  label: string
  detail?: string
  enabled: boolean
  onToggle: () => void
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
        className={`shrink-0 border px-2 py-0.5 text-[10px] transition-colors ${
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

function SelectButton({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border px-2 py-1 text-left text-[12px] transition-colors ${
        active
          ? "border-primary bg-inset text-fg"
          : "border-line bg-bg text-muted hover:border-primary hover:text-fg"
      }`}
    >
      {children}
    </button>
  )
}

function useSharedSettings() {
  const [settings, setSettings] = useState<WebSettings | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchSettings()
      .then((next) => {
        if (!cancelled) setSettings(next)
      })
      .catch((err: unknown) => reportError("load settings", err))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const patch = async (delta: Parameters<typeof saveSettings>[0]) => {
    const next = await saveSettings(delta)
    setSettings(next)
    return next
  }

  return { settings, loading, patch }
}

function GeneralSection({
  settings,
  patch,
}: {
  settings: WebSettings
  patch: (delta: Parameters<typeof saveSettings>[0]) => Promise<WebSettings>
}) {
  const themeState = useThemeState()
  return (
    <div className="space-y-3">
      <Card title="TUI appearance">
        <div>
          <div className="text-muted">Theme used by kobe-owned TUI panes</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {themeState.names.length === 0 ? (
              <span className="text-subtle">Loading themes...</span>
            ) : (
              themeState.names.map((name) => (
                <SelectButton
                  key={name}
                  active={settings.activeTheme === name}
                  onClick={() =>
                    void patch({ activeTheme: name }).then(() =>
                      pushToast("success", "TUI theme saved"),
                    )
                  }
                >
                  {name}
                </SelectButton>
              ))
            )}
          </div>
        </div>
        <ToggleRow
          label="Transparent terminal background"
          detail="Lets your host terminal background show through in TUI panes."
          enabled={settings.transparentBackground}
          onToggle={() =>
            void patch({
              transparentBackground: !settings.transparentBackground,
            })
          }
        />
        <div>
          <div className="text-muted">Focus accent</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[
              ["primary", "Primary"],
              ["success", "Success"],
              ["info", "Info"],
            ].map(([value, label]) => (
              <SelectButton
                key={value}
                active={settings.focusAccent === value}
                onClick={() =>
                  void patch({
                    focusAccent: value as WebSettings["focusAccent"],
                  })
                }
              >
                {label}
              </SelectButton>
            ))}
          </div>
        </div>
      </Card>

      <Card title="Dashboard appearance">
        <ThemePicker />
        {themeState.overridden ? (
          <button
            type="button"
            onClick={clearPreferredTheme}
            className="border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
          >
            Follow TUI theme
          </button>
        ) : (
          <p className="text-[11px] text-subtle">
            This browser is following the TUI theme unless you pick a local
            dashboard override.
          </p>
        )}
      </Card>

      <Card title="TUI notifications">
        <ToggleRow
          label="Toast popups"
          enabled={settings.notificationsToast}
          onToggle={() =>
            void patch({ notificationsToast: !settings.notificationsToast })
          }
        />
        <ToggleRow
          label="Sound"
          detail="Terminal bell plus chime for background chat-tab events."
          enabled={settings.notificationsSound}
          onToggle={() =>
            void patch({ notificationsSound: !settings.notificationsSound })
          }
        />
      </Card>

      <Card title="Editor and Settings surface">
        <div>
          <div className="text-muted">Settings page opens in</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <SelectButton
              active={settings.settingsSurface === "chattab"}
              onClick={() => void patch({ settingsSurface: "chattab" })}
            >
              ChatTab page
            </SelectButton>
            <SelectButton
              active={settings.settingsSurface === "taskpanel"}
              onClick={() => void patch({ settingsSurface: "taskpanel" })}
            >
              Task panel overlay
            </SelectButton>
          </div>
        </div>
        <div>
          <label className="block text-muted" htmlFor="editor-kind">
            File-tree editor
          </label>
          <select
            id="editor-kind"
            value={settings.editorKind}
            onChange={(event) =>
              void patch({
                editorKind: event.target.value as WebSettings["editorKind"],
              })
            }
            className="mt-1 w-full border border-line bg-bg px-2 py-1 text-fg focus:border-line-active focus:outline-none"
          >
            {["auto", "vim", "nvim", "nano", "emacs", "custom"].map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </div>
        <label className="block">
          <span className="text-muted">Custom editor command</span>
          <input
            value={settings.editorCustomCommand}
            onChange={(event) =>
              void patch({ editorCustomCommand: event.target.value })
            }
            placeholder="code -w {file}"
            className="mt-1 w-full border border-line bg-bg px-2 py-1 font-mono text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
          />
        </label>
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
    <div className="space-y-3">
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
    void fetchQuickPrompts().then((prompts) => {
      if (cancelled) return
      setReview(prompts.review ?? "")
      setPr(prompts.pr ?? "")
      setLoaded(true)
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
    <div className="space-y-3">
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

function BrowserNotificationsCard() {
  const { supported, permission, enabled } = useNotifyState()
  return (
    <Card title="Browser notifications">
      {supported ? (
        <button
          type="button"
          onClick={() => void setNotificationsEnabled(!enabled)}
          disabled={permission === "denied" && !enabled}
          className={`border px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
            enabled
              ? "border-primary bg-inset text-fg"
              : "border-line bg-bg text-muted hover:border-primary hover:text-fg"
          }`}
        >
          {enabled ? "Notifications on" : "Notifications off"}
        </button>
      ) : (
        <span className="font-mono text-[10px] text-subtle">unsupported</span>
      )}
      <p className="text-[11px] leading-relaxed text-subtle">
        {permission === "denied" && !enabled
          ? "Browser notifications are blocked in site settings."
          : "Get pinged when a task needs input or errors while this browser tab is in the background."}
      </p>
    </Card>
  )
}

function StatusSection() {
  const { daemonConnected, streamConnected, update } = useAppState()
  return (
    <div className="space-y-3">
      <Card title="Connection">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted">Daemon</span>
          <span
            className={daemonConnected ? "text-kobe-green" : "text-kobe-yellow"}
          >
            {daemonConnected ? "connected" : "offline"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted">Event stream</span>
          <span
            className={streamConnected ? "text-kobe-green" : "text-kobe-yellow"}
          >
            {streamConnected ? "connected" : "connecting"}
          </span>
        </div>
      </Card>
      <Card title="Version">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted">Current</span>
          <span className="text-fg">
            {typeof update?.current === "string" ? update.current : "unknown"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted">Latest</span>
          <span className="text-fg">
            {typeof update?.latest === "string" ? update.latest : "unknown"}
          </span>
        </div>
      </Card>
      <BrowserNotificationsCard />
    </div>
  )
}

function PlaceholderSection({ title, body }: { title: string; body: string }) {
  return (
    <Card title={title}>
      <p className="text-[11px] leading-relaxed text-subtle">{body}</p>
    </Card>
  )
}

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("general")
  const { settings, loading, patch } = useSharedSettings()
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
            {loading || !settings ? (
              <div className="border border-line bg-surface p-4 text-[12px] text-subtle">
                Loading settings...
              </div>
            ) : section === "general" ? (
              <GeneralSection settings={settings} patch={patch} />
            ) : section === "engines" ? (
              <EnginesSection settings={settings} patch={patch} />
            ) : section === "board" ? (
              <BoardSection />
            ) : section === "accounts" ? (
              <PlaceholderSection
                title="Accounts"
                body="The TUI shows local account detection for Claude, Codex, and Copilot. The web dashboard does not run those filesystem probes yet; engine availability still comes from the bridge's engine registry."
              />
            ) : section === "keys" ? (
              <PlaceholderSection
                title="Keybindings"
                body="Keybinding overrides live in ~/.kobe/settings/keybindings.yaml and are applied when TUI panes start. Editing that YAML from the browser is intentionally not exposed yet."
              />
            ) : section === "feedback" ? (
              <PlaceholderSection
                title="Feedback"
                body="Use `kobe feedback` or the TUI Settings feedback form to send GitHub Discussions through your authenticated gh session."
              />
            ) : section === "dev" ? (
              <DevSection settings={settings} patch={patch} />
            ) : (
              <StatusSection />
            )}
          </div>
        </main>
      </div>
    </section>
  )
}
