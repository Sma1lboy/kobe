import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core"
const renderer = await createCliRenderer({ exitOnCtrlC: true })
const box = new BoxRenderable(renderer, { id: "b", flexGrow: 1 })
renderer.root.add(box)
const t = new TextRenderable(renderer, { id: "t", content: "frame probe" })
box.add(t)
Bun.write("/tmp/frameprobe.pid", String(process.pid))
let i = 0
setInterval(() => {
  i++
  t.content = `row ${i} ${"x".repeat(60)}`
  renderer.requestRender()
}, 40)
