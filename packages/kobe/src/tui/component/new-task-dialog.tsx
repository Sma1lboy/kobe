/**
 * New-task dialog (v0.6).
 *
 * v0.5 had a multi-tab dialog with repo picker, branch picker, model
 * picker, and a prompt input that auto-submitted into the chat. v0.6
 * has no chat to submit to and no per-task model — the form shrinks
 * to: pick a saved repo (or use the only one), name the task, and
 * optionally override the auto-branch. Pressing ⏎ in the workspace
 * later creates the worktree on demand.
 *
 * Field cycling: tab / shift+tab. Enter on the last field commits;
 * enter on an earlier field also commits (so single-handed users can
 * submit without tabbing through). Esc cancels via the dialog stack.
 */

import { TextAttributes } from "@opentui/core"
import { For, Show, createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"
import { stripNewlines } from "./dialog-utils"

export interface NewTaskInput {
  readonly repo: string
  readonly title: string
  readonly branch?: string
  readonly baseRef?: string
}

type Field = "repo" | "title" | "branch" | "baseRef"
const FIELD_ORDER: readonly Field[] = ["repo", "title", "branch", "baseRef"]

export function NewTaskDialogView(props: {
  repos: readonly string[]
  defaultRepo: string
  onSubmit: (v: NewTaskInput) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()

  const initialRepoIdx = Math.max(0, props.repos.indexOf(props.defaultRepo))
  const [repoIdx, setRepoIdx] = createSignal(initialRepoIdx)
  const [title, setTitle] = createSignal("")
  const [branch, setBranch] = createSignal("")
  const [baseRef, setBaseRef] = createSignal("")
  const [field, setField] = createSignal<Field>(props.repos.length > 1 ? "repo" : "title")

  function nextField(): void {
    const i = FIELD_ORDER.indexOf(field())
    setField(FIELD_ORDER[(i + 1) % FIELD_ORDER.length] ?? "title")
  }
  function prevField(): void {
    const i = FIELD_ORDER.indexOf(field())
    setField(FIELD_ORDER[(i - 1 + FIELD_ORDER.length) % FIELD_ORDER.length] ?? "title")
  }

  function commit() {
    const t = title().trim()
    if (!t) return
    const repo = props.repos[repoIdx()]
    if (!repo) return
    props.onSubmit({
      repo,
      title: t,
      branch: branch().trim() || undefined,
      baseRef: baseRef().trim() || undefined,
    })
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      { key: "tab", cmd: nextField },
      { key: "shift+tab", cmd: prevField },
      // Repo cycler only fires while the Repo field is active.
      {
        key: "left",
        cmd: () => {
          if (field() !== "repo" || props.repos.length === 0) return
          setRepoIdx((i) => (i - 1 + props.repos.length) % props.repos.length)
        },
      },
      {
        key: "right",
        cmd: () => {
          if (field() !== "repo" || props.repos.length === 0) return
          setRepoIdx((i) => (i + 1) % props.repos.length)
        },
      },
    ],
  }))

  const repoLabel = () => props.repos[repoIdx()] ?? "(no saved repo)"

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

      {/* Repo row — arrow-keys cycle when multiple are saved, hidden
          when there's exactly one. */}
      <Show when={props.repos.length > 1}>
        <box flexDirection="column" gap={0}>
          <box flexDirection="row" gap={1}>
            <text fg={field() === "repo" ? theme.accent : theme.textMuted}>repo</text>
            <text fg={theme.textMuted}>← / →</text>
          </box>
          <text fg={field() === "repo" ? theme.text : theme.textMuted}>{repoLabel()}</text>
        </box>
      </Show>
      <Show when={props.repos.length === 1}>
        <box flexDirection="column" gap={0}>
          <text fg={theme.textMuted}>repo</text>
          <text fg={theme.textMuted}>{repoLabel()}</text>
        </box>
      </Show>

      <box flexDirection="column" gap={0}>
        <text fg={field() === "title" ? theme.accent : theme.textMuted}>title</text>
        <input
          value={title()}
          placeholder="What is this task about?"
          focused={field() === "title"}
          onInput={(v: string) => setTitle(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>

      <box flexDirection="column" gap={0}>
        <box flexDirection="row" gap={1}>
          <text fg={field() === "branch" ? theme.accent : theme.textMuted}>branch</text>
          <text fg={theme.textMuted}>(optional — auto if blank)</text>
        </box>
        <input
          value={branch()}
          placeholder="kobe/<auto>"
          focused={field() === "branch"}
          onInput={(v: string) => setBranch(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>

      <box flexDirection="column" gap={0}>
        <box flexDirection="row" gap={1}>
          <text fg={field() === "baseRef" ? theme.accent : theme.textMuted}>base ref</text>
          <text fg={theme.textMuted}>(optional — HEAD if blank)</text>
        </box>
        <input
          value={baseRef()}
          placeholder="main"
          focused={field() === "baseRef"}
          onInput={(v: string) => setBaseRef(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>

      <box paddingBottom={1}>
        <text fg={theme.textMuted}>tab cycle · enter create · esc cancel</text>
      </box>
    </box>
  )
}

export const NewTaskDialog = {
  show(
    dialog: DialogContext,
    opts: { repos: readonly string[]; defaultRepo: string },
  ): Promise<NewTaskInput | undefined> {
    return new Promise<NewTaskInput | undefined>((resolve) => {
      dialog.replace(
        () => (
          <NewTaskDialogView
            repos={opts.repos}
            defaultRepo={opts.defaultRepo}
            onSubmit={(v) => resolve(v)}
            onCancel={() => resolve(undefined)}
          />
        ),
        () => resolve(undefined),
      )
      dialog.setSize("medium")
    })
  },
}
