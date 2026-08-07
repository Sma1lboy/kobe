Bun.write("/tmp/mt.pid", String(process.pid))
let i = 0
setInterval(() => {
  for (let k = 0; k < 250; k++) {
    i++
    queueMicrotask(() => {
      const x = i * 2
      if (x < 0) console.log(x)
    })
  }
}, 500)
