/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
function App() {
  return (
    <box flexGrow={1}>
      <text content="idle react, no updates" />
    </box>
  )
}
Bun.write("/tmp/reactidle.pid", String(process.pid))
const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<App />)
setInterval(() => {}, 60000)
