// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Hoisted so the vi.mock factory (hoisted above imports) can reference them.
const { saveNotes, fetchNotes } = vi.hoisted(() => ({
  saveNotes: vi.fn<(taskId: string, markdown: string) => Promise<void>>(() => Promise.resolve()),
  fetchNotes: vi.fn<(taskId: string) => Promise<string>>(() => Promise.resolve("")),
}))
vi.mock("../src/lib/notes.ts", () => ({ saveNotes, fetchNotes }))

import { NotesPanel } from "../src/components/NotesPanel.tsx"

/** Render and let the initial fetchNotes() settle so the textarea un-disables. */
async function renderLoaded(taskId: string) {
  let utils!: ReturnType<typeof render>
  await act(async () => {
    utils = render(<NotesPanel taskId={taskId} />)
  })
  return utils
}

function editNotes(value: string) {
  const textarea = screen.getByPlaceholderText(/Notes for this task/i)
  fireEvent.change(textarea, { target: { value } })
}

describe("NotesPanel autosave flush", () => {
  beforeEach(() => {
    saveNotes.mockClear()
    fetchNotes.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it("flushes the pending autosave to the OLD task when the task changes mid-debounce", async () => {
    const { rerender } = await renderLoaded("task-a")
    editNotes("unsaved thought")
    // Still inside the debounce window — no save has fired yet.
    expect(saveNotes).not.toHaveBeenCalled()

    await act(async () => {
      rerender(<NotesPanel taskId="task-b" />)
    })

    // The edit must land on task-a (where it was typed), not be dropped.
    expect(saveNotes).toHaveBeenCalledWith("task-a", "unsaved thought")
  })

  it("flushes the pending autosave on unmount", async () => {
    const { unmount } = await renderLoaded("task-a")
    editNotes("closing note")
    expect(saveNotes).not.toHaveBeenCalled()

    await act(async () => {
      unmount()
    })

    expect(saveNotes).toHaveBeenCalledWith("task-a", "closing note")
  })

  it("still autosaves once after the debounce elapses when left alone", async () => {
    vi.useFakeTimers()
    let utils!: ReturnType<typeof render>
    await act(async () => {
      utils = render(<NotesPanel taskId="task-a" />)
      // Flush the fetchNotes() microtasks queued by the load effect.
      await Promise.resolve()
    })
    editNotes("steady edit")
    expect(saveNotes).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(saveNotes).toHaveBeenCalledTimes(1)
    expect(saveNotes).toHaveBeenCalledWith("task-a", "steady edit")
    utils.unmount()
  })
})
