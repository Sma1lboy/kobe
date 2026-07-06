/** @jsxImportSource @opentui/react */
/**
 * G1 React runtime pilot for issue #15.
 *
 * This entry is deliberately NOT wired into the CLI entry or compile graph yet.
 * It proves @opentui/react can run beside the existing Solid TUI without
 * sharing imports, providers, or theme context.
 */

import { TextAttributes, createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"

const palette = {
  background: "#0b0f14",
  surface: "#18212b",
  tag: "#7dd3fc",
  title: "#e5eef7",
  muted: "#9aa8b5",
  body: "#c8d3dd",
}

function exitCleanly(renderer: ReturnType<typeof useRenderer>): void {
  try {
    renderer?.destroy()
  } catch (err) {
    console.error("kobe react mock: renderer.destroy() failed:", err)
  }
  process.exit(0)
}

function ReactMockPane() {
  const renderer = useRenderer()
  const dims = useTerminalDimensions()

  useKeyboard((evt) => {
    if (evt.name === "q") exitCleanly(renderer)
  })

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={palette.background}>
      <box
        flexDirection="row"
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        backgroundColor={palette.surface}
      >
        <text fg={palette.tag} attributes={TextAttributes.BOLD} wrapMode="none">
          REACT
        </text>
        <text fg={palette.title} attributes={TextAttributes.BOLD} wrapMode="none">
          kobe mock pane
        </text>
        <box flexGrow={1} />
        <text fg={palette.muted} wrapMode="none">
          q exits
        </text>
      </box>
      <box paddingLeft={1} paddingRight={1} paddingTop={1} flexGrow={1}>
        <text fg={palette.body} wrapMode="word">
          React 19.2 + @opentui/react 0.4.3 are isolated under src/tui-react ({dims.width}x{dims.height}).
        </text>
      </box>
    </box>
  )
}

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<ReactMockPane />)
