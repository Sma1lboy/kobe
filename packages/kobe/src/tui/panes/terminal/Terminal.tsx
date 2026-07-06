import { type BoxRenderable, StyledText, type TextRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { type Accessor, type JSXElement, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"
import { t } from "../../i18n"
import { useDialog } from "../../ui/dialog"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useTerminalBindings } from "./keys"
import type { CursorPos, TaskPty, TerminalRow } from "./pty"
import { type PtyRegistry, getDefaultPtyRegistry } from "./registry"
import { rowsToStyledText } from "./sgr-to-text-chunk"
import { isShellMissing, overlayCursor } from "./terminal-render"
import { computeViewport, viewportCursor } from "./viewport"

export type TerminalProps = {
  cwd: Accessor<string | null>
  taskId: Accessor<string | null>
  focused?: Accessor<boolean>
  command?: readonly string[]
  onExit?: () => void
  resetToken?: Accessor<number>
  registry?: PtyRegistry
}

export function Terminal(props: TerminalProps): JSXElement {
  const { theme } = useTheme()
  const registry = () => props.registry ?? getDefaultPtyRegistry()

  const [focusedLocal, setFocusedLocal] = createSignal(false)
  const focused = () => props.focused?.() ?? focusedLocal()

  const [pty, setPty] = createSignal<TaskPty | null>(null)

  const [acquireError, setAcquireError] = createSignal<string | null>(null)

  const [snapshot, setSnapshot] = createSignal<readonly TerminalRow[]>([])

  const [cursor, setCursor] = createSignal<CursorPos | null>(null)

  const [exited, setExited] = createSignal(false)

  const [scrollOffset, setScrollOffset] = createSignal(0)

  const [bodyRef, setBodyRef] = createSignal<BoxRenderable | null>(null)
  const [bodyRows, setBodyRows] = createSignal(4)
  const [bodyGeometry, setBodyGeometry] = createSignal<{ cols: number; rows: number } | null>(null)
  const bodyGeometryReady = createMemo(() => bodyGeometry() !== null)

  createEffect(
    on([props.cwd, props.taskId, bodyGeometryReady], ([cwd, taskId, geometryReady]) => {
      if (!cwd || !taskId || !geometryReady) {
        setPty(null)
        setSnapshot([])
        setCursor(null)
        setAcquireError(null)
        return
      }
      const geometry = bodyGeometry()
      if (!geometry) return
      const reg = registry()
      let handle: TaskPty
      try {
        handle = reg.acquire(taskId, cwd, { ...geometry, command: props.command })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setAcquireError(message)
        setPty(null)
        setSnapshot([])
        setCursor(null)
        return
      }
      setAcquireError(null)
      setPty(handle)
      setScrollOffset(0)
    }),
  )

  createEffect(() => {
    const handle = pty()
    const killed = handle ? handle.killed : false
    setExited(killed)
    if (!handle) return
    if (killed) {
      props.onExit?.()
      return
    }
    const unsubscribeExit = handle.onExit(() => {
      setExited(true)
      props.onExit?.()
    })
    onCleanup(() => unsubscribeExit())
    const unsubscribe = handle.onData((snap, c) => {
      setSnapshot(snap)
      setCursor(c)
    })
    try {
      const initial = handle.capture()
      if (initial.length > 0) setSnapshot(initial)
      setCursor(handle.captureCursor())
    } catch {}
    onCleanup(() => {
      unsubscribe()
    })
  })

  onCleanup(() => {
    setPty(null)
  })

  const forceReacquire = (cwd: string, taskId: string, geometry: { cols: number; rows: number }): void => {
    try {
      const fresh = registry().reset(taskId, cwd, { ...geometry, command: props.command })
      setPty(fresh)
      setSnapshot([])
      setCursor(null)
      setScrollOffset(0)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setAcquireError(message)
    }
  }

  createEffect(
    on(
      () => props.resetToken?.(),
      () => {
        const cwd = props.cwd()
        const taskId = props.taskId()
        const geometry = bodyGeometry()
        if (cwd && taskId && geometry) forceReacquire(cwd, taskId, geometry)
      },
      { defer: true },
    ),
  )

  const dialog = useDialog()
  const requestReset = (): void => {
    const handle = pty()
    if (!handle) return
    const cwd = props.cwd()
    const taskId = props.taskId()
    const geometry = bodyGeometry()
    if (!cwd || !taskId || !geometry) return
    const cwdAtClick = cwd
    const taskIdAtClick = taskId
    const geometryAtClick = geometry
    void DialogConfirm.show(dialog, t("terminal.reset.title"), t("terminal.reset.body"), "cancel").then((ok) => {
      if (ok !== true) return
      if (props.taskId() !== taskIdAtClick || props.cwd() !== cwdAtClick) return
      forceReacquire(cwdAtClick, taskIdAtClick, geometryAtClick)
    })
  }

  useTerminalBindings({
    focused,
    write: (data) => {
      const handle = pty()
      if (!handle || handle.killed) return
      handle.write(data)
    },
    paste: (text) => {
      const handle = pty()
      if (!handle || handle.killed) return
      handle.paste(text)
    },
    scroll: (lines) => {
      setScrollOffset((cur) => Math.max(0, cur - lines))
    },
    reset: requestReset,
  })

  const parsedRows = snapshot

  const visibleRange = createMemo(() => computeViewport(parsedRows().length, bodyRows(), scrollOffset()))

  const visibleRows = createMemo(() => {
    const all = parsedRows()
    const range = visibleRange()
    return all.slice(range.start, range.end)
  })

  const visibleCursor = createMemo(() => viewportCursor(cursor(), scrollOffset(), visibleRange()))

  const cursorRows = createMemo(() => {
    const c = focused() ? visibleCursor() : null
    return overlayCursor(visibleRows(), c)
  })

  const styledSnapshot = createMemo(() => new StyledText(rowsToStyledText(cursorRows())))
  const [snapshotTextRef, setSnapshotTextRef] = createSignal<TextRenderable | null>(null)
  createEffect(() => {
    const ref = snapshotTextRef()
    if (ref) ref.content = styledSnapshot()
  })

  const renderer = useRenderer()
  const dims = useTerminalDimensions()

  const [geomTick, setGeomTick] = createSignal(0)
  const bumpGeomTick = (): void => {
    setGeomTick((n) => (n + 1) & 0xff)
  }

  let lastResize: { cols: number; rows: number } | null = null

  createEffect(() => {
    const ref = bodyRef()
    dims()
    geomTick()
    if (!ref) return
    if (ref.width <= 0 || ref.height <= 0) return
    const cols = Math.max(20, ref.width)
    const rows = Math.max(4, ref.height)
    setBodyRows(rows)
    setBodyGeometry((cur) => (cur && cur.cols === cols && cur.rows === rows ? cur : { cols, rows }))
  })

  createEffect(() => {
    const handle = pty()
    const geometry = bodyGeometry()
    if (!handle || !geometry) return
    const { cols, rows } = geometry
    if (lastResize && lastResize.cols === cols && lastResize.rows === rows) return
    lastResize = { cols, rows }
    try {
      handle.resize(cols, rows)
    } catch {}
  })

  createEffect(() => {
    if (!focused()) return
    renderer.setCursorPosition(0, 0, false)
  })

  onCleanup(() => {
    try {
      renderer.setCursorPosition(0, 0, false)
    } catch {}
  })

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      overflow="hidden"
      backgroundColor={theme.background}
      onMouseUp={() => setFocusedLocal(true)}
    >
      {}
      <Show when={exited()}>
        <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
          <text fg={theme.error} wrapMode="none">
            {t("terminal.exited")}
          </text>
        </box>
      </Show>
      <Show when={scrollOffset() > 0}>
        <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
          <text fg={theme.warning} wrapMode="none">
            {t("terminal.scrolledBack", { lines: scrollOffset() })}
          </text>
        </box>
      </Show>

      <box
        ref={(r: BoxRenderable) => {
          setBodyRef(r)
        }}
        onSizeChange={bumpGeomTick}
        flexGrow={1}
        overflow="hidden"
      >
        {}
        <Show
          when={pty()}
          fallback={
            <box paddingLeft={1} paddingTop={1} flexDirection="column" gap={0}>
              <Show when={acquireError()} fallback={<text fg={theme.textMuted}>{t("terminal.noTask")}</text>}>
                <text fg={theme.error} wrapMode="word">
                  {isShellMissing(acquireError() ?? "")
                    ? t("terminal.unavailable.shellMissing")
                    : t("terminal.unavailable.spawnFailed")}
                </text>
                <text fg={theme.textMuted} wrapMode="word">
                  {acquireError()}
                </text>
              </Show>
            </box>
          }
        >
          {}
          <text
            fg={theme.text}
            wrapMode="none"
            ref={(r: TextRenderable) => {
              setSnapshotTextRef(r)
            }}
          />
        </Show>
      </box>
    </box>
  )
}
