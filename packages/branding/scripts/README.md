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

The storyboard is `src/quicklook/quicklook.replay.json`. Capture always launches
the installed Claude and Codex binaries from the inherited `PATH`; there is no
fixture or engine-mode switch in the replay spec. Kobe state and the fixture
repository remain isolated, while engine subprocesses keep the host's normal
home directory and native Claude/Codex profile. Test-only fixtures are injected
by the opt-in end-to-end test itself and cannot be selected by a production
replay. The CLI prints the retained demo root for review.

Camera and framing logic lives in `src/quicklook/QuickLookReplay.tsx`; ANSI
parsing lives in `src/quicklook/ansi.ts`.
