import { Component, type ErrorInfo, type ReactNode } from "react"

import { Callout } from "./Callout"

interface State {
  readonly error: Error | null
}

/** If the window's UI throws, say so and show what threw, instead of a blank window. */
export class ErrorBoundary extends Component<{ readonly title: string; readonly children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div className="crash">
        <Callout tone="error" title={this.props.title}>
          <pre className="output">{`${this.state.error.name}: ${this.state.error.message}\n${this.state.error.stack ?? ""}`}</pre>
        </Callout>
      </div>
    )
  }
}
