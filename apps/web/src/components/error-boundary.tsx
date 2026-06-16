"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Optional label used in the default fallback's error message. */
  label?: string;
  /** Custom fallback. Receives the error and a reset() that re-mounts the
   *  subtree by bumping internal state — useful for "Retry" affordances. */
  fallback?: (args: { error: Error; reset: () => void }) => ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Local React error boundary. Use to wrap per-row components (message
 * bubbles, contact panel sections, list items) so one bad payload doesn't
 * unmount the parent route segment. Next.js `error.tsx` only catches at
 * segment boundaries — anything finer needs this.
 *
 * Class component because React's "use server"-friendly hook API doesn't
 * yet support `componentDidCatch`.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console; in prod this is the operator's only signal
    // unless we wire telemetry. Don't rethrow — the whole point is to
    // contain the failure to this subtree.
     
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback({ error: this.state.error, reset: this.reset });
      }
      return (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          Couldn&apos;t render {this.props.label ?? "this item"}.{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:no-underline"
            onClick={this.reset}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
