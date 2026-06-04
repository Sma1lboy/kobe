# kobe-web

Local browser dashboard for kobe.

The development server runs three cooperating processes:

- Vite SPA on `:5173`
- kobe daemon web transport on `:5174`
- node-pty terminal server on `:5175`

Run it from this package:

```bash
bun run dev
```

Open `http://localhost:5173`.

The browser UI is local-first:

- left rail mirrors live tasks from the kobe daemon
- center workspace owns client-side tabs persisted in localStorage
- vendor tabs run an independent engine PTY per tab
- terminal tabs run a shell in the selected task worktree
- file preview tabs open from the right Changes rail
- notes persist through daemon web under the kobe state directory

The PTY server runs under Node because `node-pty` does not deliver data
correctly under Bun. The web transport is daemon-owned; the Bun sidecar only
asks the daemon to bind local HTTP/SSE routes during browser development.
