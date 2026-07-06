/** @jsxImportSource @opentui/react */

import type { AdoptableWorktree } from "@/types/worktree"
import { TextAttributes } from "@opentui/core"
import { useEffect, useRef, useState } from "react"
import { useTheme } from "../context/theme"
import { isLocaleId, setLocaleLang, useLang } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"
import { NewTaskDialog } from "./new-task-dialog"
import { RenameTaskDialog } from "./rename-task-dialog"

const FIXTURE_SAVED_REPOS = ["~/i/alpha", "~/i/beta-service", "/tmp/kobe-mock-repo"] as const

const FIXTURE_ADOPTABLE: readonly AdoptableWorktree[] = [
  {
    path: "/tmp/kobe-mock-repo/.claude/worktrees/feature-a",
    branch: "feature-a",
    head: "aaaaaaaa",
    dirty: false,
    kobeManaged: true,
    lastActivityMs: Date.now(),
  },
  {
    path: "/tmp/kobe-mock-repo/.claude/worktrees/fix-b",
    branch: "fix-b",
    head: "bbbbbbbb",
    dirty: true,
    kobeManaged: false,
    lastActivityMs: Date.now() - 60_000,
  },
]

function MockDialogsScreen() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [lastResult, setLastResult] = useState("(none yet)")

  const lang = useLang()
  const wantLocale = process.env.KOBE_MOCK_LOCALE
  useEffect(() => {
    if (wantLocale && isLocaleId(wantLocale) && lang !== wantLocale) setLocaleLang(wantLocale)
  }, [lang, wantLocale])

  const openNewTask = () => {
    void NewTaskDialog.show(dialog, process.cwd(), [...FIXTURE_SAVED_REPOS], {
      defaultCloneParent: "~/",
      defaultVendor: "claude",
      availableVendors: ["claude", "codex"],
      discoverAdoptable: async () => FIXTURE_ADOPTABLE,
    }).then((r) => setLastResult(r ? JSON.stringify(r) : "(cancelled)"))
  }
  const openRename = () => {
    void RenameTaskDialog.show(dialog, "My mock task").then((r) => setLastResult(r ?? "(cancelled)"))
  }

  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    if (process.env.KOBE_MOCK_DIALOG === "rename") openRename()
    else openNewTask()
  })

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "q", cmd: () => process.exit(0) },
      { key: "ctrl+c", cmd: () => process.exit(0) },
      { key: "n", cmd: openNewTask },
      { key: "r", cmd: openRename },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background} paddingLeft={1} paddingTop={1} gap={1}>
      <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
        REACT task-dialogs mock
      </text>
      <text fg={theme.textMuted} wrapMode="none">
        n new-task · r rename · esc close dialog · q quit
      </text>
      <text fg={theme.text} wrapMode="word">
        last result: {lastResult}
      </text>
    </box>
  )
}

await bootPaneHost({
  logContext: "mock-dialogs",
  setup: () => {
    const locale = process.env.KOBE_MOCK_LOCALE
    if (locale && isLocaleId(locale)) setLocaleLang(locale)
    return { root: () => <MockDialogsScreen /> }
  },
})
