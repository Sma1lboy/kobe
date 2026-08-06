/**
 * The Settings page sections — General (theme), Notifications, Engines
 * (launch commands, collapsed rows with an inline editor), Board
 * (quick-action templates), and Dev (experimental gates + layout reset).
 * The frame lives in SettingsPage.tsx; shared controls in SettingsShared.tsx.
 */

import { ChevronRight } from "lucide-react"
import { useEffect, useState } from "react"
import { setNotificationsEnabled, useNotifyState } from "../lib/notify.ts"
import { fetchQuickPrompts, saveQuickPrompts } from "../lib/quick-prompts.ts"
import { DEFAULT_PR_TEMPLATE, defaultReviewTemplate } from "../lib/review.ts"
import type { WebSettings, WebSettingsEngine } from "../lib/settings.ts"
import { resetLayout } from "../lib/tabs.ts"
import { pushToast, reportError } from "../lib/toast.ts"
import {
  type PatchSettings,
  Row,
  Section,
  settingsInput,
  SwitchRow,
} from "./SettingsShared.tsx"
import { ThemePicker } from "./ThemePicker.tsx"

export function GeneralSection() {
  return (
    <Section title="Theme">
      <p className="pb-1 text-[11px] leading-relaxed text-subtle">
        Browser-local override — it never changes the TUI's theme.
      </p>
      <ThemePicker />
    </Section>
  )
}

/** One engine: a quiet row (● default marker · label · id · command) that
 *  expands into the inline editor. */
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
  const [open, setOpen] = useState(false)
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
    <div>
      <div className="flex items-center gap-2 py-1">
        <button
          type="button"
          onClick={() => onDefault(engine.id)}
          title={engine.isDefault ? "Default engine" : "Make default"}
          aria-label={`Make ${engine.label} the default engine`}
          className={`w-3 shrink-0 text-[11px] ${engine.isDefault ? "text-primary" : "text-subtle hover:text-fg"}`}
        >
          {engine.isDefault ? "●" : "○"}
        </button>
        <button
          type="button"
          onClick={() => setOpen((cur) => !cur)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="shrink-0 text-[12px] text-fg">{engine.label}</span>
          <span className="shrink-0 font-mono text-[10px] text-subtle">
            {engine.id}
            {engine.isCustom ? " · custom" : ""}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-subtle/70">
            {engine.command}
          </span>
          <ChevronRight
            size={12}
            strokeWidth={2}
            className={`shrink-0 text-subtle transition-transform ${open ? "rotate-90" : ""}`}
          />
        </button>
      </div>
      {open && (
        <div className="mb-2 ml-5 space-y-2 border-l border-line pl-3 pt-1">
          <label className="block">
            <span className="text-[11px] text-subtle">Display name</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className={`mt-1 w-full ${settingsInput}`}
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-subtle">
              Launch command (argv kobe runs — flags live here)
            </span>
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              className={`mt-1 w-full font-mono ${settingsInput}`}
            />
          </label>
          {labelLooksLikeCommand ? (
            <div className="text-[11px] leading-relaxed text-kobe-yellow">
              That looks like a flag in the display name — the label is never
              executed; put flags in Launch command.
            </div>
          ) : null}
          <div className="flex items-center gap-3 pb-1">
            <button
              type="button"
              onClick={() => onSave(engine.id, command, label)}
              className="border border-primary bg-primary/10 px-2 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/20"
            >
              Save
            </button>
            {engine.isCustom ? (
              <button
                type="button"
                onClick={() => onRemove(engine.id)}
                className="text-[11px] text-subtle transition-colors hover:text-kobe-red"
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

export function EnginesSection({
  settings,
  patch,
}: {
  settings: WebSettings
  patch: PatchSettings
}) {
  const [adding, setAdding] = useState(false)
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
    <Section title="Engines">
      <p className="pb-1 text-[11px] leading-relaxed text-subtle">
        Shared with the TUI. ● marks the default; click a row to edit its
        launch command. Custom engines show up in the new-task and tab pickers.
      </p>
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
      {adding ? (
        <div className="ml-5 space-y-2 border-l border-line pl-3 pt-1">
          <div className="grid gap-2 md:grid-cols-3">
            <input
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="id, e.g. aider"
              className={settingsInput}
            />
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="command"
              className={`font-mono ${settingsInput}`}
            />
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="display name"
              className={settingsInput}
            />
          </div>
          <div className="flex items-center gap-3 pb-1">
            <button
              type="button"
              onClick={() =>
                void patch({ addEngine: { id, command, label } })
                  .then(() => {
                    setId("")
                    setCommand("")
                    setLabel("")
                    setAdding(false)
                    pushToast("success", "engine added")
                  })
                  .catch((err: unknown) => reportError("add engine", err))
              }
              className="border border-primary bg-primary/10 px-2 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/20"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="text-[11px] text-subtle hover:text-fg"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="py-1 text-[11px] text-subtle transition-colors hover:text-fg"
        >
          + Add engine
        </button>
      )}
    </Section>
  )
}

export function BoardSection() {
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
    <Section title="Board quick actions">
      <label className="block">
        <span className="text-[11px] text-subtle">Review template</span>
        <textarea
          value={review}
          onChange={(event) => setReview(event.target.value)}
          placeholder={`default: ${defaultReviewTemplate("claude")}`}
          rows={3}
          disabled={!loaded}
          className={`mt-1 w-full resize-y font-mono ${settingsInput}`}
        />
      </label>
      <label className="block">
        <span className="text-[11px] text-subtle">Open-PR template</span>
        <textarea
          value={pr}
          onChange={(event) => setPr(event.target.value)}
          placeholder={`default:\n${DEFAULT_PR_TEMPLATE}`}
          rows={5}
          disabled={!loaded}
          className={`mt-1 w-full resize-y font-mono ${settingsInput}`}
        />
      </label>
      <div className="flex items-center justify-between gap-3 pt-1">
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
          className="shrink-0 border border-primary bg-primary/10 px-2 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </Section>
  )
}

export function DevSection({
  settings,
  patch,
}: {
  settings: WebSettings
  patch: PatchSettings
}) {
  const [armed, setArmed] = useState(false)
  return (
    <Section title="Dev">
      <SwitchRow
        label="Remote projects"
        detail="Enables SSH-backed remote project setup in the CLI."
        enabled={settings.remoteProjects}
        onToggle={() => void patch({ remoteProjects: !settings.remoteProjects })}
      />
      <SwitchRow
        label="Archived history preview"
        detail="Beta: preview an archived task's read-only engine history after its worktree is gone."
        enabled={settings.archivedHistoryPreview}
        onToggle={() =>
          void patch({
            archivedHistoryPreview: !settings.archivedHistoryPreview,
          })
        }
      />
      <SwitchRow
        label="Auto status flow"
        detail="Moves backlog tasks to in progress on turn start and injects the self-report protocol."
        enabled={settings.autoStatus}
        onToggle={() => void patch({ autoStatus: !settings.autoStatus })}
      />
      <SwitchRow
        label="Dispatcher"
        detail="Enables the field-notes dispatcher protocol for repo main sessions."
        enabled={settings.dispatcher}
        onToggle={() => void patch({ dispatcher: !settings.dispatcher })}
      />
      <Row
        label="Reset workspace layout"
        detail="Open tabs, splits, and selection — pure browser state; tasks and worktrees are untouched."
      >
        <button
          type="button"
          onClick={() => {
            if (!armed) {
              setArmed(true)
              return
            }
            resetLayout()
            setArmed(false)
            pushToast("info", "Workspace layout reset")
          }}
          onBlur={() => setArmed(false)}
          className={`border px-2 py-0.5 text-[11px] transition-colors ${
            armed
              ? "border-kobe-red/50 bg-kobe-red/10 text-kobe-red"
              : "border-line bg-bg text-muted hover:border-primary hover:text-fg"
          }`}
        >
          {armed ? "Click again" : "Reset"}
        </button>
      </Row>
    </Section>
  )
}

export function NotificationsSection() {
  const { supported, permission, enabled } = useNotifyState()
  return (
    <Section title="Notifications">
      {supported ? (
        <SwitchRow
          label="Desktop notifications"
          detail="Get pinged when a task needs input or errors while this window is in the background."
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
          Notifications are blocked for this site — allow them in the browser's
          site settings first.
        </p>
      ) : null}
    </Section>
  )
}
