import { Component, type ErrorInfo, type ReactNode } from "react"

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[kobe-web] render error:", error, info.componentStack)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-screen items-center justify-center bg-bg p-6 text-fg">
        <div className="w-[28rem] max-w-full border border-kobe-red/40 bg-surface p-5">
          <div className="font-mono text-[13px] font-bold text-primary">
            [kobe web]
          </div>
          <h1 className="mt-3 text-[16px] font-semibold text-fg">
            Something broke rendering this view.
          </h1>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            The dashboard hit an unexpected error. Your tasks and engines are
            untouched — this is a UI-only crash. Try recovering, or reload the
            page.
          </p>
          <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-words border-l-2 border-kobe-red/40 bg-bg px-3 py-2 font-mono text-[11px] text-kobe-red/90">
            {error.message || String(error)}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="border border-line bg-bg px-3 py-1.5 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
            >
              Reload page
            </button>
            <button
              type="button"
              onClick={this.reset}
              className="border border-primary bg-inset px-3 py-1.5 text-[11px] text-fg transition-colors hover:bg-primary/10"
            >
              Try to recover
            </button>
          </div>
        </div>
      </div>
    )
  }
}
