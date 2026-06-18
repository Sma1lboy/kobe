console.error(
  "kobe-web/server is no longer a standalone runtime. Use `bun run dev`; web HTTP/SSE routes are served by `kobe daemon`.",
)
process.exit(1)
