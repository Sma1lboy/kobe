/**
 * kobe application shell — full 5-pane Wave 3 layout.
 *
 * Layout (left → right): Sidebar | Chat | RightColumn{ FileTree, Preview, Terminal }
 *
 * Wiring:
 *   - Active task is selected in Sidebar (Stream F) and propagates a
 *     `selectedId` Solid signal that drives every other pane.
 *   - `worktreePath` is derived from the active task and feeds FileTree
 *     (Stream H), Preview (Stream I), and Terminal (Stream J).
 *   - FileTree's `onOpenFile` calls into Preview's imperative API, captured
 *     once via the `onOpen` callback.
 *   - Terminal owns one pty per task (resolved Wave 1 decision §5).
 *
 * Engine selection:
 *   - Default: `ClaudeCodeLocal` (subprocess wrapper around `claude` CLI).
 *   - With `KOBE_TEST_ENGINE=fake`: in-process `FakeAIEngine` plus a tiny
 *     HTTP side-channel on `KOBE_TEST_FAKE_PORT` for behavior tests to
 *     script events. The test pre-allocates the port and POSTs JSON to
 *     `/script` and `/finish`. Production never sets the env vars.
 */

import * as fs from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { TextAttributes } from "@opentui/core"
import { render, useTerminalDimensions } from "@opentui/solid"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import pkg from "../../package.json" with { type: "json" }
import { ClaudeCodeLocal } from "../engine/claude-code-local/index.ts"
import { Orchestrator } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"
import type { AIEngine } from "../types/engine.ts"
import type { ChatTab, Task } from "../types/task.ts"
import { type UpdateInfo, checkLatestVersion } from "../version.ts"
import { CreatePRButton } from "./component/create-pr-button"
import { HelpDialog } from "./component/help-dialog"
import { ResizableEdge } from "./component/resizable-edge"
import { SettingsDialog } from "./component/settings-dialog"
import { UpdateDialog } from "./component/update-dialog"
import { CommandPaletteProvider } from "./context/command-palette"
import { FocusProvider, type PaneId, useFocus } from "./context/focus"
import { KobeKeymap, bindByIds, useCtrlCArmed, useKobeKeybindings } from "./context/keybindings"
import { KVProvider, useKV } from "./context/kv"
import { SyncProvider } from "./context/sync"
import { ThemeProvider, useTheme } from "./context/theme"
import { useBindings } from "./lib/keymap"
import { Chat } from "./panes/chat/Chat"
import { FileTree } from "./panes/filetree"
import { Preview, type PreviewApi } from "./panes/preview"
import { Sidebar } from "./panes/sidebar/Sidebar"
import { Terminal } from "./panes/terminal"
import { type DialogContext, DialogProvider, useDialog } from "./ui/dialog"
import { DialogConfirm } from "./ui/dialog-confirm"

const DEFAULT_THEME = "conductor"

/* --------------------------------------------------------------------- */
/*  Engine selection + fake-engine side-channel                           */
/* --------------------------------------------------------------------- */

/**
 * Build the AI engine the orchestrator will drive. Test mode uses
 * `FakeAIEngine` and mounts the side-channel HTTP server.
 */
async function buildEngine(): Promise<AIEngine> {
  if (process.env.KOBE_TEST_ENGINE === "fake") {
    // Late import — keep test-only deps out of production bundles.
    const { FakeAIEngine } = await import("../../test/behavior/fake-engine.ts")
    const fake = new FakeAIEngine()
    await mountFakeEngineServer(fake)
    return fake
  }
  return new ClaudeCodeLocal()
}

/**
 * Tiny HTTP side-channel for the G2 behavior test. The test pre-allocates
 * a port (via `KOBE_TEST_FAKE_PORT`) and POSTs scripted events to it.
 * Kobe runs in a child process so we can't share the FakeAIEngine
 * instance via memory; HTTP is the simplest cross-process scripting
 * mechanism that works under Bun + macOS without extra deps.
 */
async function mountFakeEngineServer(fake: import("../../test/behavior/fake-engine.ts").FakeAIEngine): Promise<void> {
  const portStr = process.env.KOBE_TEST_FAKE_PORT
  if (!portStr) return
  const port = Number(portStr)
  if (!Number.isFinite(port)) return

  const { createServer } = await import("node:http")
  const server = createServer((req, res) => {
    if (req.method !== "POST" && req.method !== "GET") {
      res.writeHead(405).end()
      return
    }
    let body = ""
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8")
    })
    req.on("end", () => {
      try {
        if (req.url === "/script" && req.method === "POST") {
          const { sessionId, events } = JSON.parse(body) as { sessionId: string; events: unknown[] }
          fake.script(sessionId, events as Parameters<typeof fake.script>[1])
          res.writeHead(200, { "content-type": "application/json" })
          res.end("{}")
          return
        }
        if (req.url === "/finish" && req.method === "POST") {
          const { sessionId } = JSON.parse(body) as { sessionId: string }
          fake.finish(sessionId)
          res.writeHead(200, { "content-type": "application/json" })
          res.end("{}")
          return
        }
        // Test affordance for W4.PR: trigger requestPR on the active
        // task. The Shell mounts a global function that knows the
        // active task; we call it from here. Returns 503 if the Shell
        // hasn't mounted yet (pre-render race window).
        if (req.url === "/pr" && req.method === "POST") {
          type PRTrigger = () => Promise<{ taskId: string; prompt: string }>
          const trigger = (globalThis as { __kobeTestRequestPR?: PRTrigger }).__kobeTestRequestPR
          if (!trigger) {
            res.writeHead(503, { "content-type": "text/plain" })
            res.end("__kobeTestRequestPR not yet available")
            return
          }
          trigger()
            .then((info) => {
              res.writeHead(200, { "content-type": "application/json" })
              res.end(JSON.stringify(info))
            })
            .catch((err: unknown) => {
              res.writeHead(500, { "content-type": "text/plain" })
              res.end(err instanceof Error ? err.message : String(err))
            })
          return
        }
        // Test affordance for the user-input pause flows. Mirrors
        // /pr above: the Shell mounts __kobeTestRespondToInput which
        // knows the active task + its current pending-input bucket.
        // The test POSTs the body of an ApprovePlanResponse or
        // AskQuestionResponse and we route it through respondToInput
        // for the latest pending request. Returns 503 pre-mount, 409
        // when there's no pending request yet (the test should wait
        // for the picker to render), 200 with the resolved requestId
        // on success.
        if (req.url === "/respond" && req.method === "POST") {
          type RespondTrigger = (
            response: import("../types/engine.ts").UserInputResponse,
          ) => Promise<{ taskId: string; requestId: string; prompt: string }>
          const trigger = (globalThis as { __kobeTestRespondToInput?: RespondTrigger }).__kobeTestRespondToInput
          if (!trigger) {
            res.writeHead(503, { "content-type": "text/plain" })
            res.end("__kobeTestRespondToInput not yet available")
            return
          }
          let parsed: import("../types/engine.ts").UserInputResponse
          try {
            parsed = JSON.parse(body) as import("../types/engine.ts").UserInputResponse
          } catch (err) {
            res.writeHead(400, { "content-type": "text/plain" })
            res.end(`bad JSON: ${(err as Error).message}`)
            return
          }
          trigger(parsed)
            .then((info) => {
              res.writeHead(200, { "content-type": "application/json" })
              res.end(JSON.stringify(info))
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err)
              // No-pending-request is a 409 so the test can distinguish
              // "you raced" from "the engine actually failed."
              const code = msg.includes("no pending input") ? 409 : 500
              res.writeHead(code, { "content-type": "text/plain" })
              res.end(msg)
            })
          return
        }
        res.writeHead(404).end()
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" })
        res.end((err as Error).message)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()))
  // Don't keep the event loop alive on this server alone.
  server.unref()
}

/* --------------------------------------------------------------------- */
/*  New-task dialog                                                       */
/* --------------------------------------------------------------------- */

type NewTaskInput = { repo: string; baseRef: string }

/** Default base ref when the user leaves the field blank. */
const DEFAULT_BASE_REF = "main"

/**
 * Strip CR/LF from a single-line input value. opentui's `<input>`
 * happily inserts a literal `\n` when the user presses enter inside a
 * focused field — even though the same press also fires `onSubmit` —
 * so the value rendered back to the field shows the stray newline as
 * a glyph (looks like an extra "n" on macOS terminals). We sanitize at
 * the onInput edge so the signal never carries a newline; the
 * onSubmit handler still fires and commits the trimmed-but-newline-
 * free value.
 */
function stripNewlines(v: string): string {
  return v.replace(/[\r\n]+/g, "")
}

/**
 * Validate a repo path entered in the new-task dialog. Returns null
 * when the path looks like a usable git repo, or a human-readable
 * reason string otherwise. The dialog renders the reason inline and
 * blocks submission so a typo'd path doesn't get persisted as
 * `lastNewTaskRepo` and can't drag every subsequent `runTask` into
 * `git worktree add` failures.
 *
 * Two checks (in order):
 *   1. The path exists and is a directory. We do NOT recursively
 *      create — a non-existent path is almost always a typo, not a
 *      "please mkdir for me" request.
 *   2. `git -C <path> rev-parse --git-dir` succeeds. This catches
 *      both "exists but not a repo" and "exists but git is unhappy"
 *      with a single check.
 */
function validateRepoPath(repo: string): string | null {
  const trimmed = repo.trim()
  if (!trimmed) return "repo path is required"
  // existsSync + statSync.isDirectory in one shot.
  let stat: import("node:fs").Stats
  try {
    stat = fs.statSync(trimmed)
  } catch {
    return `path does not exist: ${trimmed}`
  }
  if (!stat.isDirectory()) return `not a directory: ${trimmed}`
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    const out = spawnSync("git", ["rev-parse", "--git-dir"], {
      cwd: trimmed,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (out.status !== 0) return `not a git repository: ${trimmed}`
  } catch {
    return `not a git repository: ${trimmed}`
  }
  return null
}

/**
 * List local branches in the given repo, sorted with the default branch
 * first when present. Synchronous — repo enumeration is a one-shot call
 * driven by the dialog's repo-field changes, so paying for an async
 * boundary buys nothing. Returns [] on any error so the picker just
 * silently degrades to the free-text input.
 */
function listLocalBranches(repo: string): string[] {
  if (!repo) return []
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    const out = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
      cwd: repo,
      encoding: "utf-8",
      timeout: 2000,
    })
    if (out.status !== 0) return []
    return (out.stdout as string)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort((a, b) => {
        // Default branches first.
        const score = (n: string) => (n === "main" ? 0 : n === "master" ? 1 : n === "develop" ? 2 : 3)
        const sa = score(a)
        const sb = score(b)
        if (sa !== sb) return sa - sb
        return a.localeCompare(b)
      })
  } catch {
    return []
  }
}

/**
 * The new-task dialog. Per the Wave 3 G architectural pivot, we no
 * longer ask the user to type a separate title — Claude Code does
 * not store one (verified against the stream-json schema), so anything
 * we collect would be a parallel piece of metadata users would have
 * to maintain. Instead we ask for two fields:
 *
 *   1. `prompt` — the user's first message to Claude. The orchestrator
 *      derives a sidebar title from it via {@link deriveTitleFromPrompt}.
 *   2. `repo path` — defaults to `process.cwd()`.
 *
 * `tab` switches focus; `enter` on the last field commits.
 */
function NewTaskDialog(props: {
  onSubmit: (v: NewTaskInput) => void
  onCancel: () => void
  defaultRepo: string
  /**
   * User-curated repo list, persisted via `/add-repo`. Surfaced in the
   * dialog as a picker beneath the repo input. The current launch
   * directory (`defaultRepo`) is always prepended so the user can pick
   * "where I started kobe" without having to add it first.
   */
  savedRepos: readonly string[]
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  // Dialog only asks for repo + branch now. The first prompt lives in
  // the chat composer — orchestrator.runTask back-fills the task title
  // from it on first submit (see PLACEHOLDER_TASK_TITLE in core.ts).
  // Tab cycles between the two fields.
  const [field, setField] = createSignal<"repo" | "baseRef">("repo")
  const [repo, setRepo] = createSignal(props.defaultRepo)
  const [baseRef, setBaseRef] = createSignal(DEFAULT_BASE_REF)

  // Repo picker — `defaultRepo` (cwd at launch) always appears first;
  // user-saved repos follow, deduped against the cwd. Up/down on the
  // repo field navigates this list and pre-fills the input so `enter`
  // commits the highlighted choice. Free-text editing is still allowed
  // — the picker is an affordance, not a constraint.
  const repoOptions = createMemo<readonly string[]>(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const p of [props.defaultRepo, ...props.savedRepos]) {
      const t = p.trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
    return out
  })
  // Substring filter against the repo input. Case-insensitive; empty
  // input returns the full list. The picker is augmenting the input,
  // not gating it, so an exact-match input still appears in the list.
  const repoFiltered = createMemo<readonly string[]>(() => {
    const all = repoOptions()
    const q = repo().trim().toLowerCase()
    if (!q) return all
    return all.filter((p) => p.toLowerCase().includes(q))
  })
  const [repoCursor, setRepoCursor] = createSignal(0)

  // Branch picker — refreshed whenever the repo path changes. The
  // baseRef field still accepts free text (so tags / commit SHAs / refs
  // not in the local branch list still work), but typing is augmented
  // with up/down navigation over the discovered branches: highlights
  // the cursor row and pre-fills the input as the user moves.
  const branches = createMemo<readonly string[]>(() => listLocalBranches(repo().trim()))
  // Type-to-filter on the baseRef input. Same rules as the repo
  // filter — empty query returns everything; non-empty does a
  // case-insensitive substring match.
  const branchFiltered = createMemo<readonly string[]>(() => {
    const all = branches()
    const q = baseRef().trim().toLowerCase()
    if (!q) return all
    return all.filter((b) => b.toLowerCase().includes(q))
  })
  const [branchCursor, setBranchCursor] = createSignal(0)

  // Reset cursors whenever the filtered list changes — typing should
  // always land the highlight on the first match, otherwise the cursor
  // can sit on a now-hidden index and feels broken.
  createEffect(() => {
    void branchFiltered()
    setBranchCursor(0)
  })
  createEffect(() => {
    void repoFiltered()
    setRepoCursor(0)
  })

  // Picker windowing — same shape as the slash dropdown's `slashWindow`
  // (src/tui/panes/chat/Composer.tsx). Caps visible rows so a repo with
  // 80+ branches doesn't push the rest of the dialog off-screen; the
  // window scrolls to keep the cursor in view.
  const PICKER_MAX_VISIBLE = 8
  type PickerWindow = { items: readonly string[]; start: number; total: number }
  function windowAround(list: readonly string[], cursor: number): PickerWindow {
    const total = list.length
    if (total <= PICKER_MAX_VISIBLE) return { items: list, start: 0, total }
    const half = Math.floor(PICKER_MAX_VISIBLE / 2)
    let start = Math.max(0, cursor - half)
    if (start + PICKER_MAX_VISIBLE > total) start = total - PICKER_MAX_VISIBLE
    return { items: list.slice(start, start + PICKER_MAX_VISIBLE), start, total }
  }
  const repoWindow = createMemo<PickerWindow>(() => windowAround(repoFiltered(), repoCursor()))
  const branchWindow = createMemo<PickerWindow>(() => windowAround(branchFiltered(), branchCursor()))

  // Validation error shown inline when the user tries to submit a bad
  // repo path. Null while the user is still typing — we don't shout
  // before they're done. Cleared on every keystroke that changes the
  // repo field so the message doesn't linger after they fix the typo.
  const [submitError, setSubmitError] = createSignal<string | null>(null)
  createEffect(() => {
    void repo()
    setSubmitError(null)
  })

  function commit() {
    const r = repo().trim()
    if (!r) return
    const reason = validateRepoPath(r)
    if (reason) {
      setSubmitError(reason)
      // Snap focus back to the repo field — the user has to fix it
      // before anything else matters.
      setField("repo")
      return
    }
    const b = baseRef().trim() || DEFAULT_BASE_REF
    props.onSubmit({ repo: r, baseRef: b })
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      {
        // Tab toggles between repo and branch. Visual top-to-bottom
        // order so muscle memory works.
        key: "tab",
        cmd: () => setField((f) => (f === "repo" ? "baseRef" : "repo")),
      },
      // up/down are field-scoped: on the repo field they navigate the
      // saved-repos picker; on the baseRef field they navigate the
      // branch picker. Both pre-fill the input so `enter` commits the
      // highlighted choice. Free-text editing remains available in
      // either field.
      {
        key: "up",
        cmd: () => {
          if (field() === "repo") {
            const list = repoFiltered()
            if (list.length === 0) return
            const next = Math.max(0, repoCursor() - 1)
            setRepoCursor(next)
            // Don't pre-fill the input on arrow nav — that would
            // collapse the filter to whatever the cursor is on and
            // jump the list. Selection happens on enter / click.
            return
          }
          if (field() !== "baseRef") return
          const list = branchFiltered()
          if (list.length === 0) return
          const next = Math.max(0, branchCursor() - 1)
          setBranchCursor(next)
        },
      },
      {
        key: "down",
        cmd: () => {
          if (field() === "repo") {
            const list = repoFiltered()
            if (list.length === 0) return
            const next = Math.min(list.length - 1, repoCursor() + 1)
            setRepoCursor(next)
            return
          }
          if (field() !== "baseRef") return
          const list = branchFiltered()
          if (list.length === 0) return
          const next = Math.min(list.length - 1, branchCursor() + 1)
          setBranchCursor(next)
        },
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          New task
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box gap={0}>
        <text fg={field() === "repo" ? theme.accent : theme.textMuted}>repo path</text>
        <input
          value={repo()}
          placeholder={props.defaultRepo}
          focused={field() === "repo"}
          onInput={(v: string) => setRepo(stripNewlines(v))}
          onSubmit={() => {
            // If the picker has a highlighted match, prefer it over
            // the typed text (matches the branch field's behavior).
            const list = repoFiltered()
            const picked = list[repoCursor()]
            if (picked) setRepo(picked)
            if (!repo().trim()) return
            commit()
          }}
        />
      </box>
      {/* Repo picker: rendered when the repo field is focused. Lists
          the launch cwd plus user-saved repos (`/add-repo`), filtered
          by what the user types. Up/down navigate, click selects. */}
      <Show when={field() === "repo" && repoFiltered().length > 0}>
        <box gap={0} paddingLeft={2} paddingBottom={1}>
          <Show when={repoWindow().start > 0}>
            <text fg={theme.textMuted} wrapMode="none">
              ↑ {repoWindow().start} more
            </text>
          </Show>
          <For each={repoWindow().items}>
            {(path, i) => {
              const absoluteIndex = () => repoWindow().start + i()
              const isCursor = () => absoluteIndex() === repoCursor()
              const isSelected = () => repo().trim() === path
              return (
                <text
                  fg={isCursor() ? theme.primary : isSelected() ? theme.accent : theme.textMuted}
                  attributes={isCursor() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                  onMouseUp={() => {
                    setRepo(path)
                    setRepoCursor(absoluteIndex())
                  }}
                >
                  {isCursor() ? "▸ " : "  "}
                  {path}
                </text>
              )
            }}
          </For>
          <Show when={repoWindow().start + repoWindow().items.length < repoWindow().total}>
            <text fg={theme.textMuted} wrapMode="none">
              ↓ {repoWindow().total - repoWindow().start - repoWindow().items.length} more
            </text>
          </Show>
        </box>
      </Show>
      <Show when={submitError()}>
        <text fg={theme.error}>※ {submitError()}</text>
      </Show>
      <box gap={0}>
        <text fg={field() === "baseRef" ? theme.accent : theme.textMuted}>from branch</text>
        <input
          value={baseRef()}
          placeholder={DEFAULT_BASE_REF}
          focused={field() === "baseRef"}
          onInput={(v: string) => setBaseRef(stripNewlines(v))}
          onSubmit={() => {
            // Prefer the highlighted branch in the picker over the
            // typed text. Free-text only kicks in when nothing matches
            // (typed a tag / commit SHA the local branch list doesn't know).
            const list = branchFiltered()
            const picked = list[branchCursor()]
            if (picked) setBaseRef(picked)
            commit()
          }}
        />
      </box>
      {/* Branch picker empty-state: the repo had no discoverable
          local branches, OR the user typed a filter that doesn't
          match any. Either way show a soft hint so the user knows
          their typed text will be used as a literal ref (tag / SHA
          / remote ref) rather than chosen from a list. */}
      <Show
        when={
          field() === "baseRef" &&
          branchFiltered().length === 0 &&
          // Don't shout when validateRepoPath has already complained
          // about the upstream issue.
          submitError() == null
        }
      >
        <box gap={0} paddingLeft={2} paddingBottom={1}>
          <text fg={theme.textMuted} wrapMode="none">
            {branches().length === 0
              ? "(no local branches found — typed text will be used as ref)"
              : "(no match — typed text will be used as ref)"}
          </text>
        </box>
      </Show>
      {/* Branch picker: rendered when on baseRef field and the repo
          actually has discoverable branches matching the input. Up/down
          navigate the (windowed) list; click selects + commits. The
          ↑/↓ N more indicators surface truncation when the repo has
          more matching branches than the cap. */}
      <Show when={field() === "baseRef" && branchFiltered().length > 0}>
        <box gap={0} paddingLeft={2} paddingBottom={1}>
          <Show when={branchWindow().start > 0}>
            <text fg={theme.textMuted} wrapMode="none">
              ↑ {branchWindow().start} more
            </text>
          </Show>
          <For each={branchWindow().items}>
            {(name, i) => {
              const absoluteIndex = () => branchWindow().start + i()
              const isCursor = () => absoluteIndex() === branchCursor()
              const isSelected = () => baseRef().trim() === name
              return (
                <text
                  fg={isCursor() ? theme.primary : isSelected() ? theme.accent : theme.textMuted}
                  attributes={isCursor() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                  onMouseUp={() => {
                    setBaseRef(name)
                    setBranchCursor(absoluteIndex())
                    commit()
                  }}
                >
                  {isCursor() ? "▸ " : "  "}
                  {name}
                </text>
              )
            }}
          </For>
          <Show when={branchWindow().start + branchWindow().items.length < branchWindow().total}>
            <text fg={theme.textMuted} wrapMode="none">
              ↓ {branchWindow().total - branchWindow().start - branchWindow().items.length} more
            </text>
          </Show>
        </box>
      </Show>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>tab fields · type to filter · ↑↓ pick · enter create · esc cancel</text>
      </box>
    </box>
  )
}

function showNewTaskDialog(
  dialog: DialogContext,
  defaultRepo: string,
  savedRepos: readonly string[],
): Promise<NewTaskInput | undefined> {
  return new Promise<NewTaskInput | undefined>((resolve) => {
    dialog.replace(
      () => (
        <NewTaskDialog
          defaultRepo={defaultRepo}
          savedRepos={savedRepos}
          onSubmit={(v) => resolve(v)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

/* --------------------------------------------------------------------- */
/*  Rename-task dialog                                                    */
/* --------------------------------------------------------------------- */

/**
 * Single-field rename dialog. Sidebar `r` opens this for the cursor task
 * with the current title pre-filled in the input so the user can edit
 * in place. Enter commits, esc cancels (handled by the dialog stack).
 *
 * Trim + empty-string guard: `enter` on an empty/whitespace-only value
 * is a no-op (we don't dismiss, so the user notices nothing happened
 * and can either type something or hit esc). The orchestrator's
 * setTitle defends in depth.
 */
function RenameTaskDialog(props: {
  currentTitle: string
  onSubmit: (title: string) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [title, setTitle] = createSignal(props.currentTitle)

  function commit() {
    const t = title().trim()
    if (!t) return
    props.onSubmit(t)
    dialog.clear()
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Rename task
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box gap={0}>
        <text fg={theme.accent}>title</text>
        <input
          value={title()}
          placeholder={props.currentTitle}
          focused={true}
          onInput={(v: string) => setTitle(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>enter rename · esc cancel</text>
      </box>
    </box>
  )
}

function showRenameTaskDialog(dialog: DialogContext, currentTitle: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    dialog.replace(
      () => (
        <RenameTaskDialog
          currentTitle={currentTitle}
          onSubmit={(v) => resolve(v)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

/* --------------------------------------------------------------------- */
/*  Top-level Shell                                                       */
/* --------------------------------------------------------------------- */

export type AppDeps = {
  orchestrator: Orchestrator
}

/* --------------------------------------------------------------------- */
/*  PaneHeader — uniform CAPS-bold pane label (agent-deck-style chunking)  */
/* --------------------------------------------------------------------- */
function PaneHeader(props: { title: string; subtitle?: string; focused?: boolean }) {
  const { theme } = useTheme()
  // Focused panes use `theme.success` (green) — the rest of the focus
  // affordance system (resize edges, status bar) already uses green for
  // "active." Picking the same hue here unifies the language so a
  // glance anywhere on screen confirms which pane has focus. Blue
  // (theme.primary) was reserved for branding/links and getting
  // confused with focus state, especially on terminals where blue
  // tends to look mid-saturation against the pane background.
  //
  // The leading `▌` block character in green is the additional
  // visibility hammer the prior bold-blue title was missing — it
  // attaches the focus signal to the title visually so the user's eye
  // doesn't have to scan the whole screen to pick up the active pane.
  const focused = () => props.focused !== false
  const titleColor = () => (focused() ? theme.success : theme.textMuted)
  return (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={1} flexShrink={1}>
        <Show when={focused()} fallback={<text fg={theme.textMuted}> </text>}>
          <text fg={theme.success} attributes={TextAttributes.BOLD} wrapMode="none">
            ▌
          </text>
        </Show>
        <text fg={titleColor()} attributes={TextAttributes.BOLD} wrapMode="none">
          {props.title}
        </text>
      </box>
      <Show when={props.subtitle}>
        <text fg={theme.textMuted} wrapMode="none">
          {props.subtitle}
        </text>
      </Show>
    </box>
  )
}

/**
 * `[Key]` chip — agent-deck-style key affordance. The key is wrapped in
 * literal brackets in BOLD accent color; label follows in muted text.
 * No filled background → terminal shows through.
 */
function Hotkey(props: { keys: string; label: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
        [{props.keys}]
      </text>
      <text fg={theme.textMuted} wrapMode="none">
        {props.label}
      </text>
    </box>
  )
}

/**
 * Bottom status bar — agent-deck style. Left side: focused-pane label +
 * pane-local hotkeys. Right side: always-on global hotkeys. Reads the
 * focused pane from context so the parent doesn't need to thread it.
 */
function StatusBar() {
  const { theme } = useTheme()
  const focus = useFocus()
  const ctrlCArmed = useCtrlCArmed()
  const sectionLabel = () => {
    switch (focus.focused()) {
      case "sidebar":
        return "Tasks:"
      case "workspace":
        return "Chat:"
      case "files":
        return "Files:"
      case "terminal":
        return "Terminal:"
    }
  }
  // Pane-local hints come from KobeKeymap by scope; only rows with a
  // non-pinned `hint` and a `scope` matching the focused pane and a
  // workspace-detach exception (esc detach is global but we want it to
  // surface only while workspace is focused — sidebar already IS sidebar,
  // files/terminal use it more rarely). The condition is simple: `hint
  // && !pin && (scope === focused || (id === "focus.detach" && focused
  // === "workspace"))`.
  const leftHints = () =>
    KobeKeymap.filter((b) => {
      if (!b.hint || b.hint.pin) return false
      if (b.scope === focus.focused()) return true
      if (b.id === "focus.detach" && focus.focused() === "workspace") return true
      return false
    })
  // Right column = anything pinned right; order preserved from KobeKeymap.
  const rightHints = KobeKeymap.filter((b) => b.hint?.pin === "right")

  return (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {/* Left: section label + pane-local hotkeys (driven by KobeKeymap) */}
      <box flexDirection="row" gap={2} flexShrink={1}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          {sectionLabel()}
        </text>
        <For each={leftHints()}>{(b) => <Hotkey keys={b.hint!.keys} label={b.hint!.label} />}</For>
      </box>
      {/* Right: global hotkeys (always available). Driven by KobeKeymap's
          `pin: "right"` rows. When ctrl+c is armed for double-tap quit,
          the `app.quit` chip is replaced by a warning hint so the user
          knows the next ctrl+c will exit. */}
      <box flexDirection="row" gap={2} flexShrink={0}>
        <For each={rightHints}>
          {(b) =>
            b.id === "app.quit" ? (
              <Show when={ctrlCArmed()} fallback={<Hotkey keys={b.hint!.keys} label={b.hint!.label} />}>
                <text fg={theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
                  Press Ctrl+C again to exit
                </text>
              </Show>
            ) : (
              <Hotkey keys={b.hint!.keys} label={b.hint!.label} />
            )
          }
        </For>
      </box>
    </box>
  )
}

function TopBar(props: {
  orchestrator: Orchestrator
  activeTask: Accessor<Task | undefined>
  updateInfo: Accessor<UpdateInfo | null>
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  // Three columns of equal flex so the center sits at the geometric
  // midpoint regardless of the left brand width or the right PR button
  // width. Left = brand+version. Center = active task's branch (no
  // "Repo <name>" prefix — kobe spans many repos so a single repo
  // label in the topbar is misleading; the active branch alone is the
  // useful per-task signal). Right = PR action.
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} gap={1} justifyContent="flex-start">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          KobeCode
        </text>
        <text fg={theme.textMuted}>v{pkg.version}</text>
        {/* Update chip — clickable: opens the UpdateDialog with the
            install command and the GitHub release notes for what's new.
            Only renders when the npm-registry check found a newer
            published version. Informational only — no auto-update.
            Suppressed entirely in dev mode (KOBE_DEV=1, set by
            `bun run dev`). */}
        <Show when={props.updateInfo()?.hasUpdate}>
          <text
            fg={theme.warning}
            attributes={TextAttributes.BOLD}
            onMouseUp={() => {
              const info = props.updateInfo()
              if (info) UpdateDialog.show(dialog, info)
            }}
          >
            ↑ v{props.updateInfo()?.latest} available
          </text>
        </Show>
      </box>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} gap={1} justifyContent="center">
        <Show when={props.activeTask() !== undefined}>
          <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
            {props.activeTask()?.branch}
          </text>
        </Show>
      </box>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} justifyContent="flex-end">
        <CreatePRButton orchestrator={props.orchestrator} activeTask={props.activeTask} />
      </box>
    </box>
  )
}

function Shell(props: AppDeps) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const dialog = useDialog()
  const kv = useKV()

  // Theme persistence — on mount, hydrate from KV (validates the
  // stored name against the bundled list to drop stale entries from a
  // theme that was renamed). On every theme switch, persist the new
  // name. Same shape for the orthogonal `transparentBackground` toggle.
  // ThemeProvider is mounted OUTER of KVProvider, so we hydrate here
  // rather than inside ThemeProvider's init.
  const persistedTheme = kv.get("activeTheme")
  if (typeof persistedTheme === "string" && themeCtx.has(persistedTheme)) {
    themeCtx.set(persistedTheme)
  }
  const persistedTransparent = kv.get("transparentBackground")
  if (typeof persistedTransparent === "boolean") {
    themeCtx.setTransparentBackground(persistedTransparent)
  }
  createEffect(() => {
    kv.set("activeTheme", themeCtx.selected)
  })
  createEffect(() => {
    kv.set("transparentBackground", themeCtx.transparentBackground)
  })

  const tasksAcc: Accessor<ReturnType<typeof props.orchestrator.listTasks>> = props.orchestrator.tasksSignal()
  // Persisted across runs in `~/.config/kobe/state.json` via the KV store
  // so reopening kobe lands on the task + center tab the user left from.
  // The auto-select effect below validates the persisted id against the
  // current task list (it may have been deleted between runs) and falls
  // back to tasks[0] when stale.
  const persistedSelectedId = kv.get("lastSelectedTaskId") as string | null | undefined
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  // Set by the new-task flow so the chat pane auto-submits the
  // prompt the user typed in the dialog. The chat clears it on
  // consumption to avoid re-submission on resubscribe.
  const [pendingPrompt, setPendingPrompt] = createSignal<{ taskId: string; prompt: string } | null>(null)

  // Background npm-registry version check. Cached for 6h on disk, so
  // typical cold boots return synchronously off the cache. The first
  // launch (or once per cache window) hits the network with a 3s
  // timeout — failures are silent, the chip just doesn't render.
  const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null)
  onMount(() => {
    void checkLatestVersion()
      .then((info) => {
        if (info) setUpdateInfo(info)
      })
      .catch(() => {
        /* swallow — version check is best-effort */
      })
  })

  const activeTask = createMemo(() => {
    const id = selectedId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)
  })

  // Accessor for the chat pane that yields a prompt only when it
  // matches the currently active task. This keeps the chat from
  // auto-submitting a leftover prompt against the wrong task after
  // a switch.
  const taskIdAcc = createMemo(() => selectedId() ?? undefined)
  const activeTitleAcc = createMemo(() => activeTask()?.title)
  const pendingPromptForActive = createMemo(() => {
    const pp = pendingPrompt()
    if (!pp) return undefined
    if (pp.taskId !== selectedId()) return undefined
    return pp.prompt
  })
  // Per-task accessors for the right-column panes. FileTree + Preview key
  // off `worktreePath`; Terminal keys off both `cwd` and `taskId` (so the
  // pty registry can deduplicate per task per the resolved Wave-1 decision).
  //
  // Empty string is normalised to null: orchestrator.createTask publishes
  // a transient placeholder task with worktreePath="" before the worktree
  // is actually written to disk. Treating "" as a real path would call
  // `git ls-files` with cwd="" and crash. The placeholder window is short
  // (one git worktree add) but the subscribers see it.
  const worktreePathAcc = createMemo<string | null>(() => {
    const path = activeTask()?.worktreePath
    return path ? path : null
  })
  const taskIdNullAcc = createMemo<string | null>(() => selectedId())
  // Diff base — for v1, just compare against HEAD (working-tree changes).
  // Wave 4 polish makes this configurable per-task (e.g. branch fork point).
  const diffBaseAcc = createMemo<string | null>(() => (worktreePathAcc() ? "HEAD" : null))

  // FileTree → Preview wiring: capture Preview's imperative API once,
  // then route file-tree clicks/enters into Preview.open(). Plus the
  // outer center-column tab state below tracks which file tab is active.
  const [previewApi, setPreviewApi] = createSignal<PreviewApi | null>(null)

  /* ------------------------------------------------------------------- */
  /*  Pane resize — three <ResizableEdge /> splitters                     */
  /* ------------------------------------------------------------------- */
  // Sidebar default 42 (the long-standing "history rail" convention from
  // opencode/agent-deck). Workspace and files are seeded from the
  // pre-resize 2:1 flex ratio so the layout looks the same on first paint
  // and starts diverging only when the user drags. We keep the sizes as
  // plain numbers (not optional) so the layout is always controlled —
  // simpler than juggling a "have they dragged yet" flag, at the cost of
  // not auto-rebalancing on terminal resize (just clamps to fit).
  //
  // Mins: sidebar 20 (status badge + first 8-10 chars of a title still
  // legible); workspace 30 (chat needs room to breathe); right column min
  // is implicit via "max workspace = total - sidebar - 1 splitter - min
  // right". Files min 5 / terminal min 5 (header + ~3 rows of content).
  const MIN_SIDEBAR_WIDTH = 20
  const MIN_WORKSPACE_WIDTH = 30
  const MIN_RIGHT_COLUMN_WIDTH = 30
  const MIN_FILES_HEIGHT = 5
  const MIN_TERMINAL_HEIGHT = 5
  const dims = useTerminalDimensions()
  // Hydrate the resize-pane sizes from KV when present so a kobe restart
  // lands on the layout the user dragged into last session. Defaults are
  // computed off the live terminal dims when KV has nothing — first
  // launch on a small terminal still gets a sensible starting point.
  // We persist via createEffect below, debounced by the natural drag
  // throttle (mouse-move events update the signal; KV.set is cheap).
  const persistedSidebar = (() => {
    const v = kv.get("paneSidebarWidth")
    return typeof v === "number" && v >= MIN_SIDEBAR_WIDTH ? v : null
  })()
  const persistedWorkspace = (() => {
    const v = kv.get("paneWorkspaceWidth")
    return typeof v === "number" && v >= MIN_WORKSPACE_WIDTH ? v : null
  })()
  const persistedFiles = (() => {
    const v = kv.get("paneFilesHeight")
    return typeof v === "number" && v >= MIN_FILES_HEIGHT ? v : null
  })()
  const initialDims = dims()
  const [sidebarWidth, setSidebarWidth] = createSignal(persistedSidebar ?? 42)
  // Initial workspace / files seeds: computed once from the terminal
  // dims at mount when KV has nothing. These are deliberately not
  // reactive to terminal resizes — the user's last drag wins.
  const [workspaceWidth, setWorkspaceWidth] = createSignal(
    persistedWorkspace ?? Math.max(MIN_WORKSPACE_WIDTH, Math.floor((initialDims.width - 42 - 1) * (2 / 3))),
  )
  const initialRightColumnHeight = Math.max(20, initialDims.height - 2 - 1)
  const [filesHeight, setFilesHeight] = createSignal(
    persistedFiles ?? Math.max(MIN_FILES_HEIGHT, Math.floor(initialRightColumnHeight * (2 / 3))),
  )

  // Persist on every resize. The signals only change during a drag (or
  // a clamp on terminal resize), so this fires per drag-frame at most —
  // KV.set is in-memory until the provider's debounced write hits disk.
  createEffect(() => {
    kv.set("paneSidebarWidth", sidebarWidth())
  })
  createEffect(() => {
    kv.set("paneWorkspaceWidth", workspaceWidth())
  })
  createEffect(() => {
    kv.set("paneFilesHeight", filesHeight())
  })

  const clampSidebar = (w: number) => {
    const max = Math.max(
      MIN_SIDEBAR_WIDTH,
      dims().width - workspaceWidth() - MIN_RIGHT_COLUMN_WIDTH - 2 /* two splitters */,
    )
    return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, w))
  }
  const clampWorkspace = (w: number) => {
    const max = Math.max(
      MIN_WORKSPACE_WIDTH,
      dims().width - sidebarWidth() - MIN_RIGHT_COLUMN_WIDTH - 2 /* two splitters */,
    )
    return Math.min(max, Math.max(MIN_WORKSPACE_WIDTH, w))
  }
  const clampFiles = (h: number) => {
    // Files height max = right column height - terminal min - 1 (splitter).
    // We approximate right column height as `dims.height - topbar - statusbar`.
    const rightColH = Math.max(MIN_FILES_HEIGHT + MIN_TERMINAL_HEIGHT + 1, dims().height - 2)
    const max = Math.max(MIN_FILES_HEIGHT, rightColH - MIN_TERMINAL_HEIGHT - 1)
    return Math.min(max, Math.max(MIN_FILES_HEIGHT, h))
  }

  /* ------------------------------------------------------------------- */
  /*  Pane focus — backed by FocusContext (src/tui/context/focus.tsx)     */
  /* ------------------------------------------------------------------- */
  const focus = useFocus()
  const focusedPane = focus.focused
  const setFocusedPane = focus.setFocused
  // Pane-bindings-active accessor: true only when (a) the pane is the
  // focused one AND (b) no dialog is open. The dialog gate prevents
  // sidebar/files/terminal bindings from firing while the user is
  // typing into a dialog input — `d` typed into a path field would
  // otherwise trigger the sidebar's delete-task confirmation.
  const isFocused = (pane: PaneId): Accessor<boolean> => {
    const baseAcc = focus.is(pane)
    return () => baseAcc() && dialog.stack.length === 0
  }

  // Numeric jumps: ctrl+1..4 pick a pane explicitly. The chord list lives
  // in KobeKeymap as `focus.numeric`; the handler dispatches by chord.
  // `ctrl` prefix avoids collision with FileTree's plain 1/2/3 tabs and
  // with composer typing. Always-on (modifier keys don't go to inputs).
  const FOCUS_NUMERIC_TARGETS: readonly PaneId[] = ["sidebar", "workspace", "files", "terminal"]
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: bindByIds({
      "focus.numeric": (evt) => {
        const n = Number.parseInt(evt.name ?? "", 10)
        if (n >= 1 && n <= FOCUS_NUMERIC_TARGETS.length) {
          const target = FOCUS_NUMERIC_TARGETS[n - 1]
          if (target) setFocusedPane(target)
        }
      },
    }),
  }))

  // Keyboard resize for the focused pane — fallback when mouse drag
  // misfires on the splitter. ctrl+= / ctrl++ grows, ctrl+- / ctrl+_
  // shrinks. The keymap normalizer (lib/keymap.tsx) drops the shift
  // modifier on single-char names since shift+= already produces `+`,
  // so we register both `+` and `=` on the grow side and both `-` and
  // `_` on the shrink side to match whatever shape the terminal sends.
  // Terminal pane grows by SHRINKING filesHeight (its height is the
  // residual under filesHeight in the right column); the rest of the
  // panes grow their own width/height directly.
  const RESIZE_STEP = 2
  function nudgeFocusedPane(delta: number): void {
    switch (focusedPane()) {
      case "sidebar":
        setSidebarWidth(clampSidebar(sidebarWidth() + delta))
        return
      case "workspace":
        setWorkspaceWidth(clampWorkspace(workspaceWidth() + delta))
        return
      case "files":
        setFilesHeight(clampFiles(filesHeight() + delta))
        return
      case "terminal":
        // Inverse: growing the terminal = shrinking files above it.
        setFilesHeight(clampFiles(filesHeight() - delta))
        return
    }
  }
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: bindByIds({
      "pane.resize-grow": () => nudgeFocusedPane(RESIZE_STEP),
      "pane.resize-shrink": () => nudgeFocusedPane(-RESIZE_STEP),
    }),
  }))

  // Tab / shift+tab pane cycling is registered via `useKobeKeybindings`'s
  // onFocusNext / onFocusPrev callbacks below — we just gate them here
  // (no-op when workspace is focused so opentui's textareas can claim
  // tab for their own intra-input behavior).

  /* ------------------------------------------------------------------- */
  /*  Center-column tab state — per-task                                  */
  /* ------------------------------------------------------------------- */
  // Per the resolved Wave-1 invariant ("each sidebar session = one
  // worktree") and Jackson's request: each task owns its own set of open
  // file tabs and which tab is active. Switching tasks restores the tab
  // strip exactly. Tabs are: a fixed `chat` plus zero-or-more file paths
  // (relative to the active task's worktree).
  type CenterTab = "chat" | { kind: "file"; path: string }
  type TaskCenterTabs = { open: readonly string[]; active: CenterTab }
  const EMPTY_TABS: TaskCenterTabs = { open: [], active: "chat" }
  // Hydrate from KV. Stored as a plain object keyed by taskId because Maps
  // aren't JSON-serializable. Tasks deleted between runs leak entries into
  // the file; harmless and pruned the next time we persist after a real
  // selection change. (Could prune on hydrate if it ever matters.)
  const persistedTabs = kv.get("centerTabsByTask") as Record<string, TaskCenterTabs> | undefined
  const [tabsByTask, setTabsByTask] = createSignal(
    new Map<string, TaskCenterTabs>(persistedTabs ? Object.entries(persistedTabs) : []),
  )

  const currentTabs = createMemo<TaskCenterTabs>(() => {
    const id = selectedId()
    if (!id) return EMPTY_TABS
    return tabsByTask().get(id) ?? EMPTY_TABS
  })
  const activeCenterTab = createMemo<CenterTab>(() => currentTabs().active)
  const openFileTabs = createMemo<readonly string[]>(() => currentTabs().open)
  const isChatTabActive = createMemo<boolean>(() => activeCenterTab() === "chat")
  const activeFileTabPath = createMemo<string | null>(() => {
    const a = activeCenterTab()
    return typeof a === "object" ? a.path : null
  })

  function mutateTabs(taskId: string, updater: (cur: TaskCenterTabs) => TaskCenterTabs): void {
    setTabsByTask((prev) => {
      const next = new Map(prev)
      const cur = next.get(taskId) ?? EMPTY_TABS
      next.set(taskId, updater(cur))
      return next
    })
  }

  function openFileInCenter(relPath: string): void {
    const id = selectedId()
    if (!id) return
    mutateTabs(id, (cur) => ({
      open: cur.open.includes(relPath) ? cur.open : [...cur.open, relPath],
      active: { kind: "file", path: relPath },
    }))
    previewApi()?.open(relPath)
    // Opening a file from the file tree pulls focus to the workspace
    // so the user can scroll/read with j/k without an extra ctrl+2.
    setFocusedPane("workspace")
  }

  function selectChatTab(): void {
    const id = selectedId()
    if (!id) return
    mutateTabs(id, (cur) => ({ ...cur, active: "chat" }))
    setFocusedPane("workspace")
  }

  // Chat tabs (multitab) — pulled off the active task so the
  // CenterTabStrip can render one chip per chat tab alongside the
  // file tabs. activeChatTabIdAcc tracks which chat tab the
  // orchestrator currently considers active; click-to-switch on a
  // chip flows through `selectChatTabById` which in turn calls
  // orchestrator.setActiveTab + flips the workspace tab to chat.
  const activeChatTabsAcc = createMemo<readonly ChatTab[]>(() => activeTask()?.tabs ?? [])
  const activeChatTabIdAcc = createMemo<string | null>(() => activeTask()?.activeTabId ?? null)
  function selectChatTabById(tabId: string): void {
    const id = selectedId()
    if (!id) return
    void props.orchestrator.setActiveTab(id, tabId).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[kobe] setActiveTab failed:", err)
    })
    mutateTabs(id, (cur) => ({ ...cur, active: "chat" }))
    setFocusedPane("workspace")
  }

  function selectFileTab(relPath: string): void {
    const id = selectedId()
    if (!id) return
    mutateTabs(id, (cur) => ({ ...cur, active: { kind: "file", path: relPath } }))
    previewApi()?.open(relPath)
    setFocusedPane("workspace")
  }

  function closeFileTab(relPath: string): void {
    const id = selectedId()
    if (!id) return
    mutateTabs(id, (cur) => {
      const open = cur.open.filter((f) => f !== relPath)
      const wasActive = typeof cur.active === "object" && cur.active.path === relPath
      const fallback: CenterTab = open.length > 0 ? { kind: "file", path: open[open.length - 1] as string } : "chat"
      return { open, active: wasActive ? fallback : cur.active }
    })
    previewApi()?.close(relPath)
  }

  // Auto-select on first task availability. Prefer the persisted task
  // from the previous run when it still exists; otherwise fall back to
  // tasks[0]. The `persistedSelectedId` reference is consumed exactly
  // once (we null it after the first successful match) so user-driven
  // selections later in the session aren't snapped back.
  let pendingPersistedId: string | null = persistedSelectedId ?? null
  createEffect(() => {
    const tasks = tasksAcc()
    if (selectedId()) return
    if (tasks.length === 0) return
    const persisted = pendingPersistedId ? tasks.find((t) => t.id === pendingPersistedId) : undefined
    pendingPersistedId = null
    setSelectedId((persisted ?? tasks[0])!.id)
  })

  // Persist the active task and per-task tab state whenever they
  // change. The KV store debounces writes internally so this is cheap.
  createEffect(() => {
    kv.set("lastSelectedTaskId", selectedId())
  })
  createEffect(() => {
    const obj: Record<string, TaskCenterTabs> = {}
    for (const [id, tabs] of tabsByTask()) obj[id] = tabs
    kv.set("centerTabsByTask", obj)
  })

  // Saved repos — populated by the `kobe add [path]` CLI subcommand
  // (src/cli/index.ts), read here for the new-task dialog's repo
  // picker. Reading through a memo over kv.store keeps the picker
  // reactive on the same kobe instance. Defensive filter in case the
  // on-disk file was hand-edited to a non-array.
  const savedRepos = createMemo<readonly string[]>(() => {
    const raw = kv.get("savedRepos", [])
    if (!Array.isArray(raw)) return []
    return raw.filter((s): s is string => typeof s === "string")
  })

  useKobeKeybindings({
    onShowHelp: () => HelpDialog.show(dialog),
    onFocusDetach: () => setFocusedPane("sidebar"),
    // Tab cycle is no-op while workspace is focused so the composer's
    // own tab handling (dialog field cycling, indent, etc.) wins.
    onFocusNext: () => {
      if (focusedPane() !== "workspace") focus.cycle(1)
    },
    onFocusPrev: () => {
      if (focusedPane() !== "workspace") focus.cycle(-1)
    },
  })

  // Shared "open new-task dialog and create" handler. Bound to two
  // keys with different `enabled` guards (see useBindings calls below).
  async function openNewTaskFlow(): Promise<void> {
    // Default the dialog to the last repo the user picked, falling
    // back to cwd. Persisted via KV so it survives kobe restarts.
    const lastRepo = (() => {
      const raw = kv.get("lastNewTaskRepo")
      return typeof raw === "string" && raw.trim() ? raw : process.cwd()
    })()
    const result = await showNewTaskDialog(dialog, lastRepo, savedRepos())
    if (!result) return
    try {
      // Dialog no longer asks for a first prompt — orchestrator gives
      // the task PLACEHOLDER_TASK_TITLE and back-fills it from the
      // user's first composer submit (see runTask). The user lands on
      // the chat composer ready to type.
      const created = await props.orchestrator.createTask({
        repo: result.repo,
        baseRef: result.baseRef,
      })
      kv.set("lastNewTaskRepo", result.repo)
      setSelectedId(created.id)
      // Pull focus to the chat pane so the user can immediately type
      // / use chat-pane-scoped keybindings (ctrl+t for new chat tab,
      // ctrl+1..9 / ctrl+tab to navigate tabs, ctrl+w to close one)
      // without an extra ctrl+2. Mirrors the sidebar's onSelect
      // behaviour — both "user wants to look at this task" entry
      // points should land in the same place.
      setFocusedPane("workspace")
    } catch (err) {
      // Surface failure as stderr; we don't have a global banner yet,
      // and the chat pane may not be subscribed (no task selected).
      // eslint-disable-next-line no-console
      console.error("[kobe] createTask failed:", err)
    }
  }

  /**
   * Confirm + delete a task. Wired from the sidebar's `d` keypress
   * (and a future right-click in Wave 4). Per CLAUDE.md the user's
   * `d` press IS the explicit consent for clearing the worktree, but
   * we still gate behind a confirm because the action is destructive
   * and out-of-frame state (other terminal windows, in-progress writes)
   * could mean "press the wrong key once" → "lose work."
   */
  /**
   * Open the rename dialog for a task and persist the new title.
   * Mirrors `confirmDeleteTask` in shape: resolve task → run dialog →
   * await orchestrator. The orchestrator's `setTitle` does its own
   * empty-title rejection and same-as-current no-op, so we only need
   * to gate on "did the user submit a value at all" here. The dialog
   * itself rejects empty submits before calling onSubmit, so a
   * resolved-with-string from the promise is always usable.
   */
  async function confirmRenameTask(taskId: string): Promise<void> {
    const task = props.orchestrator.getTask(taskId)
    if (!task) return
    const next = await showRenameTaskDialog(dialog, task.title)
    if (next === undefined) return
    try {
      await props.orchestrator.setTitle(taskId, next)
    } catch (err) {
      // Empty/whitespace-only — defensive: dialog's commit() filters
      // these but a future code path could call this with anything.
      // eslint-disable-next-line no-console
      console.error("[kobe] setTitle failed:", err)
    }
  }

  async function confirmDeleteTask(taskId: string): Promise<void> {
    const task = props.orchestrator.getTask(taskId)
    if (!task) return
    const ok = await DialogConfirm.show(
      dialog,
      `Delete '${task.title}'?`,
      `Removes the worktree at ${task.worktreePath}, deletes the chat history, and removes the task. This cannot be undone. The git branch is kept.`,
      "cancel",
    )
    if (ok !== true) return
    try {
      await props.orchestrator.deleteTask(taskId)
      // If the deleted task was the selected one, clear selection so the
      // chat pane / file tree etc. stop pointing at a dead worktree.
      if (selectedId() === taskId) setSelectedId(null)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[kobe] deleteTask failed:", err)
    }
  }

  // `ctrl+n` (task.new) and `ctrl+,` (settings.open) are always
  // available when no dialog is open. Modifier chords don't go to
  // inputs, so this is the safe path for "I'm in a chat but want to
  // spawn a sibling task" or open settings.
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: bindByIds({
      "task.new": () => {
        void openNewTaskFlow()
      },
      "settings.open": () => {
        void SettingsDialog.show(dialog, kv)
      },
    }),
  }))

  // Test-only hidden hotkey affordance for the W4.PR behavior test.
  // Mouse-clicking the CreatePRButton from a PTY harness is awkward
  // (opentui's mouse-event delivery needs SGR capability negotiation
  // that the screen-capture path doesn't honor). When
  // KOBE_TEST_PR_HOTKEY=1 we register a hidden ctrl+y binding that
  // calls the same handler. We chose ctrl+y because (a) it's not in
  // opentui's defaultTextareaKeyBindings (so the composer won't
  // intercept it via preventDefault) and (b) kobe's keymap (see
  // src/tui/lib/keymap.tsx) drops the shift modifier on single-letter
  // keys, so chords like "ctrl+shift+p" never match anything emitted by
  // node-pty. A second test path is the fake-engine HTTP server's POST
  // /pr endpoint (see mountFakeEngineServer above) which bypasses the
  // keymap entirely. Production never sets either env var.
  useBindings(() => ({
    enabled: process.env.KOBE_TEST_PR_HOTKEY === "1" && dialog.stack.length === 0,
    bindings: [
      {
        key: "ctrl+y",
        cmd: () => {
          const task = activeTask()
          if (!task || !task.worktreePath || task.status === "canceled") return
          props.orchestrator.requestPR(task.id).catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error("[kobe] requestPR failed:", err)
          })
        },
      },
    ],
  }))

  // Side-channel PR trigger for the W4.PR behavior test. When
  // KOBE_TEST_FAKE_PORT is active, the fake-engine HTTP server (started
  // in startApp) also exposes POST /pr which calls requestPR for the
  // active task. The test uses this in preference to keystroke-driven
  // invocation because key dispatch interacts with the focused
  // composer's keymap in ways the test shouldn't have to debug. We
  // expose the trigger via a global window-attached function so the
  // server (defined at startApp time, before Shell mounts) can reach it.
  if (typeof globalThis !== "undefined") {
    ;(globalThis as { __kobeTestRequestPR?: () => Promise<{ taskId: string; prompt: string }> }).__kobeTestRequestPR =
      async () => {
        const task = activeTask()
        if (!task || !task.worktreePath || task.status === "canceled") {
          throw new Error("no usable active task for PR (no worktree, no task, or canceled)")
        }
        // Render the prompt OUTSIDE of requestPR so the test can assert
        // on what was actually sent. This duplicates a tiny bit of logic
        // for the test affordance only — production goes through
        // requestPR which independently renders + sends.
        const { gatherPRState, loadPRInstructionsTemplate, renderPRInstructions } = await import(
          "../orchestrator/pr/index.ts"
        )
        const state = await gatherPRState(task.worktreePath)
        const template = await loadPRInstructionsTemplate(task.worktreePath)
        const rendered = renderPRInstructions(template, state)
        await props.orchestrator.requestPR(task.id)
        return { taskId: task.id, prompt: rendered }
      }

    // Side-channel respond trigger for the user-input pause behavior
    // tests (ExitPlanMode + AskUserQuestion). The chat row's
    // mouse-click path through onApprove/onAnswer eventually calls
    // orchestrator.respondToInput, but driving that from a PTY test
    // requires SGR mouse delivery the screen-capture path doesn't
    // honor. We expose a server-side hook that picks the latest
    // pending requestId for the active task and dispatches the
    // user's response synthetically. The render side (status flip on
    // the picker, composer unlock, synthetic user.inject row) is the
    // same code path real clicks would exercise — only the
    // input-event delivery differs.
    type RespondTrigger = (
      response: import("../types/engine.ts").UserInputResponse,
    ) => Promise<{ taskId: string; requestId: string; prompt: string }>
    ;(globalThis as { __kobeTestRespondToInput?: RespondTrigger }).__kobeTestRespondToInput = async (response) => {
      const task = activeTask()
      if (!task) throw new Error("no active task for respondToInput")
      const pending = props.orchestrator.peekPendingInput(task.id)
      if (pending.length === 0) {
        throw new Error("no pending input for active task — picker hasn't rendered yet?")
      }
      // Latest request wins. Multiple pending requests on one task is
      // not currently a real flow (the orchestrator kills the
      // subprocess on the first user-input tool start), but if it
      // becomes one the test can extend the seam with an explicit
      // requestId selector.
      const latest = pending[pending.length - 1]
      if (!latest) throw new Error("no pending input for active task — picker hasn't rendered yet?")
      const { renderUserInputResponsePrompt } = await import("../orchestrator/core.ts")
      const prompt = renderUserInputResponsePrompt(latest.payload, response)
      await props.orchestrator.respondToInput(task.id, latest.requestId, response)
      return { taskId: task.id, requestId: latest.requestId, prompt }
    }
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <TopBar orchestrator={props.orchestrator} activeTask={activeTask} updateInfo={updateInfo} />
      <box flexDirection="row" flexGrow={1}>
        {/* Left: task sidebar. Click anywhere on the sidebar pane to
            focus it. The right edge is a separate <ResizableEdge /> that
            owns the drag-to-resize affordance plus hover/focus colors.
            backgroundPanel paints a slightly-raised tone vs the chat
            (which keeps `theme.background`) — IDE convention is the
            auxiliary rails recede in saturation, the work area is the
            visual focus. */}
        <box
          flexShrink={0}
          flexDirection="column"
          backgroundColor={theme.backgroundPanel}
          onMouseUp={() => setFocusedPane("sidebar")}
        >
          <Sidebar
            width={sidebarWidth}
            tasks={tasksAcc}
            onSelect={(id: string) => {
              setSelectedId(id)
              // Selecting a task usually means "I want to look at it" —
              // pull focus to workspace so the user can immediately type
              // / scroll without another ctrl+2.
              setFocusedPane("workspace")
            }}
            onDeleteRequest={(id: string) => {
              void confirmDeleteTask(id)
            }}
            onArchiveRequest={(id: string) => {
              void props.orchestrator.setArchived(id).catch((err) => {
                // eslint-disable-next-line no-console
                console.error("[kobe] setArchived failed:", err)
              })
            }}
            onRenameRequest={(id: string) => {
              void confirmRenameTask(id)
            }}
            onAddTask={() => void openNewTaskFlow()}
            selectedId={selectedId}
            focused={isFocused("sidebar")}
          />
        </box>
        {/* Sidebar ↔ workspace splitter. */}
        <ResizableEdge
          orientation="vertical"
          size={sidebarWidth}
          setSize={setSidebarWidth}
          clamp={clampSidebar}
          focused={isFocused("sidebar")}
        />
        {/* Center: tabbed (chat | <file>...) — primary interaction surface.
            Width controlled by workspaceWidth; the right edge is a
            <ResizableEdge /> sibling rather than a `border={["right"]}`
            on this box. No bg paint — the chat body inherits the
            renderer's `theme.background` (which the ThemeProvider
            forces to transparent under the transparent-bg toggle).
            Only the composer's `theme.backgroundElement` fill stays
            tinted in transparent mode, keeping the input area
            legible against any host wallpaper. */}
        <box
          flexDirection="column"
          flexShrink={0}
          width={workspaceWidth()}
          onMouseUp={() => setFocusedPane("workspace")}
        >
          <PaneHeader
            title="WORKSPACE"
            subtitle={activeTask()?.title ?? "no task"}
            focused={focusedPane() === "workspace"}
          />
          <CenterTabStrip
            isChatActive={isChatTabActive}
            activeFile={activeFileTabPath}
            openFiles={openFileTabs}
            chatTabs={activeChatTabsAcc}
            activeChatTabId={activeChatTabIdAcc}
            onSelectChat={selectChatTab}
            onSelectChatTab={selectChatTabById}
            onSelectFile={selectFileTab}
            onCloseFile={closeFileTab}
          />
          <box flexGrow={1}>
            <Show
              when={isChatTabActive()}
              fallback={
                <Preview
                  worktreePath={worktreePathAcc}
                  diffBase={diffBaseAcc}
                  onOpen={(api) => setPreviewApi(api)}
                  hideInternalTabs={() => true}
                  focused={isFocused("workspace")}
                />
              }
            >
              <Chat
                orchestrator={props.orchestrator}
                taskId={taskIdAcc}
                title={activeTitleAcc}
                pendingPrompt={pendingPromptForActive}
                onPendingPromptConsumed={() => setPendingPrompt(null)}
                focused={isFocused("workspace")}
              />
            </Show>
          </box>
        </box>
        {/* Workspace ↔ right column splitter. */}
        <ResizableEdge
          orientation="vertical"
          size={workspaceWidth}
          setSize={setWorkspaceWidth}
          clamp={clampWorkspace}
          focused={isFocused("workspace")}
        />
        {/* Right column: FILES top + TERMINAL bottom. Width absorbs the
            remainder via flexGrow={1}; the FILES↔TERMINAL split is a
            <ResizableEdge orientation="horizontal" /> with a controlled
            filesHeight signal driving the upper pane. Same
            backgroundPanel tone as the sidebar so the two rails feel
            symmetric and the chat in the middle is visibly the focus. */}
        <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} backgroundColor={theme.backgroundPanel}>
          <box flexShrink={0} height={filesHeight()} flexDirection="column" onMouseUp={() => setFocusedPane("files")}>
            <PaneHeader title="FILES" focused={focusedPane() === "files"} />
            <box flexGrow={1}>
              <FileTree worktreePath={worktreePathAcc} onOpenFile={openFileInCenter} focused={isFocused("files")} />
            </box>
          </box>
          {/* Files ↔ terminal splitter. */}
          <ResizableEdge
            orientation="horizontal"
            size={filesHeight}
            setSize={setFilesHeight}
            clamp={clampFiles}
            focused={isFocused("files")}
          />
          <box
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            flexDirection="column"
            onMouseUp={() => setFocusedPane("terminal")}
          >
            <PaneHeader
              title="TERMINAL"
              subtitle={worktreePathAcc() ? worktreePathAcc()?.split("/").slice(-1)[0] : undefined}
              focused={focusedPane() === "terminal"}
            />
            <box flexGrow={1}>
              <Terminal cwd={worktreePathAcc} taskId={taskIdNullAcc} focused={isFocused("terminal")} />
            </box>
          </box>
        </box>
      </box>
      <StatusBar />
    </box>
  )
}

/* --------------------------------------------------------------------- */
/*  Center column tab strip — chat + open files (per-task)                */
/* --------------------------------------------------------------------- */
function CenterTabStrip(props: {
  isChatActive: Accessor<boolean>
  activeFile: Accessor<string | null>
  openFiles: Accessor<readonly string[]>
  /**
   * Per-task chat tabs. With multitab, "chat" is no longer a single
   * entry — each tab gets its own chip in this strip alongside the
   * file tabs, so the user has one unified tab navigation. Falls
   * back to a single static "chat" chip when the task has no tabs
   * yet (e.g. before the first runTask).
   */
  chatTabs: Accessor<readonly ChatTab[]>
  activeChatTabId: Accessor<string | null>
  onSelectChat: () => void
  onSelectChatTab: (tabId: string) => void
  onSelectFile: (path: string) => void
  onCloseFile: (path: string) => void
}) {
  const { theme } = useTheme()
  /** Display label for a chat tab — falls back to `chat N`. */
  const chatTabLabel = (tab: ChatTab, idx: number) =>
    tab.title && tab.title.length > 0 ? tab.title : `chat ${idx + 1}`
  return (
    <box
      flexDirection="row"
      gap={1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundPanel}
    >
      <Show
        when={props.chatTabs().length > 0}
        fallback={
          // Pre-runTask state — task has no tabs yet (or no task at
          // all). Render the static "chat" chip so the strip isn't
          // empty and the user can still see they're on chat.
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={props.isChatActive() ? theme.primary : theme.backgroundElement}
            onMouseUp={() => props.onSelectChat()}
          >
            <text
              fg={props.isChatActive() ? theme.selectedListItemText : theme.text}
              attributes={props.isChatActive() ? TextAttributes.BOLD : undefined}
            >
              chat
            </text>
          </box>
        }
      >
        <For each={props.chatTabs()}>
          {(tab, i) => {
            // A chat tab chip is "active" only when the workspace is on
            // chat AND this is the active chat tab. When chat is open
            // but a different tab is selected, we still want it to look
            // distinct from "chat is hidden behind a file tab" — render
            // the active chat-tab in primary, the inactive chat-tabs in
            // a softer style, and all of them dim when chat isn't the
            // workspace tab at all.
            const isPrimary = () => props.isChatActive() && props.activeChatTabId() === tab.id
            const isVisibleButOther = () => props.isChatActive() && !isPrimary()
            return (
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isPrimary() ? theme.primary : theme.backgroundElement}
                onMouseUp={() => {
                  if (!props.isChatActive()) props.onSelectChat()
                  props.onSelectChatTab(tab.id)
                }}
              >
                <text
                  fg={isPrimary() ? theme.selectedListItemText : isVisibleButOther() ? theme.text : theme.textMuted}
                  attributes={isPrimary() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {chatTabLabel(tab, i())}
                </text>
              </box>
            )
          }}
        </For>
      </Show>
      <For each={props.openFiles()}>
        {(file) => {
          const isActive = () => props.activeFile() === file
          return (
            <box
              flexDirection="row"
              gap={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={isActive() ? theme.primary : theme.backgroundElement}
              onMouseUp={() => props.onSelectFile(file)}
            >
              <text
                fg={isActive() ? theme.selectedListItemText : theme.text}
                attributes={isActive() ? TextAttributes.BOLD : undefined}
                wrapMode="none"
              >
                {basename(file)}
              </text>
              <text
                fg={isActive() ? theme.selectedListItemText : theme.textMuted}
                onMouseUp={() => queueMicrotask(() => props.onCloseFile(file))}
              >
                x
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

function App(props: AppDeps) {
  return (
    <ThemeProvider mode="dark" theme={DEFAULT_THEME}>
      <KVProvider>
        <SyncProvider>
          <DialogProvider>
            <CommandPaletteProvider>
              <FocusProvider>
                <Shell {...props} />
              </FocusProvider>
            </CommandPaletteProvider>
          </DialogProvider>
        </SyncProvider>
      </KVProvider>
    </ThemeProvider>
  )
}

/**
 * Mount the G2 app. Builds the orchestrator stack, then renders
 * `<App />`. Replaces `tui/index.tsx`'s previous banner mount.
 */
export async function startApp(): Promise<void> {
  const engine = await buildEngine()
  const homeDir = process.env.KOBE_HOME_DIR ?? homedir()
  const store = new TaskIndexStore({ homeDir })
  await store.load()
  const worktrees = new GitWorktreeManager()
  const orchestrator = new Orchestrator({ engine, store, worktrees })
  // Renderer-level background: transparent so the host terminal's
  // background (theme, image, transparency setting) shows through where
  // panes don't paint. opentui PR #824 / v0.1.89+ added this — earlier
  // versions composited transparent regions against opaque black.
  // exitOnCtrlC: false — opentui's default kills the process on a single
  // Ctrl+C. Jackson wants the standard "first press copies / arms,
  // second press quits" UX, owned by useKobeKeybindings.
  await render(() => <App orchestrator={orchestrator} />, { backgroundColor: "transparent", exitOnCtrlC: false })
  // Side-effect: silence the "no usage" lint warning if any.
  void join
}
