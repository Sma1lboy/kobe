# Stable macOS IME Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep macOS IME preedit and candidate UI anchored to the embedded PTY cursor during OpenTUI animation frames.

**Architecture:** A framework-free anchor controller owns the focused terminal's screen coordinate. On macOS fullscreen hosts, an OpenTUI custom-stdout adapter inserts a hidden cursor move immediately before each synchronized-frame terminator; the React terminal separately retains the last valid PTY cursor for this anchor while continuing to hide its visual inverse-cell cursor when the PTY hides its cursor.

**Tech Stack:** TypeScript, React 19, Bun, OpenTUI 0.4.3, Vitest, Bun render tests.

## Global Constraints

- Preserve the inverse-cell visual cursor and OpenTUI 0.4.3 dependency.
- Never patch `node_modules` or write ANSI directly from a React component.
- Apply the output adapter only to macOS fullscreen hosts.
- Keep every touched source file at or below 500 lines.
- Ship one patch changeset.

---

### Task 1: Frame-final IME anchor output

**Files:**
- Create: `packages/kobe/src/tui/lib/ime-anchor-output.ts`
- Create: `packages/kobe/test/tui/ime-anchor-output.test.ts`

**Interfaces:**
- Produces: `ImeAnchorController`, `imeAnchorController`, `createImeAnchoredOutput`, and `installRendererResizeForwarder`.
- Consumes: a terminal-like output stream and an OpenTUI renderer with `resize(width, height)`.

- [ ] **Step 1: Write the failing wire tests**

Cover owner-safe claim/release, an unchanged inactive stream, injection before
`\x1b[?2026l`, every delimiter split point, and resize-listener cleanup. The
wire assertion must require this ordering:

```ts
expect(output).toContain("\x1b[5;7H\x1b[?25l\x1b[?2026l")
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cd packages/kobe
bunx vitest run test/tui/ime-anchor-output.test.ts
```

Expected: FAIL because `tui/lib/ime-anchor-output` does not exist.

- [ ] **Step 3: Implement the minimal streaming adapter**

Implement owner-aware anchor state and a byte transformer that retains only a
suffix which could be the start of the synchronized-frame terminator. Insert a
1-based CUP converted from the renderer's zero-based screen coordinate, plus
`CSI ? 25 l`, before each complete terminator. Wrap the real
stdout in a delegating proxy so OpenTUI selects its native custom-output feed.

Expose a resize forwarder with this contract:

```ts
installRendererResizeForwarder(
  renderer: { resize(width: number, height: number): void },
  terminal: Pick<NodeJS.WriteStream, "columns" | "rows">,
  signals?: Pick<NodeJS.Process, "on" | "removeListener">,
): () => void
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
cd packages/kobe
bunx vitest run test/tui/ime-anchor-output.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit the renderer-output seam**

```bash
git add packages/kobe/src/tui/lib/ime-anchor-output.ts packages/kobe/test/tui/ime-anchor-output.test.ts
git commit -m "fix: anchor hidden cursor at frame end" -m "Route macOS OpenTUI frames through an owner-aware output adapter. It restores the hidden hardware cursor before synchronized-frame commit so IME preedit cannot follow diff rendering."
```

### Task 2: Retain the PTY cursor independently from the visual cursor

**Files:**
- Create: `packages/kobe/src/tui/panes/terminal/ime-cursor.ts`
- Create: `packages/kobe/test/tui/terminal-ime-cursor.test.ts`
- Modify: `packages/kobe/src/tui-react/panes/terminal/Terminal.tsx`

**Interfaces:**
- Produces: `ImeCursorRetention.update(pty, cursor)` returning the retained `CursorPos | null`.
- Consumes: the shared `imeAnchorController` from Task 1.

- [ ] **Step 1: Write the failing retention tests**

Pin these transitions:

```ts
tracker.update(ptyA, { x: 12, y: 4 }) // => { x: 12, y: 4 }
tracker.update(ptyA, null)             // => { x: 12, y: 4 }
tracker.update(ptyB, null)             // => null
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cd packages/kobe
bunx vitest run test/tui/terminal-ime-cursor.test.ts
```

Expected: FAIL because `terminal/ime-cursor` does not exist.

- [ ] **Step 3: Implement minimal cursor retention**

Add a small framework-free tracker that remembers the last non-null cursor for
one PTY identity and clears on identity change.

- [ ] **Step 4: Integrate anchor ownership in `Terminal.tsx`**

Keep `visibleCursor` unchanged for `overlayCursor`. Derive a second viewport
cursor from the retention tracker. When focused and laid out, claim the shared
controller with a stable per-component owner token, then call OpenTUI's existing
hidden `setCursorPosition`. Release only the matching owner on blur/unmount and
park at origin only when that release actually cleared the active anchor.

- [ ] **Step 5: Run focused terminal tests and verify GREEN**

Run:

```bash
cd packages/kobe
bunx vitest run test/tui/terminal-ime-cursor.test.ts test/tui/terminal-viewport.test.ts test/tui/terminal-render.test.ts
bun test test/render/terminal-ime-keys.test.tsx
```

Expected: all tests pass.

- [ ] **Step 6: Commit cursor-state separation**

```bash
git add packages/kobe/src/tui/panes/terminal/ime-cursor.ts packages/kobe/src/tui-react/panes/terminal/Terminal.tsx packages/kobe/test/tui/terminal-ime-cursor.test.ts
git commit -m "fix: retain terminal IME anchor through redraws" -m "Separate the visual PTY cursor from the macOS IME anchor. Transient cursor-hide frames retain the last valid location, and owner tokens prevent stale split cleanup from clearing the focused pane."
```

### Task 3: Wire the macOS host and publish the fix

**Files:**
- Modify: `packages/kobe/src/tui-react/lib/host-boot.tsx`
- Modify: `packages/kobe/test/tui/host-render-options.test.ts`
- Create: `.changeset/stable-ime-anchor.md`

**Interfaces:**
- Consumes: `createImeAnchoredOutput` and `installRendererResizeForwarder` from Task 1.
- Produces: macOS fullscreen hosts using the transformed custom stdout with `remote: false`; all other hosts retain current options.

- [ ] **Step 1: Add failing host-option tests**

Extract a pure composition helper that receives `platform`, `stdout`, and
`onDestroy`. Assert macOS fullscreen options contain the proxy stdout and
`remote: false`, while Linux and inline options remain byte-for-byte equivalent
to the prior direct path.

- [ ] **Step 2: Run the host tests and verify RED**

Run:

```bash
cd packages/kobe
bunx vitest run test/tui/host-render-options.test.ts
```

Expected: FAIL because the macOS renderer-output composition is absent.

- [ ] **Step 3: Wire renderer construction and cleanup**

Create the adapter only for `platform === "darwin"` and fullscreen hosts. Pass
its proxy as `stdout`, set `remote: false`, forward `SIGWINCH`, and release the
listener plus any pending transformer prefix in the wrapped destroy callback.

- [ ] **Step 4: Add the patch changeset**

Create `.changeset/stable-ime-anchor.md`:

```md
---
"@sma1lboy/kobe": patch
---

Keep macOS input-method preedit and candidate windows anchored to the embedded terminal prompt while Claude or another engine animates output.
```

- [ ] **Step 5: Run scoped and repository verification**

Run:

```bash
cd packages/kobe
bunx vitest run test/tui/ime-anchor-output.test.ts test/tui/terminal-ime-cursor.test.ts test/tui/host-render-options.test.ts
bun test test/render/terminal-ime-keys.test.tsx
cd ../..
bun run lint
bun run typecheck
bun run test
cd packages/kobe
bun run test:render
bun run build
bun run test:behavior
```

Expected: all commands pass. Inspect touched source-file line counts and confirm
all are at or below 500 lines.

- [ ] **Step 6: Commit publication metadata**

```bash
git add packages/kobe/src/tui-react/lib/host-boot.tsx packages/kobe/test/tui/host-render-options.test.ts .changeset/stable-ime-anchor.md
git commit -m "fix: enable stable macOS IME anchoring" -m "Use the frame-final cursor adapter only for fullscreen macOS hosts and preserve local terminal detection and resize handling. Ship the behavior as a patch changeset."
```

- [ ] **Step 7: Push and open the KOBE pull request**

```bash
git push -u origin fix/ime-anchor-stability
gh pr create --base main --head fix/ime-anchor-stability --title "fix: stabilize macOS IME anchor in embedded terminals" --body-file /tmp/kobe-ime-pr.md
```

The PR body must include the reproduced root cause, the frame-final output
contract, test evidence, and the remaining manual iTerm acceptance item.
