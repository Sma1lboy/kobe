/**
 * RoutinesPage — the daemon-owned scheduled Automations as the /chat shell's
 * "Routines" surface (docs/design/automations.md). v1: list with enable
 * toggle / run-now / delete, plus an inline create form (name, cron,
 * prompt, project). All data via automation.* RPCs — nothing client-owned.
 */

import { Play, Plus, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useEngines } from "../lib/engines.ts"
import { rpc, useAppState } from "../lib/store.ts"
import { relativeTime } from "../lib/time.ts"
import { engineLabel } from "../lib/vendor.ts"

interface Automation {
  id: string
  name: string
  repo: string
  prompt: string
  vendor?: string
  schedule: string
  enabled: boolean
  nextRunAt: string
  lastRunAt?: string
}

function repoBase(repo: string): string {
  const trimmed = repo.replace(/\/+$/, "")
  return trimmed.slice(trimmed.lastIndexOf("/") + 1)
}

export function RoutinesPage({
  embedded = false,
  initialRepo,
}: {
  embedded?: boolean
  /** Preselect this repo in the create form (the host's selected project). */
  initialRepo?: string
} = {}) {
  const { tasks } = useAppState()
  const engines = useEngines()
  const [automations, setAutomations] = useState<Automation[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const repos = useMemo(() => {
    const seen = new Set<string>()
    for (const t of tasks) if (t.repo) seen.add(t.repo)
    return [...seen]
  }, [tasks])

  const refresh = useCallback(() => {
    rpc<{ automations: Automation[] }>("automation.list")
      .then((res) => {
        setAutomations(res.automations)
        setError(null)
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
  }, [])
  useEffect(refresh, [refresh])

  const act = (id: string, run: () => Promise<unknown>): void => {
    setBusy(id)
    void run()
      .then(refresh)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(null))
  }

  // Create form state.
  const [name, setName] = useState("")
  const [schedule, setSchedule] = useState("0 9 * * *")
  const [prompt, setPrompt] = useState("")
  const [repo, setRepo] = useState(initialRepo ?? "")
  const [vendor, setVendor] = useState("")
  useEffect(() => {
    if (!repo && repos.length > 0) setRepo(initialRepo ?? repos[0] ?? "")
  }, [repo, repos, initialRepo])

  const create = (): void => {
    if (!name.trim() || !prompt.trim() || !repo) return
    act("__create", () =>
      rpc("automation.create", {
        name: name.trim(),
        repo,
        prompt: prompt.trim(),
        schedule: schedule.trim(),
        ...(vendor ? { vendor } : {}),
      }).then(() => {
        setCreating(false)
        setName("")
        setPrompt("")
      }),
    )
  }

  return (
    <div
      className={`flex flex-col overflow-hidden bg-bg text-fg ${embedded ? "h-full" : "h-screen"}`}
    >
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
          Routines
        </span>
        <span className="font-mono text-[10px] text-subtle">
          {automations.length}
        </span>
        <span className="text-[11px] text-subtle">
          a routine runs its prompt in a project on a schedule
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-3 border border-kobe-red/40 bg-kobe-red/10 px-3 py-2 text-[12px] text-kobe-red">
            {error}
          </div>
        )}

        <div className="flex max-w-3xl flex-col gap-2">
          {/* Persistent capture slot — same grammar as the kanban "+" tile. */}
          {creating ? (
            <div className="fade-up flex flex-col gap-2 border border-line bg-surface p-3">
              <div className="flex gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name"
                  className="h-7 flex-1 border border-line bg-bg px-2 text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
                />
                <input
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  placeholder="0 9 * * *"
                  title="Five-field cron, daemon-host local time"
                  className="h-7 w-32 border border-line bg-bg px-2 font-mono text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
                />
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Prompt — delivered as the engine's first message"
                rows={3}
                className="border border-line bg-bg px-2 py-1.5 text-[12px] text-fg placeholder:text-subtle focus:border-line-active focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <select
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  className="h-7 min-w-0 flex-1 border border-line bg-bg px-1 font-mono text-[11px] text-fg focus:outline-none"
                >
                  {repos.map((r) => (
                    <option key={r} value={r} className="bg-surface">
                      {repoBase(r)} · {r}
                    </option>
                  ))}
                </select>
                <select
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  className="h-7 border border-line bg-bg px-1 font-mono text-[11px] text-fg focus:outline-none"
                >
                  <option value="" className="bg-surface">
                    default engine
                  </option>
                  {engines.map((engine) => (
                    <option key={engine.id} value={engine.id} className="bg-surface">
                      {engineLabel(engines, engine.id)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={create}
                  disabled={busy !== null || !name.trim() || !prompt.trim()}
                  className="h-7 border border-primary bg-primary/10 px-3 text-[12px] text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="h-7 px-2 text-[12px] text-subtle hover:text-fg"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex items-center justify-center gap-1.5 border border-dashed border-line-subtle p-3 text-[11px] text-subtle transition-colors hover:border-primary hover:text-fg"
            >
              <Plus size={12} strokeWidth={2} />
              <span>New routine</span>
            </button>
          )}

          {automations.map((a) => (
            <div
              key={a.id}
              className={`flex items-center gap-3 border border-line bg-surface px-3 py-2 ${
                a.enabled ? "" : "opacity-60"
              }`}
            >
              <button
                type="button"
                onClick={() =>
                  act(a.id, () =>
                    rpc("automation.update", { id: a.id, enabled: !a.enabled }),
                  )
                }
                title={a.enabled ? "Disable" : "Enable"}
                className={`h-3.5 w-6 shrink-0 rounded-full border transition-colors ${
                  a.enabled
                    ? "border-primary bg-primary/60"
                    : "border-line bg-inset"
                }`}
              >
                <span
                  className={`block h-2.5 w-2.5 rounded-full bg-fg transition-transform ${
                    a.enabled ? "translate-x-3" : "translate-x-0.5"
                  }`}
                />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[13px] text-fg">{a.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-kobe-blue">
                    {a.schedule}
                  </span>
                  <span className="shrink-0 text-[11px] text-subtle">
                    {repoBase(a.repo)}
                    {a.vendor ? ` · ${engineLabel(engines, a.vendor)}` : ""}
                  </span>
                </div>
                <div className="truncate text-[11px] text-muted">{a.prompt}</div>
                <div className="text-[10px] text-subtle">
                  next {relativeTime(a.nextRunAt)}
                  {a.lastRunAt ? ` · last ${relativeTime(a.lastRunAt)}` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => act(a.id, () => rpc("automation.runNow", { id: a.id }))}
                disabled={busy === a.id}
                title="Run now"
                className="shrink-0 text-subtle transition-colors hover:text-kobe-green disabled:opacity-40"
              >
                <Play size={14} strokeWidth={2} />
              </button>
              <button
                type="button"
                onClick={() => act(a.id, () => rpc("automation.delete", { id: a.id }))}
                disabled={busy === a.id}
                title="Delete routine"
                className="shrink-0 text-subtle transition-colors hover:text-kobe-red disabled:opacity-40"
              >
                <Trash2 size={14} strokeWidth={2} />
              </button>
            </div>
          ))}

          {automations.length === 0 && !creating && (
            <div className="p-3 text-center text-[11px] text-subtle">
              No routines scheduled.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
