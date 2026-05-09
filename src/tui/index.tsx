/**
 * kobe TUI bootstrap.
 *
 * Phase 0.1: render a single bordered box titled "kobe — booting".
 * No state, no panes, no focus management. The point is to prove the
 * @opentui/solid render pipeline works under Bun.
 *
 * See `refs/opencode/packages/opencode/src/cli/cmd/tui/app.tsx` for the
 * full pattern (createCliRenderer + provider stack); we deliberately
 * skip all of that for the bootstrap milestone.
 */
import { render } from "@opentui/solid"

function App() {
  return (
    <box title="kobe — booting" border flexGrow={1} padding={1}>
      <text>Phase 0.1 scaffold. Press Ctrl+C to exit.</text>
    </box>
  )
}

export async function startTui(): Promise<void> {
  await render(() => <App />)
}
