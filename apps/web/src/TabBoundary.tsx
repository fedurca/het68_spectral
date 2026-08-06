/*
 * A rendering fault in one tab must not take the session with it.
 *
 * Everything on screen is derived from a recording that can take an afternoon to
 * collect, and the analyzer holds it only in memory. An uncaught exception in a panel
 * unmounts the whole React tree, which discards the audio, the STFT and every result
 * along with it. Catching per tab costs one component and keeps the failure legible:
 * the tab that broke says so, the rest of the application keeps working, and the
 * message is the one the developer needs rather than a blank page.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Changing this remounts the boundary, so switching tabs clears a stale error. */
  tab: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string | null;
}

export class TabBoundary extends Component<Props, State> {
  override state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack ?? null });
    console.error(`panel "${this.props.tab}" failed to render`, error, info);
  }

  override componentDidUpdate(prev: Props) {
    if (prev.tab !== this.props.tab && this.state.error) {
      this.setState({ error: null, stack: null });
    }
  }

  override render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="finding stacked" data-severity="error">
        <strong>The {this.props.tab} panel failed to render</strong>
        <span>
          {error.message}. The recording and every computed result are still loaded;
          another tab will show them. Report this with the trace below.
        </span>
        <pre className="trace">
          {error.stack ?? String(error)}
          {stack ?? ""}
        </pre>
      </div>
    );
  }
}
