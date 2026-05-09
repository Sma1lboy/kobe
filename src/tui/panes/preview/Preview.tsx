/**
 * kobe preview pane (Stream I) — center-top of the Conductor layout.
 *
 * Multi-tab file/diff viewer:
 *   - Tab bar at the top: one tab per opened file with an `x` close button.
 *   - Mode toggle in the header — `f` (File) shows raw content, `d` (Diff)
 *     runs `git diff <base>` and renders via `DiffLine`. Default mode is
 *     Diff when the file is in `git status` AND `diffBase` is set,
 *     otherwise File. Per-tab mode (state.ts) so each tab remembers.
 *   - Scrollable body. Long files use opentui's `<scrollbox>` rather
 *     than truncating — the brief explicitly requires this for v1.
 *   - Empty state: "Open a file from the tree (enter)".
 *
 * Imperative API: parent passes an `onOpen(api)` callback. We invoke it
 * once at mount with `{ open(path), close(path) }`. The parent (Stream H
 * file tree, then the orchestrator) calls those to drive the pane —
 * matches the contract block in the brief.
 *
 * State split:
 *   - `state.ts` owns the immutable tab list / active index / per-tab
 *     mode + scroll. Pure; unit-tested.
 *   - This component holds the `[state, setState]` Solid signal and
 *     re-runs file/diff fetches when the active tab or mode changes.
 *   - `keys.ts` registers pane-local bindings via `useBindings`.
 *
 * Why `createEffect` (not `createResource`) for fetches: the data
 * source is a synchronous `spawnSync` (see diff.ts) wrapped in
 * `Promise.resolve` for API symmetry. Effect + signal is the simplest
 * cycle: dependencies are `(activeTab, mode)`, output is a content
 * signal the renderer reads. `createResource`'s loading/error machinery
 * adds noise we don't need at this scale.
 */

import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { type Accessor, For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onMount } from "solid-js"
import { useTheme } from "../../context/theme"
import { DiffLine, FileLine } from "./DiffLine"
import { isPathChanged, readDiff, readFile, splitLines } from "./diff"
import { usePreviewBindings } from "./keys"
import {
  EMPTY_STATE,
  type PreviewMode,
  type PreviewState,
  type PreviewTab,
  activeTab,
  closeTab,
  moveActive,
  openTab,
  setActiveMode,
  setActiveScroll,
  tabLabel,
} from "./state"

/** Public props — matches the contract in the brief verbatim. */
export type PreviewProps = {
  worktreePath: Accessor<string | null>
  diffBase: Accessor<string | null>
  onOpen?: (api: PreviewApi) => void
  focused?: Accessor<boolean>
}

/** Imperative API the parent drives. Stable for the component's lifetime. */
export type PreviewApi = {
  open(relPath: string): void
  close(relPath: string): void
}

/**
 * Visible body height for scrollbox + page-key fallback. opentui's
 * scrollbox accepts `height` as cells; pgup/pgdn use this as the unit.
 * Matches dialog-diff's choice.
 */
const BODY_HEIGHT = 20

type ContentState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "lines"; lines: string[]; mode: PreviewMode }

export function Preview(props: PreviewProps) {
  const { theme } = useTheme()

  const focusedAccessor = () => (props.focused ? props.focused() : true)

  // Tab list + active index live here as a single immutable snapshot;
  // every mutation goes through `state.ts`'s pure helpers. The Solid
  // signal wraps the snapshot ref so reactivity tracks at the snapshot
  // level (no fine-grained store needed for ~tens of tabs).
  const [state, setState] = createSignal<PreviewState>(EMPTY_STATE)

  // Async-content snapshot for the active tab. Re-derives whenever the
  // active tab path or mode changes. Held in a separate signal so the
  // render path doesn't await — the body shows a loading state during
  // refresh.
  const [content, setContent] = createSignal<ContentState>({ kind: "empty" })

  // Scrollbox ref so keys.ts can imperatively scroll. The ref callback
  // is invoked by opentui after mount; we close over the latest ref via
  // a closure variable.
  let scroll: ScrollBoxRenderable | undefined

  /**
   * Open a tab for `path` and pick a sensible default mode based on
   * `diffBase` + `git status`. We can't await inside `open()` (the
   * imperative API is synchronous), so we open with a provisional mode
   * and asynchronously upgrade to Diff if appropriate.
   */
  function openPath(relPath: string): void {
    if (!relPath) return
    setState((s) => openTab(s, relPath, "file"))
    const base = props.diffBase()
    const wt = props.worktreePath()
    if (!base || !wt) return
    void isPathChanged(wt, relPath).then((changed) => {
      if (!changed) return
      // Only flip if the user is still looking at this tab in default
      // mode — don't stomp explicit `f`/`d` toggles.
      setState((s) => {
        const cur = activeTab(s)
        if (!cur || cur.path !== relPath) return s
        if (cur.mode !== "file") return s
        return setActiveMode(s, "diff")
      })
    })
  }

  function closePath(relPath: string): void {
    if (!relPath) return
    setState((s) => closeTab(s, relPath))
  }

  // Expose the imperative API to the parent on mount. The brief allows a
  // ref-like callback rather than a forwardRef — simpler in Solid where
  // refs aren't first-class for non-renderable shapes.
  onMount(() => {
    props.onOpen?.({ open: openPath, close: closePath })
  })

  const tabs = createMemo<readonly PreviewTab[]>(() => state().tabs)
  const active = createMemo<PreviewTab | undefined>(() => activeTab(state()))

  /**
   * Re-fetch content whenever the active tab path or mode changes. We
   * track `(path, mode)` explicitly so changing scroll or other tab
   * fields doesn't trigger a refetch.
   */
  createEffect(
    on(
      () => {
        const cur = active()
        if (!cur) return null
        return { path: cur.path, mode: cur.mode }
      },
      async (key) => {
        if (!key) {
          setContent({ kind: "empty" })
          return
        }
        const wt = props.worktreePath()
        if (!wt) {
          setContent({ kind: "error", message: "no active worktree" })
          return
        }
        setContent({ kind: "loading" })
        if (key.mode === "diff") {
          const base = props.diffBase()
          if (!base) {
            setContent({ kind: "error", message: "no diff base configured" })
            return
          }
          const r = await readDiff(wt, base, key.path)
          if (!r.ok) {
            setContent({ kind: "error", message: r.error })
            return
          }
          setContent({ kind: "lines", lines: splitLines(r.text), mode: "diff" })
          return
        }
        const r = await readFile(wt, key.path)
        if (!r.ok) {
          setContent({ kind: "error", message: r.error })
          return
        }
        setContent({ kind: "lines", lines: splitLines(r.text), mode: "file" })
      },
    ),
  )

  // Whenever the active tab changes, restore its persisted scroll
  // position. The component owns the actual scrolling; the state just
  // remembers where each tab was.
  createEffect(
    on(
      () => active()?.path,
      () => {
        const cur = active()
        scroll?.scrollTo(cur?.scrollTop ?? 0)
      },
    ),
  )

  // Pane-local key bindings.
  usePreviewBindings({
    focused: focusedAccessor,
    setMode: (mode) => setState((s) => setActiveMode(s, mode)),
    cycleTab: (delta) => setState((s) => moveActive(s, delta)),
    closeActive: () => {
      const cur = active()
      if (!cur) return
      setState((s) => closeTab(s, cur.path))
    },
    scrollBy: (delta) => {
      const cur = scroll
      if (!cur) return
      cur.scrollBy(delta)
      setState((s) => setActiveScroll(s, Math.max(0, (active()?.scrollTop ?? 0) + delta)))
    },
    scrollToTop: () => {
      scroll?.scrollTo(0)
      setState((s) => setActiveScroll(s, 0))
    },
    scrollToBottom: () => {
      // opentui's scrollbox doesn't expose a content-height accessor
      // on every renderer, but a very large scrollTo clamps internally.
      // 1e9 is well above any realistic file's line count.
      scroll?.scrollTo(1e9)
    },
    pageSize: () => BODY_HEIGHT,
  })

  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={theme.background} paddingLeft={1} paddingRight={1}>
      <Header active={active} />
      <TabBar tabs={tabs} active={active} setState={setState} />
      <Body
        content={content}
        refSet={(r) => {
          scroll = r
        }}
      />
    </box>
  )
}

/* --------------------------------------------------------------------- */
/*  Header — shows active file path + mode badge                          */
/* --------------------------------------------------------------------- */

function Header(props: { active: Accessor<PreviewTab | undefined> }) {
  const { theme } = useTheme()
  // Read derived strings directly from memoized accessors — `<Show>` with
  // a function child is reactive but only over its truthy-transition, not
  // over per-field updates. We want the header label to refresh whenever
  // `mode` flips, not just when the active tab changes from undefined to
  // defined. Direct accessors keep the dependency graph trivial.
  const label = () => {
    const a = props.active()
    if (!a) return ""
    return `${a.path}`
  }
  const mode = () => props.active()?.mode ?? ""
  const hasActive = () => Boolean(props.active())
  return (
    <box flexDirection="row" justifyContent="space-between" paddingTop={1} paddingBottom={0} flexShrink={0}>
      <Show when={hasActive()} fallback={<text fg={theme.textMuted}>preview</text>}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {label()} <span style={{ fg: theme.textMuted }}>· {mode()}</span>
        </text>
      </Show>
      <text fg={theme.textMuted} wrapMode="none">
        f file · d diff · ctrl+w close · tab next
      </text>
    </box>
  )
}

/* --------------------------------------------------------------------- */
/*  Tab bar — one chip per open file                                      */
/* --------------------------------------------------------------------- */

function TabBar(props: {
  tabs: Accessor<readonly PreviewTab[]>
  active: Accessor<PreviewTab | undefined>
  setState: (updater: (s: PreviewState) => PreviewState) => void
}) {
  const { theme } = useTheme()
  return (
    <Show when={props.tabs().length > 0}>
      <box flexDirection="row" gap={1} flexShrink={0} paddingTop={0} paddingBottom={1}>
        <For each={props.tabs()}>
          {(tab) => {
            const isActive = () => props.active()?.path === tab.path
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isActive() ? theme.primary : theme.backgroundElement}
                onMouseUp={() => {
                  // Click on the tab body activates it. Click on the
                  // `x` glyph fires its own handler below and stops
                  // propagation by closing first.
                  props.setState((s) => openTab(s, tab.path, tab.mode))
                }}
              >
                <text
                  fg={isActive() ? theme.selectedListItemText : theme.text}
                  attributes={isActive() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {tabLabel(tab)}
                </text>
                <text
                  fg={isActive() ? theme.selectedListItemText : theme.textMuted}
                  onMouseUp={() => {
                    // Close the tab. The setState callback runs after
                    // the parent's onMouseUp; call it asynchronously
                    // via microtask so the click on the x doesn't
                    // first activate the tab via the parent handler.
                    queueMicrotask(() => props.setState((s) => closeTab(s, tab.path)))
                  }}
                >
                  x
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

/* --------------------------------------------------------------------- */
/*  Body — scrollable rendered output                                     */
/* --------------------------------------------------------------------- */

function Body(props: { content: Accessor<ContentState>; refSet: (r: ScrollBoxRenderable) => void }) {
  const { theme } = useTheme()

  // Solid `<Switch>` re-runs only when the discriminator changes — exactly
  // what we want here. The IIFE pattern would have captured `content()` at
  // first render and never re-evaluated, so swapping File ↔ Diff modes
  // wouldn't surface in the rendered subtree. Each branch reads `content()`
  // again to access the variant-specific fields reactively.
  const kind = createMemo(() => props.content().kind)

  return (
    <box flexGrow={1} minWidth={0}>
      <Switch>
        <Match when={kind() === "empty"}>
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>Open a file from the tree (enter).</text>
          </box>
        </Match>
        <Match when={kind() === "loading"}>
          <box paddingTop={1} paddingLeft={1}>
            <text fg={theme.textMuted}>loading…</text>
          </box>
        </Match>
        <Match when={kind() === "error"}>
          <ErrorBody content={props.content} />
        </Match>
        <Match when={kind() === "lines"}>
          <LinesBody content={props.content} refSet={props.refSet} />
        </Match>
      </Switch>
    </box>
  )
}

function ErrorBody(props: { content: Accessor<ContentState> }) {
  const { theme } = useTheme()
  const message = () => {
    const c = props.content()
    return c.kind === "error" ? c.message : ""
  }
  return (
    <box paddingTop={1} paddingLeft={1}>
      <text fg={theme.error}>error: {message()}</text>
    </box>
  )
}

function LinesBody(props: { content: Accessor<ContentState>; refSet: (r: ScrollBoxRenderable) => void }) {
  const { theme } = useTheme()
  const linesData = createMemo(() => {
    const c = props.content()
    if (c.kind !== "lines") return { lines: [] as string[], mode: "file" as PreviewMode }
    return { lines: c.lines, mode: c.mode }
  })
  const lines = createMemo(() => linesData().lines)
  const mode = createMemo(() => linesData().mode)
  const isEmpty = createMemo(() => mode() === "diff" && lines().length === 0)

  return (
    <Show
      when={!isEmpty()}
      fallback={
        <box paddingTop={1} paddingLeft={1}>
          <text fg={theme.textMuted}>No diff content (file matches base).</text>
        </box>
      }
    >
      <scrollbox
        ref={props.refSet}
        height={BODY_HEIGHT}
        backgroundColor={theme.backgroundPanel}
        scrollbarOptions={{ visible: true }}
      >
        <For each={lines()}>
          {(line) => (
            <Show when={mode() === "diff"} fallback={<FileLine text={line} />}>
              <DiffLine text={line} />
            </Show>
          )}
        </For>
      </scrollbox>
    </Show>
  )
}
