/**
 * RichEditor — a single-surface WYSIWYG markdown editor for issue bodies.
 *
 * The issue description is one Notion-like surface that edits AND renders at
 * once: typing styles inline (headings, lists, bold, code…) and pasted/dropped
 * image FILES upload and appear inline in the same editor — no separate preview
 * pane, no plain textarea.
 *
 * Storage is markdown (issues.json). We load from markdown and emit markdown:
 * tiptap-markdown parses the `content` prop on init and exposes
 * `editor.storage.markdown.getMarkdown()`, which we hand back via `onChange`.
 *
 * Controlled-but-uncontrolled: callers remount this per issue (`key={issueId}`),
 * so we seed `content` from `value` ONCE on init and DON'T resync on every
 * `value` prop change — resetting content mid-edit fights the cursor.
 *
 * Image safety: only files uploaded through `uploadIssueAsset` (which returns an
 * `/api/issue-assets/<hash>/<file>` url) are inserted. That url is the only
 * shape the markdown renderer will emit as an `<img>` (see lib/markdown.ts
 * `safeImageSrc`), so the upload + render paths stay XSS-safe by construction.
 */

import { Image } from "@tiptap/extension-image"
import { Placeholder } from "@tiptap/extensions"
import type { Editor } from "@tiptap/react"
import { EditorContent, useEditor } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { useCallback, useRef, useState } from "react"
import { Markdown, type MarkdownStorage } from "tiptap-markdown"
import { uploadIssueAsset } from "../lib/issue-assets.ts"
import "./RichEditor.css"

/**
 * Read the document back as markdown. tiptap-markdown exposes `getMarkdown()`
 * on `editor.storage.markdown`, but ships `MarkdownStorage` WITHOUT augmenting
 * `@tiptap/core`'s `Storage` interface (and `@tiptap/core` isn't a direct dep
 * here to augment), so the `storage` map is untyped for that key. Narrow it at
 * the single read site instead of casting inline.
 */
function getMarkdown(editor: Editor): string {
  const storage = editor.storage as { markdown?: MarkdownStorage }
  return storage.markdown?.getMarkdown() ?? ""
}

interface RichEditorProps {
  /** Current body as markdown. Seeds the editor ONCE on mount. */
  value: string
  /** Emits the editor's markdown on every change. */
  onChange: (markdown: string) => void
  /** Repo the issue belongs to — scopes uploaded assets server-side. */
  repoRoot: string
  /** Shown when the document is empty. */
  placeholder?: string
}

/** Pull image `File`s out of a clipboard/drag payload, ignoring non-images. */
function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return []
  const out: File[] = []
  for (const file of Array.from(data.files)) {
    if (file.type.startsWith("image/")) out.push(file)
  }
  return out
}

export function RichEditor({
  value,
  onChange,
  repoRoot,
  placeholder = "Write a description…",
}: RichEditorProps) {
  // Count of in-flight asset uploads; drives the "uploading…" affordance.
  const [uploading, setUploading] = useState(0)
  // Keep the latest repoRoot reachable from the editorProps closures (created
  // once at init) without re-creating the editor.
  const repoRootRef = useRef(repoRoot)
  repoRootRef.current = repoRoot
  // The editorProps handlers are built before `useEditor` returns, so they read
  // the live editor through a ref rather than the (not-yet-assigned) binding.
  const editorRef = useRef<Editor | null>(null)

  // Upload each image file, inserting it at the cursor as it lands. Reads
  // repoRoot + editor from refs so it never goes stale despite the handlers
  // being wired once at editor creation.
  const insertImageFiles = useCallback(async (files: File[]) => {
    const editor = editorRef.current
    if (!editor) return
    for (const file of files) {
      setUploading((n) => n + 1)
      try {
        const { url } = await uploadIssueAsset(repoRootRef.current, file)
        editor.chain().focus().setImage({ src: url }).run()
      } catch {
        // Swallow per-file upload errors — toast surfacing lives in callers;
        // here we just stop the spinner so the editor stays usable.
      } finally {
        setUploading((n) => Math.max(0, n - 1))
      }
    }
  }, [])

  const editor = useEditor({
    extensions: [
      StarterKit,
      Image.configure({ inline: false, allowBase64: false }),
      Markdown.configure({ html: false }),
      Placeholder.configure({ placeholder }),
    ],
    content: value,
    // Re-rendering on every keystroke is fine here; the editor is small and
    // remounted per issue, so callers stay in sync for save state.
    onUpdate: ({ editor }) => {
      onChange(getMarkdown(editor))
    },
    editorProps: {
      // Intercept pasted image FILES (e.g. a screenshot from the clipboard):
      // upload each, then insert as an issue-asset <img>. Plain-text/markdown
      // paste falls through to TipTap's own handling (returns false).
      handlePaste: (_view, event) => {
        const files = imageFilesFrom(event.clipboardData)
        if (files.length === 0) return false
        event.preventDefault()
        void insertImageFiles(files)
        return true
      },
      // Same for dropped image FILES. `moved` (an internal node move) is never
      // an external file drop, so we ignore it and let TipTap handle that path.
      handleDrop: (_view, event, _slice, moved) => {
        if (moved) return false
        const files = imageFilesFrom(event.dataTransfer)
        if (files.length === 0) return false
        event.preventDefault()
        void insertImageFiles(files)
        return true
      },
    },
  })
  editorRef.current = editor

  return (
    <div className="kobe-rich relative overflow-auto border border-line bg-bg px-4 py-3 focus-within:border-line-active">
      <EditorContent editor={editor} className="min-h-56" />
      {uploading > 0 ? (
        <div className="pointer-events-none absolute right-2 top-2 rounded border border-line bg-inset px-1.5 py-0.5 text-[10px] text-muted">
          uploading…
        </div>
      ) : null}
    </div>
  )
}
