import { Show, createResource } from "solid-js"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { filetypeOf, loadPreviewData } from "./preview-core"
import { buildSyntaxStyle } from "./preview-syntax"

export interface OpsPreviewArgs {
  readonly worktree: string
  readonly relPath: string
}

function PreviewScreen(props: OpsPreviewArgs) {
  const { theme } = useTheme()
  const style = buildSyntaxStyle(theme)
  const filetype = filetypeOf(props.relPath)

  const [data] = createResource(
    () => props.relPath,
    (rel) => loadPreviewData(props.worktree, rel),
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
  await bootPaneHost({
    providers: { kv: false, focus: false },
    setup: () => ({ root: () => <PreviewScreen {...args} /> }),
  })
}
