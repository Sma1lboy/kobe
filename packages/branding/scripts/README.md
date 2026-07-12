# quicklook replay

The `quicklook-replay` Remotion composition renders the checked-in terminal
capture at `src/quicklook/frames.json`. The former live capture driver was
removed with kobe's retired session backend; rendering the existing replay is
still supported:

```bash
bun run studio
bun x remotion render src/index.ts quicklook-replay out/quicklook-replay.mp4
```

Camera and framing logic lives in `src/quicklook/QuickLookReplay.tsx`; ANSI
parsing lives in `src/quicklook/ansi.ts`.
