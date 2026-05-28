/**
 * `kobe ops` host — the Ops pane on the right side of a task's tmux
 * session (v0.6 / KOB-233).
 *
 * Reuses the v0.5 modules instead of a bespoke watcher:
 *   - `FileTree` — browse the worktree (All / Changes tabs, j/k nav).
 *   - A slim file viewer (this file) built on the v0.5 `diff.ts`
 *     helpers — view a file's content or its diff vs HEAD. We do NOT
 *     pull in the full v0.5 Preview pane (image/sixel/GIF/SVG/XML
 *     machinery) — far too heavy for a narrow ops pane.
 *
 * Flow:
 *   tree  --enter-->  file viewer  --q/esc-->  tree
 *   in the file viewer: `tab` toggles Content ↔ Diff, `j/k` scroll,
 *   `m` injects `@<path>` into the claude pane.
 *
 * Runs in its own OS process inside the tmux pane (separate opentui
 * render loop from the outer kobe TUI). It can't share the outer TUI's
 * Solid runtime, but it DOES inherit the user's theme: we read the
 * same `~/.config/kobe/state.json` the outer app persists (read-only —
 * writing would race the main process).
 */

import { render } from "@opentui/solid"
import { type Accessor, For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { kvStatePath } from "../../env.ts"
import { FOCUS_ACCENT_SLOTS, type FocusAccentSlot, ThemeProvider, addTheme, hasTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { useBindings } from "../lib/keymap"
import { FileTree } from "../panes/filetree"
import { DialogProvider } from "../ui/dialog"
import { readDiff, readFile, splitLines } from "./diff"

const FALLBACK_THEME = "claude"
const SOCKET = "kobe"

export interface OpsHostArgs {
  readonly taskId: string
  readonly worktree: string
  /** tmux pane id / selector for the claude pane — send-keys target. */
  readonly targetPane: string | null
}

interface ThemePrefs {
  readonly theme: string
  readonly transparent: boolean
  readonly focusAccent: FocusAccentSlot | null
}

/**
 * Read the theme prefs the outer kobe app persisted. Read-only and
 * sync — we only need them once at mount, and writing back would race
 * the main process for `state.json`.
 */
function readThemePrefs(): ThemePrefs {
  try {
    const text = require("node:fs").readFileSync(kvStatePath(), "utf8")
    const parsed = JSON.parse(text) as Record<string, unknown>
    const theme =
      typeof parsed.activeTheme === "string" && hasTheme(parsed.activeTheme) ? parsed.activeTheme : FALLBACK_THEME
    const transparent = parsed.transparentBackground === true
    const focusAccent =
      typeof parsed.focusAccent === "string" && (FOCUS_ACCENT_SLOTS as readonly string[]).includes(parsed.focusAccent)
        ? (parsed.focusAccent as FocusAccentSlot)
        : null
    return { theme, transparent, focusAccent }
  } catch {
    return { theme: FALLBACK_THEME, transparent: false, focusAccent: null }
  }
}

type View = "tree" | "file"
type FileMode = "content" | "diff"

function OpsShell(props: OpsHostArgs & { prefs: ThemePrefs }) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const [view, setView] = createSignal<View>("tree")
  const [openPath, setOpenPath] = createSignal<string | null>(null)

  // Apply the inherited transparent-bg + focus-accent prefs once the
  // theme context is live (the active theme name is set via the
  // ThemeProvider's initial prop, no flash).
  onMount(() => {
    themeCtx.setTransparentBackground(props.prefs.transparent)
    if (props.prefs.focusAccent) themeCtx.setFocusAccent(props.prefs.focusAccent)
  })

  function openFile(rel: string): void {
    setOpenPath(rel)
    setView("file")
  }
  function backToTree(): void {
    setView("tree")
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <Show
        when={view() === "file" && openPath()}
        fallback={
          <FileTree worktreePath={() => props.worktree} focused={() => view() === "tree"} onOpenFile={openFile} />
        }
      >
        {(path) => (
          <FilePreview
            worktree={props.worktree}
            relPath={path()}
            targetPane={props.targetPane}
            focused={() => view() === "file"}
            onBack={backToTree}
          />
        )}
      </Show>
    </box>
  )
}

function FilePreview(props: {
  worktree: string
  relPath: string
  targetPane: string | null
  focused: Accessor<boolean>
  onBack: () => void
}) {
  const { theme } = useTheme()
  const [mode, setMode] = createSignal<FileMode>("content")
  const [scroll, setScroll] = createSignal(0)

  const [content] = createResource(
    () => [props.relPath, mode()] as const,
    async ([rel, m]) => {
      const res = m === "diff" ? await readDiff(props.worktree, "HEAD", rel) : await readFile(props.worktree, rel)
      if (!res.ok) return { lines: [`error: ${res.error}`], error: true }
      return { lines: splitLines(res.text), error: false }
    },
  )

  const lines = createMemo(() => content()?.lines ?? ["loading…"])
  // Visible window — opentui doesn't give us the pane height cheaply
  // here, so we cap the rendered slice and scroll by line. 200 visible
  // lines is plenty for a narrow ops pane; j/k moves the window.
  const WINDOW = 200
  const visible = createMemo(() => {
    const all = lines()
    const start = Math.min(scroll(), Math.max(0, all.length - 1))
    return all.slice(start, start + WINDOW)
  })

  function toggleMode(): void {
    setScroll(0)
    setMode((m) => (m === "content" ? "diff" : "content"))
  }

  async function mention(): Promise<void> {
    if (!props.targetPane) return
    try {
      await Bun.spawn(["tmux", "-L", SOCKET, "send-keys", "-t", props.targetPane, `@${props.relPath} `], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).exited
    } catch {
      /* best-effort */
    }
  }

  useBindings(() => ({
    enabled: props.focused(),
    bindings: [
      { key: "q", cmd: () => props.onBack() },
      { key: "escape", cmd: () => props.onBack() },
      { key: "tab", cmd: toggleMode },
      { key: "j", cmd: () => setScroll((s) => s + 1) },
      { key: "down", cmd: () => setScroll((s) => s + 1) },
      { key: "k", cmd: () => setScroll((s) => Math.max(0, s - 1)) },
      { key: "up", cmd: () => setScroll((s) => Math.max(0, s - 1)) },
      { key: "ctrl+d", cmd: () => setScroll((s) => s + 20) },
      { key: "ctrl+u", cmd: () => setScroll((s) => Math.max(0, s - 20)) },
      { key: "m", cmd: () => void mention() },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Header: file path + mode tabs + hints. */}
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={mode() === "content" ? theme.accent : theme.textMuted} onMouseUp={() => setMode("content")}>
          Content
        </text>
        <text fg={mode() === "diff" ? theme.accent : theme.textMuted} onMouseUp={() => setMode("diff")}>
          Diff
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {props.relPath}
        </text>
      </box>
      <box flexDirection="row" gap={2} paddingLeft={1} paddingBottom={1}>
        <text fg={theme.textMuted}>q back</text>
        <text fg={theme.textMuted}>tab content/diff</text>
        <text fg={theme.textMuted}>j/k scroll</text>
        <text fg={theme.textMuted}>m mention</text>
      </box>
      {/* Body: line-windowed file / diff content. */}
      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
        <For each={visible()}>
          {(line) => (
            <text fg={lineColor(line, mode(), theme)} wrapMode="none">
              {line.length === 0 ? " " : line}
            </text>
          )}
        </For>
      </box>
    </box>
  )
}

type ThemeColor = ReturnType<typeof useTheme>["theme"]["text"]

function lineColor(line: string, mode: FileMode, theme: ReturnType<typeof useTheme>["theme"]): ThemeColor {
  if (mode !== "diff") return theme.text
  if (line.startsWith("+") && !line.startsWith("+++")) return theme.success
  if (line.startsWith("-") && !line.startsWith("---")) return theme.error
  if (line.startsWith("@@")) return theme.accent
  return theme.textMuted
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
  const prefs = readThemePrefs()
  await render(() => <OpsApp {...args} prefs={prefs} />, {
    backgroundColor: "transparent",
    externalOutputMode: "passthrough",
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    useKittyKeyboard: {},
  })
}
