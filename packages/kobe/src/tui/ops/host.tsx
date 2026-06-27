/**
 * `kobe ops` host — the Ops pane on the right side of a task's tmux
 * session (v0.6 / KOB-233).
 *
 * Reuses the v0.5 `FileTree` to browse the worktree. Activating a file
 * (enter / click) is a one-key "just open it": it opens the file in the
 * user's nvim/vim in a fresh tmux window — side-by-side `nvim -d` diff vs
 * HEAD when the file has changes, a plain editable open when it doesn't.
 * Only when no nvim/vim is installed does it fall back to our own built-in
 * **full-width preview window** — a fresh tmux window running
 * `kobe ops --preview <file>`, which renders opentui's `<diff>` / `<code>`
 * (tree-sitter syntax highlighting + line numbers, zero external deps),
 * closed with `q` back to the three-pane layout. So nvim is the primary
 * surface and the opentui preview is the last-resort fallback.
 *
 * Runs in its own OS process inside the tmux pane (separate opentui
 * render loop from the outer kobe TUI). It can't share the outer TUI's
 * Solid runtime, but it DOES inherit the user's theme: host-boot reads
 * the persisted prefs at boot (read-only — the outer app owns
 * `state.json`) and re-applies them live from the daemon's `ui-prefs`
 * channel (UiPrefsSync).
 */

import { createHash } from "node:crypto"
import { kobeCliInvocation } from "@/cli/invocation"
import { type ChatTabTurnState, createEngineTurnDetector } from "@/engine/turn-detector"
import { latestTranscriptMtime } from "@/monitor/activity"
import {
  capturePaneById,
  newWindow,
  runTmux,
  sendKeyName,
  sendKeys,
  setWindowOption,
  tmuxSessionName,
} from "@/tmux/client"
import { openInEditor } from "@/tmux/editor-launch"
import { previewWindowCommand, shellQuote, shellQuoteArgv } from "@/tmux/session-layout"
import type { VendorId } from "@/types/task"
import { readWorktreeFile, runWorktreeGit } from "@/worktree/content"
import { SyntaxStyle } from "@opentui/core"
import { Show, createEffect, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { connectPaneOrchestrator } from "../../client/connect-pane-orchestrator"
import type { RemoteOrchestrator, TranscriptActivity } from "../../client/remote-orchestrator"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { FileTree } from "../panes/filetree"
import { inheritedEnvPrefix } from "../panes/terminal/launch"
import {
  ACTIVITY_POLL_MIN_MS,
  TURN_STATUS_POLL_MS,
  nextActivityPollDelay,
  nextTurnStatusPollDelay,
} from "./activity-poll"
import { buildPRPrompt } from "./pr-prompt"

export interface OpsHostArgs {
  readonly taskId: string
  readonly worktree: string
  /** tmux pane id / selector for the claude pane — send-keys target. */
  readonly targetPane: string | null
  /** Task engine vendor — selects which transcript store the activity badge polls. */
  readonly vendor: VendorId
}

// Poll-cadence constants + the pure backoff curves live in `./activity-poll`
// (host.tsx can't be imported under vitest — it pulls @opentui render assets —
// so the testable math is factored out). The daemon's `transcript.activity`
// channel now does the shareable filesystem half; these cadences govern only
// the local fallback (badge mtime probe) and the always-in-process tmux
// capture-pane quiescence poll.
const STABLE_POLLS_FOR_DONE = 2
const CHAT_TAB_STATE_OPTION = "@kobe_tab_state"

function OpsShell(props: OpsHostArgs) {
  const { theme } = useTheme()

  // Visual prefs (theme / transparent / focus accent) are applied
  // centrally — boot + live `ui-prefs` pushes — by host-boot's
  // UiPrefsSync; this shell no longer re-applies them itself.

  // ONE scoped pane orchestrator for the daemon's `transcript.activity`
  // channel (perf — deduplicate per-Ops-pane polling). The daemon runs a
  // single collector that does the SHAREABLE filesystem half — newest
  // transcript mtime + the engine-owned completion marker — for every
  // worktree; this pane reads its worktree's slice instead of stat'ing +
  // parsing the transcript store on its own timers. Non-spawning + leak-
  // guarded, the same pattern host-boot's UiPrefsSync uses: a helper pane
  // must never resurrect an idle-stopped daemon, and a connect that resolves
  // after cleanup is disposed on the spot. When there's no daemon (null
  // orchestrator) OR the daemon predates the channel (signal stays null), the
  // local fallback below engages verbatim — the per-window tmux capture-pane
  // quiescence check + @kobe_tab_state write ALWAYS stay in this process.
  const [activityOrch, setActivityOrch] = createSignal<RemoteOrchestrator | null>(null)
  let orchDisposed = false
  onMount(() => {
    void (async () => {
      const remote = await connectPaneOrchestrator({ logTag: "ops-activity", channels: ["transcript.activity"] })
      if (!remote) return
      if (orchDisposed) {
        remote.dispose()
        return
      }
      setActivityOrch(remote)
    })()
  })
  onCleanup(() => {
    orchDisposed = true
    activityOrch()?.dispose()
  })
  // The daemon-collected facts for THIS worktree, or `null` when there's no
  // daemon-collected data (no daemon yet, or an old daemon without the
  // channel) — that null is the fallback trigger throughout this component.
  const sharedActivityMap = () => activityOrch()?.transcriptActivitySignal()() ?? null
  const sharedEntry = (): TranscriptActivity | null => sharedActivityMap()?.get(props.worktree) ?? null

  // New-activity badge (KOB-254). v0.6 has no chat-stream "done" signal and
  // we explicitly don't parse the tmux pane, so the engine's own transcript
  // store (the JSONL the cost dashboard reads) is the source: light a corner
  // badge when its newest mtime advances past what we last acknowledged.
  // `baseline` starts at "now's newest" so a pane that mounts onto an
  // already-busy task doesn't flash stale activity; it's pushed forward on
  // each `r` refresh (the user's "I've looked"). The mtime SOURCE is the
  // daemon's `transcript.activity` push when available, falling back to the
  // local `latestTranscriptMtime` probe only when no daemon-collected data
  // exists.
  const [baseline, setBaseline] = createSignal(0)
  const [latest, setLatest] = createSignal(0)
  let primed = false

  // Shared-source badge: read the daemon-pushed mtime for this worktree. Seed
  // the baseline on the first NON-ZERO mtime (an empty/just-connected map
  // reads 0 — not real activity), then track advances. Inactive (returns
  // early) whenever there's no daemon-collected data, leaving the local
  // fallback effect below in charge.
  createEffect(() => {
    const map = sharedActivityMap()
    if (!map) return
    const mtime = map.get(props.worktree)?.mtimeMs ?? 0
    if (!primed && mtime > 0) {
      primed = true
      setBaseline(mtime)
    }
    setLatest(mtime)
  })

  // Local fallback badge poll — runs ONLY while there's no daemon-collected
  // data (`sharedActivityMap()` null: no daemon, or an old daemon without the
  // channel). Verbatim the pre-daemon adaptive-backoff loop. The effect tears
  // it down the instant the daemon channel becomes available (Solid runs the
  // prior run's onCleanup before re-running) and restarts it if a reconnect
  // downgrades to a daemon without the channel.
  createEffect(() => {
    if (sharedActivityMap() !== null) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Adaptive backoff state: the current poll delay + how many consecutive
    // reads have seen no mtime advance (see nextActivityPollDelay).
    let delayMs = ACTIVITY_POLL_MIN_MS
    let idleStreak = 0
    let lastSeenMtime = 0
    async function poll(): Promise<void> {
      try {
        const mtime = await latestTranscriptMtime(props.vendor, props.worktree)
        if (disposed) return
        if (!primed) {
          // First read seeds the baseline so we only ever flag activity
          // that happened after the pane came up.
          primed = true
          setBaseline(mtime)
          lastSeenMtime = mtime
        }
        // Snap back to the fast interval the instant the transcript advances;
        // otherwise ramp the delay so an idle pane stops stat-churning the
        // (unboundedly growing) transcript dir every 2.5s.
        if (mtime > lastSeenMtime) {
          lastSeenMtime = mtime
          idleStreak = 0
        } else {
          idleStreak++
        }
        setLatest(mtime)
      } catch {
        // The worktree can vanish out from under a live pane (the task is
        // being deleted: kobe removes the worktree, then kills this
        // session — a multi-second window for a node_modules-heavy tree).
        // A transient read failure must NOT crash the pane: this process
        // has no unhandledRejection net (that's daemon-only), so a bare
        // `void poll()` rejection would drop the whole Ops pane to a raw
        // shell. Swallow and let the next tick retry / `disposed` stop us. A
        // failed read isn't "activity", so let the idle ramp keep climbing.
        idleStreak++
      } finally {
        if (!disposed) {
          delayMs = nextActivityPollDelay(delayMs, idleStreak)
          timer = setTimeout(() => void poll(), delayMs)
        }
      }
    }
    void poll()
    onCleanup(() => {
      disposed = true
      if (timer) clearTimeout(timer)
    })
  })
  const hasNewActivity = () => primed && latest() > baseline()
  const cornerBadge = () => (hasNewActivity() ? { text: t("ops.badge.newActivity"), active: true } : null)
  function ackActivity(): void {
    setBaseline(latest())
  }

  // Per-window turn detector. The engine adapter owns transcript-specific
  // completion markers (Codex `turn.completed`, Claude assistant records).
  // This pane owns only the tmux-local quiescence check for its paired
  // engine pane, so sibling ChatTabs on the same worktree don't report done
  // unless THIS window actually changed.
  //
  // The `tmux capture-pane` hash + the `@kobe_tab_state` `setWindowOption`
  // write STAY strictly in-process — the daemon never touches tmux. What
  // moved daemon-side is the COMPLETION read: when the `transcript.activity`
  // channel is live we take the engine-owned `completionId` from the shared
  // push instead of re-parsing the JSONL here, and back the capture-pane
  // interval off while the shared transcript is quiescent. With no daemon-
  // collected data we keep the pre-daemon behavior verbatim: a fixed 1.5s
  // capture-pane interval + a local `detector.latestCompletion` read.
  onMount(() => {
    if (!props.targetPane) return
    // Construct the detector unconditionally: `supportsCompletionMarkers()` is
    // a pure synchronous flag (no IO) needed in both modes, and the fallback
    // path still calls `latestCompletion`. In shared mode `latestCompletion`
    // is never called — the daemon owns that read.
    const detector = createEngineTurnDetector(props.vendor)
    let disposed = false
    let baselineCompletionId: string | null = null
    let baselinePrimed = false
    let paneHash = ""
    let observedPaneActivity = false
    let stablePolls = 0
    let published: ChatTabTurnState | null = null
    // Adaptive capture-pane cadence (shared mode only): ramps up while the
    // shared transcript is quiescent, snaps back when its mtime advances.
    let delayMs = TURN_STATUS_POLL_MS
    let lastSharedMtime = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    /** Whether the daemon is publishing transcript activity for this worktree. */
    const usingShared = (): boolean => sharedActivityMap() !== null

    async function publish(state: ChatTabTurnState): Promise<void> {
      if (state === published) return
      published = state
      await setWindowOption(props.targetPane!, CHAT_TAB_STATE_OPTION, state)
    }

    /** Latest completion id — from the shared push when available, else a local read. */
    async function latestCompletionId(): Promise<string | null> {
      if (usingShared()) return sharedEntry()?.completionId ?? null
      return (await detector.latestCompletion(props.worktree))?.id ?? null
    }

    async function prime(): Promise<void> {
      try {
        paneHash = fingerprint(await capturePaneById(props.targetPane!, 80))
        baselineCompletionId = await latestCompletionId()
        baselinePrimed = true
        await publish(detector.supportsCompletionMarkers() ? "idle" : "unknown")
      } catch {
        // See the activity poll above: transient failures during the
        // delete→kill teardown window must not crash this crash-net-less
        // pane process. The next `poll()` tick re-primes naturally.
      }
    }

    async function poll(): Promise<void> {
      const shared = usingShared()
      try {
        const nextPaneHash = fingerprint(await capturePaneById(props.targetPane!, 80))
        if (disposed) return
        // Lazily seed the baseline if shared activity arrived only after
        // prime ran with no entry — so the first daemon-pushed completion
        // isn't mistaken for a fresh "done".
        if (shared && !baselinePrimed) {
          baselineCompletionId = sharedEntry()?.completionId ?? null
          baselinePrimed = true
        }
        // Track shared-transcript mtime advance for the adaptive cadence.
        const sharedMtime = shared ? (sharedEntry()?.mtimeMs ?? 0) : 0
        const mtimeAdvanced = sharedMtime > lastSharedMtime
        if (sharedMtime > lastSharedMtime) lastSharedMtime = sharedMtime

        if (nextPaneHash !== paneHash) {
          paneHash = nextPaneHash
          observedPaneActivity = true
          stablePolls = 0
          await publish(detector.supportsCompletionMarkers() ? "running" : "unknown")
        } else if (observedPaneActivity) {
          stablePolls++
        }

        if (detector.supportsCompletionMarkers() && observedPaneActivity && stablePolls >= STABLE_POLLS_FOR_DONE) {
          const completionId = await latestCompletionId()
          // Done rule unchanged: a NEW completion id past the baseline, with
          // the pane having gone quiescent, means the turn finished.
          if (!disposed && completionId !== null && completionId !== baselineCompletionId) {
            baselineCompletionId = completionId
            observedPaneActivity = false
            stablePolls = 0
            await publish("done")
          }
        }
        // Cadence: shared mode ramps the capture-pane interval while idle;
        // fallback keeps the fixed 1.5s tick.
        delayMs = shared ? nextTurnStatusPollDelay(delayMs, mtimeAdvanced, published) : TURN_STATUS_POLL_MS
      } catch {
        // capturePaneById / publish (setWindowOption) fire tmux against
        // `props.targetPane` — once the task is deleted that pane and its
        // session are torn down, so these reject mid-flight. Swallow so a
        // teardown race degrades to a quiet no-op instead of crashing the
        // Ops pane to a shell with a stack dump (the reported bug).
        delayMs = TURN_STATUS_POLL_MS
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), delayMs)
      }
    }

    void prime()
    timer = setTimeout(() => void poll(), TURN_STATUS_POLL_MS)
    onCleanup(() => {
      disposed = true
      if (timer) clearTimeout(timer)
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

  // enter on a file → one-key "just open it". Open it in the user's
  // nvim/vim in a fresh tmux window (side-by-side `nvim -d` diff vs HEAD
  // when changed, plain editable open otherwise). Only when no editor can
  // launch (no nvim/vim installed / nothing configured) do we fall back to
  // our own read-only opentui preview — so enter is never a dead key.
  // Phantom-session guard: a standalone `kobe ops` (no task id) has no
  // session to open an editor window in, so it just previews.
  function openFile(rel: string): void {
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

  // Toggle zen mode for this ChatTab's tmux session. Entering zen kills THIS
  // pane (the file/Ops pane the chip lives in), so we must NOT run the action
  // in-process — SIGHUP would abort it after only the Ops pane was hidden,
  // leaving the terminal up. Hand it to tmux `run-shell -b` instead (same path
  // the `prefix`-space chord uses): the tmux server runs it detached from any
  // pane, so it survives this pane's death and completes every hide/restore.
  // A standalone `kobe ops` (no task id) has no session to act on.
  function toggleZen(): void {
    if (!props.taskId) return
    const session = tmuxSessionName(props.taskId)
    const inv = kobeCliInvocation()
    const cmd = `${inheritedEnvPrefix()}${shellQuoteArgv(inv)} layout --session ${shellQuote(session)} --action zen-toggle`
    void runTmux(["run-shell", "-b", cmd])
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <FileTree
        worktreePath={() => props.worktree}
        focused={() => true}
        onOpenFile={openFile}
        onMention={injectMention}
        onCreatePR={() => void createPR()}
        onZenToggle={props.taskId ? toggleZen : undefined}
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

export async function startOpsHost(args: OpsHostArgs): Promise<void> {
  // No KV / Focus providers — the FileTree never touches persisted UI
  // state or pane focus; this pane has always been Theme > Dialog only.
  await bootPaneHost({
    logContext: "ops",
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <OpsShell {...args} /> }),
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
  const res = await runWorktreeGit(worktree, ["diff", "HEAD", "--", relPath])
  return res.status === 0 ? res.stdout : ""
}

async function readFileText(worktree: string, relPath: string): Promise<string> {
  return (await readWorktreeFile(worktree, relPath)) ?? ""
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
        <text fg={theme.textMuted}>
          {data()?.kind === "diff" ? t("ops.preview.diffVsHead") : t("ops.preview.file")}
        </text>
        <text fg={theme.textMuted}>{t("ops.preview.closeHint")}</text>
      </box>
      <box flexGrow={1}>
        <Show when={data()} fallback={<text fg={theme.textMuted}>{t("ops.preview.loading")}</text>}>
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
  // Same minimal provider set as the Ops pane. Note: unlike startOpsHost
  // this entrypoint never set a client-log context — preserved as-is.
  await bootPaneHost({
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <PreviewScreen {...args} /> }),
  })
}
