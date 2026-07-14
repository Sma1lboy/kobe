# quicklook replay

The `quicklook-replay` Remotion composition renders the checked-in terminal
capture at `src/quicklook/frames.json`. Regenerate it through the real PureTUI
Workspace Host and Hosted PTY runtime from this package:

```bash
bun run capture:puretui --keep-demo-root
bun run studio
bun x remotion render src/index.ts quicklook-replay out/quicklook-replay.mp4
bun x remotion render src/index.ts quicklook-replay-4x out/quicklook-replay-4x.mp4
```

The storyboard is `src/quicklook/quicklook.replay.json`. Its
`setup.fixtureEngines` option uses deterministic capture-only Claude and Codex
processes inside real Hosted PTY sessions, so Brand Studio capture does not
depend on a developer's credentials or profile. Every run creates an isolated
Kobe home and fixture repository; the CLI prints the retained root for review.

Camera and framing logic lives in `src/quicklook/QuickLookReplay.tsx`; ANSI
parsing lives in `src/quicklook/ansi.ts`.
