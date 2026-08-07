import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core"
const renderer = await createCliRenderer({ exitOnCtrlC: true })
const box = new BoxRenderable(renderer, { id: "b", flexGrow: 1 })
renderer.root.add(box)
Bun.write("/tmp/textprobe.pid", String(process.pid))
// Mimic what the react reconciler does per update: create + destroy a
// TextRenderable child rather than mutating content in place.
let i = 0
const timer = setInterval(() => {
  i++
  const t = new TextRenderable(renderer, { id: `t${i}`, content: `row ${i} ${"x".repeat(60)}` })
  box.add(t)
  const prev = box.getChildren()[0]
  if (box.getChildren().length > 1 && prev) {
    box.remove(prev)
    prev.destroy?.()
  }
  renderer.requestRender()
  if (i >= 200000) {
    clearInterval(timer)
    process.exit(0)
  }
}, 4)
