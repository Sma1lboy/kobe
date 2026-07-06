/**
 * SUPERSEDED. The browser HTTP/SSE surface is daemon-owned now: `kobe web`
 * asks the daemon to bind those routes, and Vite proxies /api + /events to
 * that port in dev. Keeping this stub records why we do not run the daemon
 * graph inside Vite's plugin loader.
 *
 * Kept as a stub for now because older notes referenced this filename.
 */
export {}
