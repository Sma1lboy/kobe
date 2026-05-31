#!/bin/sh
# kobe per-worktree init — runs once before the engine starts.
# Install workspace deps so a fresh worktree is ready to typecheck/build/test.
bun install
