/**
 * `kobe ops` host — the Ops pane on the right side of a task's tmux
 * session (v0.6 / KOB-233).
 *
 * Reuses the v0.5 `FileTree` to browse the worktree. Activating a file
 * (enter / click) opens a **full-width preview window** — a fresh tmux
 * window running `kobe ops --preview <file>`, which renders opentui's
 * `<diff>` / `<code>` (tree-sitter syntax highlighting + line numbers,
 * zero external deps). Reviewing a diff wants the whole terminal width,
 * which the narrow Ops pane can't give; a new window does, and `q`
 * closes it back to the three-pane layout. If that launch fails the
 * window falls back to the user's own pager (`delta`/`bat`/`less`).
 *
 * Runs in its own OS process inside the tmux pane (separate opentui
 * render loop from the outer kobe TUI). It can't share the outer TUI's
 * Solid runtime, but it DOES inherit the user's theme via
 * `readPersistedUiPrefs` (read-only — the outer app owns `state.json`).
 */

import { createHash } from "node:crypto"
import { kobeCliInvocation } from "@/cli/invocation"
import { type ChatTabTurnState, createEngineTurnDetector } from "@/engine/turn-detector"
import { latestTranscriptMtime } from "@/monitor/activity"
import { capturePaneById, newWindow, sendKeyName, sendKeys, setWindowOption, tmuxSessionName } from "@/tmux/client"
import { openInEditor } from "@/tmux/editor-launch"
import { previewWindowCommand } from "@/tmux/session-layout"
import type { VendorId } from "@/types/task"
import { SyntaxStyle } from "@opentui/core"
import { render } from "@opentui/solid"
import { Show, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { ThemeProvider, addTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { useBindings } from "../lib/keymap"
import { type PersistedUiPrefs, readPersistedUiPrefs } from "../lib/persisted-ui-prefs"
import { FileTree } from "../panes/filetree"
import { DialogProvider } from "../ui/dialog"
import { buildPRPrompt } from "./pr-prompt"

const FALLBACK_THEME = "claude"

export interface OpsHostArgs {
  readonly taskId: string
  readonly worktree: string
  /** tmux pane id / selector for the claude pane — send-keys target. */
  readonly targetPane: string | null
  /** Task engine vendor — selects which transcript store the activity badge polls. */
  readonly vendor: VendorId
}

/** How often the Ops pane polls the engine transcript for new activity. */
const ACTIVITY_POLL_MS = 2500
const TURN_STATUS_POLL_MS = 1500
const STABLE_POLLS_FOR_DONE = 2
const CHAT_TAB_STATE_OPTION = "@kobe_tab_state"

type ThemePrefs = PersistedUiPrefs

function OpsShell(props: OpsHostArgs & { prefs: ThemePrefs }) {
  const themeCtx = useTheme()
  const { theme } = themeCtx

  // Apply the inherited transparent-bg + focus-accent prefs once the
  // theme context is live (active theme name comes from the
  // ThemeProvider's initial prop, so no flash).
  onMount(() => {
    themeCtx.setTransparentBackground(props.prefs.transparent)
    if (props.prefs.focusAccent) themeCtx.setFocusAccent(props.prefs.focusAccent)
  })

  // New-activity badge (KOB-254). v0.6 has no chat-stream "done" signal
  // and we explicitly don't parse the tmux pane, so we poll the engine's
  // own transcript store (the JSONL the cost dashboard reads) and light
  // a corner badge when its newest mtime advances past what we last
  // acknowledged. `baseline` starts at "now's newest" so a pane that
  // mounts onto an already-busy task doesn't flash stale activity; it's
  // pushed forward on each `r` refresh (the user's "I've looked").
  const [baseline, setBaseline] = createSignal(0)
  const [latest, setLatest] = createSignal(0)
  let primed = false
  onMount(() => {
    let disposed = false
    async function poll(): Promise<void> {
      const mtime = await latestTranscriptMtime(props.vendor, props.worktree)
      if (disposed) return
      if (!primed) {
        // First read seeds the baseline so we only ever flag activity
        // that happened after the pane came up.
        primed = true
        setBaseline(mtime)
      }
      setLatest(mtime)
    }
    void poll()
    const timer = setInterval(() => void poll(), ACTIVITY_POLL_MS)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
    })
  })
  const hasNewActivity = () => primed && latest() > baseline()
  const cornerBadge = () => (hasNewActivity() ? { text: "● new", active: true } : null)
  function ackActivity(): void {
    setBaseline(latest())
  }

  // Per-window turn detector. The engine adapter owns transcript-specific
  // completion markers (Codex `turn.completed`, Claude assistant records).
  // This pane owns only the tmux-local quiescence check for its paired
  // engine pane, so sibling ChatTabs on the same worktree don't report done
  // unless THIS window actually changed.
  onMount(() => {
    if (!props.targetPane) return
    const detector = createEngineTurnDetector(props.vendor)
    let disposed = false
    let baselineCompletionId: string | null = null
    let paneHash = ""
    let observedPaneActivity = false
    let stablePolls = 0
    let published: ChatTabTurnState | null = null

    async function publish(state: ChatTabTurnState): Promise<void> {
      if (state === published) return
      published = state
      await setWindowOption(props.targetPane!, CHAT_TAB_STATE_OPTION, state)
    }

    async function prime(): Promise<void> {
      paneHash = fingerprint(await capturePaneById(props.targetPane!, 80))
      baselineCompletionId = (await detector.latestCompletion(props.worktree))?.id ?? null
      await publish(detector.supportsCompletionMarkers() ? "idle" : "unknown")
    }

    async function poll(): Promise<void> {
      const nextPaneHash = fingerprint(await capturePaneById(props.targetPane!, 80))
      if (disposed) return
      if (nextPaneHash !== paneHash) {
        paneHash = nextPaneHash
        observedPaneActivity = true
        stablePolls = 0
        await publish(detector.supportsCompletionMarkers() ? "running" : "unknown")
      } else if (observedPaneActivity) {
        stablePolls++
      }

      if (!detector.supportsCompletionMarkers() || !observedPaneActivity || stablePolls < STABLE_POLLS_FOR_DONE) return

      const marker = await detector.latestCompletion(props.worktree)
      if (disposed || !marker || marker.id === baselineCompletionId) return
      baselineCompletionId = marker.id
      observedPaneActivity = false
      stablePolls = 0
      await publish("done")
    }

    void prime()
    const timer = setInterval(() => void poll(), TURN_STATUS_POLL_MS)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
    })
  })

  // Open the file's diff/content in a full-width preview window of the
  // task's tmux session. The Ops pane lives in that session, named
  // `kobe-<taskId>`, so we can target it by name.
  function openPreview(rel: string): void {
    // Without a task id, `tmuxSessionName("")` is `kobe-`, which targets a
    // session that doesn't exist — new-window would just error and Enter
    // would silently do nothing. Only the standalone `kobe ops --worktree X`
    // invocation (no --task-id) hits this; the in-session Ops pane always
    // has one. Bail rather than fire at a phantom session (KOB-244).
    if (!props.taskId) return
    void newWindow(tmuxSessionName(props.taskId), {
      cwd: props.worktree,
      command: previewWindowCommand({ worktree: props.worktree, relPath: rel, cliInvocation: kobeCliInvocation() }),
      name: basename(rel),
    })
  }

  // `e` on a file → open it in the user's editor (vim / nano / custom) in
  // a fresh tmux window. Read-only preview (enter) and editor (e) are
  // separate, deliberate actions — no preview→edit bridge. If the editor
  // can't launch (binary missing / nothing configured), fall back to the
  // read-only preview so `e` is never a dead key. Same phantom-session
  // guard as `openPreview`: a standalone `kobe ops` (no task id) has no
  // session to open a window in, so just preview.
  function openEditor(rel: string): void {
    if (!props.taskId) {
      openPreview(rel)
      return
    }
    const abs = `${props.worktree}/${rel}`
    void openInEditor(tmuxSessionName(props.taskId), props.worktree, abs).then((launched) => {
      if (!launched) openPreview(rel)
    })
  }

  // `a` on a file → inject `@<path> ` into the engine pane via tmux
  // send-keys (KOB-232). `targetPane` is the claude/codex pane id passed
  // by the launcher (`opsPaneCommand --target-pane`). Literal send (the
  // shared `sendKeys` uses `-l`), trailing space, NO Enter — the user
  // decides when to submit, and focus stays in the Ops pane so they can
  // queue several mentions. No-op when there's no target pane (a
  // standalone `kobe ops` invocation without --target-pane).
  function injectMention(rel: string): void {
    if (!props.targetPane) return
    void sendKeys(props.targetPane, `@${rel} `)
  }

  async function createPR(): Promise<void> {
    if (!props.targetPane) return
    const prompt = await buildPRPrompt(props.worktree)
    await sendKeys(props.targetPane, prompt)
    await sendKeyName(props.targetPane, "Enter")
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <FileTree
        worktreePath={() => props.worktree}
        focused={() => true}
        onOpenFile={openPreview}
        onEditFile={openEditor}
        onMention={injectMention}
        onCreatePR={() => void createPR()}
        cornerBadge={cornerBadge}
        onRefresh={ackActivity}
      />
    </box>
  )
}

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

function fingerprint(text: string): string {
  return createHash("sha1").update(text).digest("hex")
}

function OpsApp(props: OpsHostArgs & { prefs: ThemePrefs }) {
  return (
    <ThemeProvider mode="dark" theme={props.prefs.theme}>
      <DialogProvider>
        <OpsShell {...props} />
      </DialogProvider>
    </ThemeProvider>
  )
}

export async function startOpsHost(args: OpsHostArgs): Promise<void> {
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
  const prefs = readPersistedUiPrefs(FALLBACK_THEME)
  await render(() => <OpsApp {...args} prefs={prefs} />, {
    backgroundColor: "transparent",
    externalOutputMode: "passthrough",
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    useKittyKeyboard: {},
  })
}

/* ─── full-width preview window (`kobe ops --preview <rel>`) ─────────── */

export interface OpsPreviewArgs {
  readonly worktree: string
  readonly relPath: string
}

/** Map a file extension to an opentui tree-sitter grammar name. */
function filetypeOf(relPath: string): string | undefined {
  const ext = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase()
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript"
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript"
    case "md":
    case "markdown":
      return "markdown"
    default:
      return undefined
  }
}

async function gitDiff(worktree: string, relPath: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "diff", "HEAD", "--", relPath], {
      cwd: worktree,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      // Read-only diff for the preview. `git diff` would otherwise
      // rewrite `.git/index`'s stat cache and take `.git/index.lock`,
      // racing the worktree's engine commits for the lock.
      // `GIT_OPTIONAL_LOCKS=0` keeps it lock-free.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return text
  } catch {
    return ""
  }
}

async function readFileText(worktree: string, relPath: string): Promise<string> {
  try {
    return await Bun.file(`${worktree}/${relPath}`).text()
  } catch {
    return ""
  }
}

/**
 * Build a tree-sitter SyntaxStyle from the active kobe theme.
 * `SyntaxStyle.create()` is an EMPTY style — opentui parses the code
 * into capture groups but renders them plain unless each scope has a
 * registered colour. We map the nvim-treesitter capture names the
 * bundled ts/js/markdown grammars emit (probed: keyword, string,
 * comment, type, function, number, …) onto kobe's palette so the
 * preview's highlighting matches the rest of the TUI.
 */
function buildSyntaxStyle(theme: ReturnType<typeof useTheme>["theme"]): SyntaxStyle {
  const kw = { fg: theme.primary }
  const str = { fg: theme.success }
  const fn = { fg: theme.info }
  const typ = { fg: theme.warning }
  const num = { fg: theme.accent }
  const com = { fg: theme.textMuted, italic: true }
  const punct = { fg: theme.textMuted }
  const txt = { fg: theme.text }
  return SyntaxStyle.fromStyles({
    keyword: kw,
    "keyword.function": kw,
    "keyword.return": kw,
    "keyword.import": kw,
    "keyword.exception": kw,
    "keyword.conditional": kw,
    "keyword.repeat": kw,
    "keyword.operator": kw,
    "keyword.modifier": kw,
    "keyword.type": kw,
    string: str,
    "string.escape": str,
    "string.regexp": str,
    "string.special": str,
    "character.special": str,
    comment: com,
    "comment.documentation": com,
    function: fn,
    "function.call": fn,
    "function.method": fn,
    "function.builtin": fn,
    constructor: fn,
    type: typ,
    "type.builtin": typ,
    constant: num,
    "constant.builtin": num,
    boolean: num,
    number: num,
    operator: punct,
    "punctuation.bracket": punct,
    "punctuation.delimiter": punct,
    "punctuation.special": punct,
    variable: txt,
    "variable.member": txt,
    "variable.parameter": txt,
    "variable.builtin": num,
    property: txt,
    attribute: typ,
    label: txt,
    module: txt,
  })
}

function PreviewScreen(props: OpsPreviewArgs) {
  const { theme } = useTheme()
  const style = buildSyntaxStyle(theme)
  const filetype = filetypeOf(props.relPath)

  const [data] = createResource(
    () => props.relPath,
    async (rel) => {
      const diff = await gitDiff(props.worktree, rel)
      if (diff.trim().length > 0) return { kind: "diff" as const, text: diff }
      return { kind: "code" as const, text: await readFileText(props.worktree, rel) }
    },
  )

  useBindings(() => ({
    bindings: [
      { key: "q", cmd: () => process.exit(0) },
      { key: "escape", cmd: () => process.exit(0) },
      { key: "ctrl+c", cmd: () => process.exit(0) },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme.accent}>{props.relPath}</text>
        <text fg={theme.textMuted}>{data()?.kind === "diff" ? "diff vs HEAD" : "file"}</text>
        <text fg={theme.textMuted}>· q to close</text>
      </box>
      <box flexGrow={1}>
        <Show when={data()} fallback={<text fg={theme.textMuted}>loading…</text>}>
          {(d) => (
            <Show
              when={d().kind === "diff"}
              fallback={<code content={d().text} filetype={filetype} syntaxStyle={style} />}
            >
              <diff diff={d().text} view="unified" filetype={filetype} syntaxStyle={style} showLineNumbers={true} />
            </Show>
          )}
        </Show>
      </box>
    </box>
  )
}

export async function startOpsPreview(args: OpsPreviewArgs): Promise<void> {
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
  const prefs = readPersistedUiPrefs(FALLBACK_THEME)
  await render(
    () => (
      <ThemeProvider mode="dark" theme={prefs.theme}>
        <DialogProvider>
          <PreviewScreen {...args} />
        </DialogProvider>
      </ThemeProvider>
    ),
    {
      backgroundColor: "transparent",
      externalOutputMode: "passthrough",
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
      useKittyKeyboard: {},
    },
  )
}
