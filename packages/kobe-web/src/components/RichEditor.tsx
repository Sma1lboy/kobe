import { Image } from "@tiptap/extension-image"
import { Placeholder } from "@tiptap/extensions"
import type { Editor } from "@tiptap/react"
import { EditorContent, useEditor } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { useCallback, useRef, useState } from "react"
import { Markdown, type MarkdownStorage } from "tiptap-markdown"
import { uploadIssueAsset } from "../lib/issue-assets.ts"
import "./RichEditor.css"

function getMarkdown(editor: Editor): string {
  const storage = editor.storage as { markdown?: MarkdownStorage }
  return storage.markdown?.getMarkdown() ?? ""
}

interface RichEditorProps {
  value: string
  onChange: (markdown: string) => void
  repoRoot: string
  placeholder?: string
}

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
  const [uploading, setUploading] = useState(0)
  const repoRootRef = useRef(repoRoot)
  repoRootRef.current = repoRoot
  const editorRef = useRef<Editor | null>(null)

  const insertImageFiles = useCallback(async (files: File[]) => {
    const editor = editorRef.current
    if (!editor) return
    for (const file of files) {
      setUploading((n) => n + 1)
      try {
        const { url } = await uploadIssueAsset(repoRootRef.current, file)
        editor.chain().focus().setImage({ src: url }).run()
      } catch {
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
    onUpdate: ({ editor }) => {
      onChange(getMarkdown(editor))
    },
    editorProps: {
      handlePaste: (_view, event) => {
        const files = imageFilesFrom(event.clipboardData)
        if (files.length === 0) return false
        event.preventDefault()
        void insertImageFiles(files)
        return true
      },
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
