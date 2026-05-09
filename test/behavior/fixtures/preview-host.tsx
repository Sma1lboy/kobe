/**
 * Preview-host shell — Stream I behavior fixture.
 *
 * When `KOBE_PREVIEW_HOST=1`, the CLI entry calls `startPreviewHost()`
 * instead of the normal app. This mounts the preview pane in isolation
 * so the behavior test can drive it with PTY keystrokes without paying
 * the cost of the full kobe shell.
 *
 * Side-channel inputs (env vars, read once at boot):
 *   - `KOBE_PREVIEW_WORKTREE`  — abs path to the fixture worktree (required)
 *   - `KOBE_PREVIEW_DIFF_BASE` — branch/ref to diff against (optional)
 *   - `KOBE_PREVIEW_OPEN_FILE` — repo-relative file to auto-open (optional)
 *
 * The behavior test creates a fixture repo, makes a working-copy edit,
 * spawns this host with the env above, then sends `f`/`d` keys to flip
 * modes and asserts on the captured screen.
 *
 * Theme and providers are minimal: the brief tells us not to touch other
 * panes, so we mount the absolute minimum (ThemeProvider + Preview).
 * The lifted dialog stack / KV / Sync providers are NOT required for
 * the preview pane itself — it consumes only `useTheme()` and
 * `useBindings()`. `useBindings()` itself touches the renderer via
 * `@opentui/solid`'s `useRenderer` hook, which works inside any
 * `render()` call.
 */

import { render } from "@opentui/solid"
import { type Accessor, createSignal } from "solid-js"
import { ThemeProvider, useTheme } from "../../../src/tui/context/theme"
import { Preview, type PreviewApi } from "../../../src/tui/panes/preview"

const DEFAULT_THEME = "tokyonight"

/**
 * Mount the preview pane in host mode. Returns once `render()` resolves;
 * the pane keeps running until the parent process exits the PTY.
 */
export async function startPreviewHost(): Promise<void> {
  const worktree = process.env.KOBE_PREVIEW_WORKTREE ?? null
  const diffBase = process.env.KOBE_PREVIEW_DIFF_BASE ?? null
  const openFile = process.env.KOBE_PREVIEW_OPEN_FILE ?? ""

  await render(() => (
    <ThemeProvider mode="dark" theme={DEFAULT_THEME}>
      <Host worktree={() => worktree} diffBase={() => diffBase} openFile={openFile} />
    </ThemeProvider>
  ))
}

function Host(props: { worktree: Accessor<string | null>; diffBase: Accessor<string | null>; openFile: string }) {
  const { theme } = useTheme()
  const [api, setApi] = createSignal<PreviewApi | null>(null)

  // Once the preview pane gives us its imperative API, fire `open` for
  // the requested fixture file. This emulates the orchestrator → file
  // tree → preview wiring without pulling either of those streams in.
  function onApi(next: PreviewApi): void {
    setApi(next)
    if (props.openFile) {
      next.open(props.openFile)
    }
  }
  // Reference to silence the unused-signal warning; the test doesn't
  // need to read the api out, it just needs the call above to fire.
  void api

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <box paddingLeft={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <text fg={theme.text}>preview-host: {props.openFile || "(no file)"}</text>
      </box>
      <Preview worktreePath={props.worktree} diffBase={props.diffBase} onOpen={onApi} focused={() => true} />
    </box>
  )
}
