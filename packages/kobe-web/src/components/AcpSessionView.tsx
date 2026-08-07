/**
 * AcpSessionView — the EXPERIMENTAL `claude-acp` vendor's surface. No PTY,
 * no screen grammar: a WS to the sidecar's /acp bridge streams structured
 * `session/update`s (folded by lib/acp.ts) and carries prompts/permission
 * answers back. Deliberately minimal — this is the parallel-link testbed,
 * not a replacement for the grammar path.
 */

import { CornerDownLeft, Loader2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { type AcpItem, type AcpUpdate, applyAcpUpdate } from "../lib/acp.ts"
import { setTabTitle } from "../lib/tabs.ts"
import { ptyBase } from "../lib/terminal.ts"

interface PermissionRequest {
  rpcId: number
  title: string
  options: { optionId: string; name: string; kind?: string }[]
}

function statusTone(status: string): string {
  if (status === "completed") return "text-subtle"
  if (status === "failed") return "text-kobe-red"
  return "text-kobe-blue"
}

export function AcpSessionView({
  tabId,
  taskId,
}: {
  tabId: string
  taskId: string
}) {
  const [items, setItems] = useState<AcpItem[]>([])
  const [phase, setPhase] = useState<"boot" | "ready" | "running" | "error">(
    "boot",
  )
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [draft, setDraft] = useState("")
  const wsRef = useRef<WebSocket | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const base = ptyBase("http").replace(/^http/, "ws")
    const ws = new WebSocket(
      `${base}/acp?tab=${encodeURIComponent(tabId)}&taskId=${encodeURIComponent(taskId)}`,
    )
    wsRef.current = ws
    ws.onmessage = (e) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(e.data)) as Record<string, unknown>
      } catch {
        return
      }
      if (msg.type === "ready") {
        setPhase((cur) => (cur === "boot" ? "ready" : cur))
        setTabTitle(taskId, tabId, "Claude · ACP")
      } else if (msg.type === "update") {
        setItems((cur) => applyAcpUpdate(cur, msg.update as AcpUpdate))
        const u = msg.update as AcpUpdate
        if (u?.sessionUpdate === "user_message_chunk") setPhase("running")
      } else if (msg.type === "turn_end") {
        setPhase("ready")
      } else if (msg.type === "permission_request") {
        const params = msg.params as {
          toolCall?: { title?: string }
          options?: { optionId: string; name: string; kind?: string }[]
        }
        setPermission({
          rpcId: Number(msg.rpcId),
          title: params?.toolCall?.title ?? "Permission required",
          options: params?.options ?? [],
        })
      } else if (msg.type === "error") {
        setPhase("error")
        setError(String(msg.message ?? "ACP error"))
      } else if (msg.type === "exit") {
        setPhase("error")
        setError(`agent exited (${String(msg.code)})`)
      }
    }
    ws.onclose = () => {
      setPhase((cur) => (cur === "error" ? cur : "error"))
      setError((cur) => cur ?? "connection closed")
    }
    return () => {
      wsRef.current = null
      ws.close()
    }
  }, [tabId, taskId])

  // Follow the tail.
  // biome-ignore lint/correctness/useExhaustiveDependencies: items drive the scroll
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  const send = useCallback(() => {
    const text = draft.trim()
    if (!text || phase === "boot" || phase === "error") return
    wsRef.current?.send(JSON.stringify({ type: "prompt", text }))
    setDraft("")
  }, [draft, phase])

  const answerPermission = (optionId: string): void => {
    if (!permission) return
    wsRef.current?.send(
      JSON.stringify({
        type: "permission_outcome",
        rpcId: permission.rpcId,
        optionId,
      }),
    )
    setPermission(null)
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-3 flex items-center gap-2 text-[11px] text-subtle">
          <span className="rounded-full border border-kobe-violet/40 bg-kobe-violet/10 px-2 py-0.5 font-mono text-kobe-violet">
            ACP · experimental
          </span>
          structured session — no terminal underneath
        </div>
        {items.map((item, i) => {
          switch (item.kind) {
            case "user":
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: fold order is the identity
                  key={i}
                  className="my-2 flex justify-end"
                >
                  <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-line-active/50 bg-inset px-3.5 py-2 text-[13px]">
                    {item.text}
                  </div>
                </div>
              )
            case "assistant":
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: fold order is the identity
                  key={i}
                  className="my-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg"
                >
                  {item.text}
                </div>
              )
            case "thought":
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: fold order is the identity
                  key={i}
                  className="my-1.5 whitespace-pre-wrap text-[12px] italic leading-relaxed text-subtle"
                >
                  {item.text}
                </div>
              )
            case "tool":
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: fold order is the identity
                  key={i}
                  className="my-1.5 flex items-center gap-2 rounded border border-line-subtle bg-surface px-2.5 py-1.5 font-mono text-[11px]"
                >
                  {item.status !== "completed" &&
                  item.status !== "failed" ? (
                    <Loader2 size={11} className="animate-spin text-kobe-blue" />
                  ) : (
                    <span className={statusTone(item.status)}>
                      {item.status === "failed" ? "×" : "·"}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-muted">
                    {item.title}
                  </span>
                  <span className={`shrink-0 ${statusTone(item.status)}`}>
                    {item.status}
                  </span>
                </div>
              )
            default:
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: fold order is the identity
                  key={i}
                  className="my-2 rounded border border-line-subtle bg-surface px-3 py-2"
                >
                  <div className="mb-1 text-[10px] font-medium text-subtle">
                    Plan
                  </div>
                  {item.entries.map((entry) => (
                    <div
                      key={entry.content}
                      className={`text-[12px] leading-relaxed ${entry.status === "completed" ? "text-subtle line-through" : "text-muted"}`}
                    >
                      · {entry.content}
                    </div>
                  ))}
                </div>
              )
          }
        })}
        {phase === "boot" && (
          <div className="flex items-center gap-2 py-3 font-mono text-[12px] text-subtle">
            <Loader2 size={12} className="animate-spin text-primary" />
            Starting ACP session…
          </div>
        )}
        {error && (
          <div className="my-2 border-l-2 border-kobe-red pl-3 text-[12px] text-muted">
            {error}
          </div>
        )}
      </div>
      {permission && (
        <div className="mx-4 mb-2 rounded-xl border border-kobe-yellow/50 bg-surface px-3.5 py-2.5">
          <div className="mb-2 text-[12px] text-fg">{permission.title}</div>
          <div className="flex flex-wrap gap-2">
            {permission.options.map((opt) => (
              <button
                key={opt.optionId}
                type="button"
                onClick={() => answerPermission(opt.optionId)}
                className="rounded-md border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
              >
                {opt.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="shrink-0 px-4 pb-3 pt-1">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
          className="flex items-center gap-3 rounded-2xl border border-line bg-bg px-4 py-3 shadow-lg shadow-black/25"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              phase === "running" ? "Agent is working…" : "Message Claude (ACP)…"
            }
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-fg placeholder:text-subtle focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Send"
            className="shrink-0 text-subtle transition-colors hover:text-fg"
          >
            <CornerDownLeft size={14} strokeWidth={2} />
          </button>
        </form>
      </div>
    </div>
  )
}
