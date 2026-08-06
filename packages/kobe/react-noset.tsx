/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { useEffect } from "react"
function App() {
  useEffect(() => {
    const t = setInterval(() => {
      /* fires, but no setState */
    }, 500)
    return () => clearInterval(t)
  }, [])
  return (
    <box flexGrow={1}>
      <text content="react, interval but no setState" />
    </box>
  )
}
Bun.write("/tmp/noset.pid", String(process.pid))
const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<App />)
