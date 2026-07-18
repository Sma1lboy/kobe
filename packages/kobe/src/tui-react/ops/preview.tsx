/** @jsxImportSource @opentui/react */
/**
 * React `kobe ops --preview <rel>` — the `src/tui/ops/preview.tsx`
 * counterpart (issue #15, G3). React is the default runtime since
 * 2026-07-07 (`uiFramework()` in `src/env.ts`); `KOBE_SOLID=1` is the
 * legacy escape hatch. Data + syntax-style
 * mapping are the shared `tui/ops/preview-core.ts` / `preview-syntax.ts`.
 * The Solid host's single `createResource` follows THE ASYNC CANON
 * (`src/tui-react/history/host.tsx`): `useState` + a dependency-keyed
 * `useEffect` whose stale completions are dropped by an effect-local
 * `disposed` flag. The read is one-shot (the preview window is immutable
 * for its lifetime), so there's no refresh tick.
 */

import { useEffect, useMemo, useState } from "react"
import { execHostForWorktreePath } from "../../exec/resolve"
import { openWithSystemViewer } from "../../lib/open-external"
import { type PreviewData, filetypeOf, formatBytes, loadPreviewData } from "../../tui/ops/preview-core"
import { buildSyntaxStyle } from "../../tui/ops/preview-syntax"
import { worktreeFilePath } from "../../worktree/content"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { pageCloseBindings, useBindings } from "../lib/keymap"

export interface OpsPreviewArgs {
  readonly worktree: string
  readonly relPath: string
  /** Base ref for the vs-base (Branch scope) diff; omitted = diff vs HEAD. */
  readonly base?: string
  /**
   * How q/escape/ctrl+c close the preview. The standalone `kobe ops
   * --preview` entrypoint passes `() => process.exit(0)` (the whole process
   * IS the preview); the in-workspace content tab passes a real closer that
   * removes the tab — same `onClose` seam as `UpdatePage`, so the shared
   * component never hard-exits when it's just one tab in a live TUI.
   */
  readonly onClose?: () => void
  /** Whether this preview has keyboard focus — gates its close chords when
   *  hosted as a tab (a standalone process is always focused). */
  readonly focused?: boolean
}

export function PreviewScreen(props: OpsPreviewArgs) {
  const { theme } = useTheme()
  const t = useT()
  const style = useMemo(() => buildSyntaxStyle(theme), [theme])
  const filetype = filetypeOf(props.relPath)

  const [data, setData] = useState<PreviewData | null>(null)
  const base = props.base
  useEffect(() => {
    let disposed = false
    void loadPreviewData(props.worktree, props.relPath, base ? { base } : undefined)
      .then((d) => {
        if (!disposed) setData(d)
      })
      .catch(() => {
        // Same boundary as the Solid resource: a failed read (worktree torn
        // down mid-open) leaves the loading placeholder rather than crashing.
      })
    return () => {
      disposed = true
    }
  }, [props.worktree, props.relPath, base])

  // System-open (`o`) only makes sense for a LOCAL worktree — the file the
  // OS viewer would open doesn't exist on this machine for a remote one.
  const canSystemOpen = data?.kind === "binary" && !execHostForWorktreePath(props.worktree).isRemote

  const onClose = props.onClose ?? (() => process.exit(0))
  useBindings(() => ({
    enabled: props.focused ?? true,
    // `o` registers only while the binary card is showing (and local), so it
    // never shadows anything else the rest of the time.
    bindings: [
      ...pageCloseBindings(onClose),
      ...(canSystemOpen
        ? [
            {
              key: "o",
              cmd: () => {
                const abs = worktreeFilePath(props.worktree, props.relPath)
                if (abs) openWithSystemViewer(abs)
              },
            },
          ]
        : []),
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme.accent}>{props.relPath}</text>
        <text fg={theme.textMuted}>
          {data?.kind === "diff"
            ? base
              ? t("ops.preview.diffVsBase", { base })
              : t("ops.preview.diffVsHead")
            : data?.kind === "binary"
              ? t(data.image ? "ops.preview.image" : "ops.preview.binary")
              : t("ops.preview.file")}
        </text>
        <text fg={theme.textMuted}>{t("ops.preview.closeHint")}</text>
      </box>
      <box flexGrow={1}>
        {data == null ? (
          <text fg={theme.textMuted}>{t("ops.preview.loading")}</text>
        ) : data.kind === "binary" ? (
          // No portable inline-image path in the terminal (see lib/open-external)
          // — a metadata card + hand-off to the system viewer instead of mojibake.
          <box flexDirection="column" paddingLeft={1} paddingTop={1} gap={1}>
            <text fg={theme.text}>
              {t(data.image ? "ops.preview.image" : "ops.preview.binary")}
              {data.sizeBytes != null ? ` · ${formatBytes(data.sizeBytes)}` : ""}
            </text>
            <text fg={theme.textMuted}>
              {canSystemOpen ? t("ops.preview.openHint") : t("ops.preview.noTextPreview")}
            </text>
          </box>
        ) : data.kind === "diff" ? (
          <diff diff={data.text} view="unified" filetype={filetype} syntaxStyle={style} showLineNumbers={true} />
        ) : (
          <code content={data.text} filetype={filetype} syntaxStyle={style} />
        )}
      </box>
    </box>
  )
}

export async function startOpsPreview(args: OpsPreviewArgs): Promise<void> {
  // Same minimal provider set as the Ops pane host (and same
  // no-log-context delta as the Solid preview entrypoint — preserved).
  await bootPaneHost({
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <PreviewScreen {...args} /> }),
  })
}
