/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { useEffect, useRef } from "react"
function App() {
  const ref = useRef<any>(null)
  useEffect(() => {
    let n = 0
    const t = setInterval(() => {
      n++
      if (ref.current) ref.current.content = `tick ${n}`
    }, 100)
    return () => clearInterval(t)
  }, [])
  return (
    <box flexGrow={1}>
      <text ref={ref} content="tick 0" />
    </box>
  )
}
const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<App />)
