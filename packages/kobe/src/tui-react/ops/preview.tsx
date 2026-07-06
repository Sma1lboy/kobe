/** @jsxImportSource @opentui/react */
/**
 * React `kobe ops --preview <rel>` — the `src/tui/ops/preview.tsx`
 * counterpart (issue #15, G3), behind `KOBE_REACT=1`. Data + syntax-style
 * mapping are the shared `tui/ops/preview-core.ts` / `preview-syntax.ts`.
 * The Solid host's single `createResource` follows THE ASYNC CANON
 * (`src/tui-react/history/host.tsx`): `useState` + a dependency-keyed
 * `useEffect` whose stale completions are dropped by an effect-local
 * `disposed` flag. The read is one-shot (the preview window is immutable
 * for its lifetime), so there's no refresh tick.
 */

import { useEffect, useMemo, useState } from "react"
import { type PreviewData, filetypeOf, loadPreviewData } from "../../tui/ops/preview-core"
import { buildSyntaxStyle } from "../../tui/ops/preview-syntax"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"

export interface OpsPreviewArgs {
  readonly worktree: string
  readonly relPath: string
}

function PreviewScreen(props: OpsPreviewArgs) {
  const { theme } = useTheme()
  const t = useT()
  const style = useMemo(() => buildSyntaxStyle(theme), [theme])
  const filetype = filetypeOf(props.relPath)

  const [data, setData] = useState<PreviewData | null>(null)
  useEffect(() => {
    let disposed = false
    void loadPreviewData(props.worktree, props.relPath)
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
  }, [props.worktree, props.relPath])

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
        <text fg={theme.textMuted}>{data?.kind === "diff" ? t("ops.preview.diffVsHead") : t("ops.preview.file")}</text>
        <text fg={theme.textMuted}>{t("ops.preview.closeHint")}</text>
      </box>
      <box flexGrow={1}>
        {data == null ? (
          <text fg={theme.textMuted}>{t("ops.preview.loading")}</text>
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
