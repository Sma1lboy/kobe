/**
 * `kobe history` host — a read-only engine-history preview pane (beta).
 *
 * When an ARCHIVED task is opened with the `experimental.archivedHistoryPreview`
 * gate on, the session-build (panes/terminal/tmux.ts) launches THIS process into
 * the engine pane slot INSTEAD of the live engine CLI — so the "vendor pane" you
 * normally chat in is replaced by a scrollable transcript with a session
 * selector. An archived task usually has no running engine (and may have no
 * worktree at all), but its transcript still lives in the engine's vendor store
 * keyed by the worktree PATH STRING (claude `~/.claude/projects/*`, codex
 * `~/.codex/sessions/**`), which `git worktree remove` never touched. We read it
 * through the neutral `EngineHistoryReader` (engine/registry.ts), so no vendor
 * transcript format leaks into this UI (CLAUDE.md: engine-owned UI data).
 *
 * Row rendering (MessageCard / block views) lives in `message-card.tsx`; only
 * a bounded tail of the transcript is mounted (`window.ts`) because opentui's
 * scrollbox culls drawing, not Renderables — see that file for the why.
 * Runs in its own OS process inside the tmux pane, same standalone-pane shape
 * as `kobe ops` (`tui/ops/host.tsx`). Pure read surface: no engine spawn, no
 * write path, no daemon dependency.
 */

import { type EngineHistoryReader, engineEntry } from "@/engine/registry"
import type { Message } from "@/types/engine"
import type { VendorId } from "@/types/task"
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { sessionAttached } from "../lib/attach-gate"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { ACTIVITY_POLL_MIN_MS, nextActivityPollDelay } from "../ops/activity-poll"
import { MessageCard, resultsByCallId } from "./message-card"
import { windowTail } from "./window"

// Shared with the chat surface (chat/ChatRow.tsx imports from this module).
export { BodyLines, bodyText, toolInputSummary } from "./message-card"

export interface HistoryHostArgs {
  readonly worktree: string
  readonly vendor: VendorId
  /** Optional task title for the header; falls back to the worktree basename. */
  readonly title?: string
  /**
   * Live preview of a non-archived task (vs the frozen archived transcript):
   * the header tags LIVE instead of ARCHIVED. The mtime poll runs either way;
   * this only picks the badge.
   */
  readonly live?: boolean
  /**
   * Override the transcript source. Production leaves it undefined (reads the
   * real engine store via {@link engineEntry}); the dev:mock host injects a
   * fake reader so the whole pane renders without a real worktree/transcript.
   */
  readonly reader?: EngineHistoryReader
}

/** Lines of transcript scrolled per `j`/`k` keypress. */
const SCROLL_STEP = 3

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

function HistoryScreen(props: HistoryHostArgs) {
  const { theme } = useTheme()
  // Data source: the injected reader (dev:mock) or the real engine transcript
  // store. All three reads below go through it so a mock drives the whole pane.
  const reader = props.reader ?? engineEntry(props.vendor).history

  // Live refresh: poll the vendor transcript mtime (adaptive backoff, shared
  // with the Ops pane) and bump this tick when it advances so the resources
  // below refetch. An archived task whose transcript never changes ramps the
  // backoff to its cap — effectively idle — so the same host serves both the
  // static archived preview and a live follow of an active worktree.
  const [refreshTick, setRefreshTick] = createSignal(0)

  const [sessions] = createResource(
    () => [props.worktree, refreshTick()] as const,
    async ([wt]): Promise<readonly string[]> => {
      try {
        return await reader.listSessionIdsForWorktree(wt)
      } catch {
        return []
      }
    },
  )
  // `.latest` keeps the last resolved list visible while a refresh refetch is in
  // flight, so a live tick doesn't blink the pane back to its loading state.
  const sessionList = (): readonly string[] => sessions.latest ?? []

  const [selected, setSelected] = createSignal(0)
  // Follow the newest session when a NEW one appears (or on first load), but
  // leave the cursor alone on a same-count refresh so a user browsing an older
  // session with `[`/`]` isn't yanked back to the tail every poll.
  let prevSessionCount = 0
  createEffect(
    on(sessions, (s) => {
      const n = (s ?? []).length
      if (n > prevSessionCount) setSelected(n > 0 ? n - 1 : 0)
      else setSelected((i) => Math.min(i, Math.max(0, n - 1)))
      prevSessionCount = n
    }),
  )
  const selectedId = (): string | undefined => sessionList()[selected()]

  const [messages] = createResource(
    () => {
      const id = selectedId()
      return id ? ([id, refreshTick()] as const) : undefined
    },
    async ([id]): Promise<Message[]> => {
      try {
        return await reader.readHistory(id)
      } catch {
        return []
      }
    },
  )
  const messageList = (): Message[] => messages.latest ?? []
  // Session-level stats stay computed over the FULL list; only the mounted
  // rows are windowed (window.ts explains the native-renderable retention).
  const results = createMemo(() => resultsByCallId(messageList()))
  const tokenTotal = createMemo(() => messageList().reduce((sum, m) => sum + (m.usage?.output_tokens ?? 0), 0))
  const tail = createMemo(() => windowTail(messageList()))

  const [expanded, setExpanded] = createSignal(false)

  // Drive refreshTick from the transcript mtime: the first read seeds the
  // baseline (resources already fetched on mount), then a tick fires only when
  // mtime advances. On an archived / idle worktree the delay ramps to its cap.
  onMount(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let delayMs = ACTIVITY_POLL_MIN_MS
    let idleStreak = 0
    let lastMtime = 0
    let primed = false
    async function poll(): Promise<void> {
      // Detached (background) session: skip the transcript stat — the preview
      // is invisible. Next tick after re-attach resumes the live tail.
      if (!(await sessionAttached())) {
        if (!disposed) timer = setTimeout(() => void poll(), delayMs)
        return
      }
      try {
        const mtime = await reader.latestTranscriptMtimeForWorktree(props.worktree)
        if (disposed) return
        if (!primed) {
          primed = true
          lastMtime = mtime
          idleStreak++
        } else if (mtime > lastMtime) {
          lastMtime = mtime
          idleStreak = 0
          setRefreshTick((n) => n + 1)
        } else {
          idleStreak++
        }
      } catch {
        // The worktree can vanish under a live pane (task deletion); a transient
        // read failure must not crash this daemon-less process — swallow and let
        // the idle ramp keep climbing.
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

  let scrollRef: ScrollBoxRenderable | undefined
  const scrollBy = (dy: number): void => {
    if (!scrollRef) return
    scrollRef.scrollTo({ x: 0, y: Math.max(0, scrollRef.scrollTop + dy) })
  }
  createEffect(on(selectedId, () => scrollRef?.scrollTo({ x: 0, y: 0 })))

  const switchSession = (delta: number): void => {
    const n = sessionList().length
    if (n === 0) return
    setSelected((i) => Math.min(Math.max(i + delta, 0), n - 1))
  }

  // No self-close binding: this read-only preview replaces the engine pane of an
  // ARCHIVED task. Its pane re-launches it on exit (historyPaneKeepAlive), so a
  // quit would just reload the preview. The preview is left like any other pane —
  // dismissed via the Tasks rail or Ctrl+Q.
  useBindings(() => ({
    bindings: [
      { key: "j", cmd: () => scrollBy(SCROLL_STEP) },
      { key: "k", cmd: () => scrollBy(-SCROLL_STEP) },
      { key: "down", cmd: () => scrollBy(SCROLL_STEP) },
      { key: "up", cmd: () => scrollBy(-SCROLL_STEP) },
      { key: "[", cmd: () => switchSession(-1) },
      { key: "]", cmd: () => switchSession(1) },
      { key: "return", cmd: () => setExpanded((e) => !e) },
    ],
  }))

  const headerTitle = (): string => props.title?.trim() || basename(props.worktree)
  const counter = (): string => {
    const n = sessionList().length
    return n > 0 ? `${t("history.sessionLabel")} ${selected() + 1}/${n}` : ""
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      {/* Brand header — ARCHIVED tag · title · session N/M · token total. */}
      <box
        flexDirection="row"
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        backgroundColor={theme.backgroundElement}
      >
        <text fg={props.live ? theme.success : theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
          {props.live ? t("history.liveTag") : t("history.archivedTag")}
        </text>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
          {headerTitle()}
        </text>
        <Show when={counter()}>
          <text fg={theme.textMuted} wrapMode="none">
            {`· ${counter()}`}
          </text>
        </Show>
        <box flexGrow={1} />
        <Show when={tokenTotal() > 0}>
          <text fg={theme.textMuted} wrapMode="none">
            {`${tokenTotal()} tok`}
          </text>
        </Show>
      </box>
      <scrollbox
        ref={(r: ScrollBoxRenderable) => {
          scrollRef = r
        }}
        flexGrow={1}
        verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
      >
        <Show
          when={sessions.latest !== undefined}
          fallback={
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted}>{t("history.loading")}</text>
            </box>
          }
        >
          <Show
            when={messageList().length > 0}
            fallback={
              <box paddingTop={1} paddingLeft={1}>
                <text fg={theme.textMuted}>{t("history.empty")}</text>
              </box>
            }
          >
            <Show when={tail().hiddenCount > 0}>
              <box paddingLeft={1} paddingRight={1} paddingBottom={1}>
                <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="none">
                  {t("history.earlier", { count: tail().hiddenCount })}
                </text>
              </box>
            </Show>
            <For each={tail().visible}>
              {(msg) => <MessageCard msg={msg} results={results()} expanded={expanded()} />}
            </For>
          </Show>
        </Show>
      </scrollbox>
      {/* Hint bar. */}
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        backgroundColor={theme.backgroundElement}
      >
        <text fg={theme.textMuted} wrapMode="none">
          {expanded() ? t("history.hintExpanded") : t("history.hint")}
        </text>
      </box>
    </box>
  )
}

export async function startHistoryHost(args: HistoryHostArgs): Promise<void> {
  // Minimal provider set, same as the Ops pane: this surface never touches
  // persisted UI state or pane focus — Theme + Dialog only (host-boot still
  // applies theme/locale from state.json at boot + live ui-prefs pushes).
  await bootPaneHost({
    logContext: "history",
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <HistoryScreen {...args} /> }),
  })
}
