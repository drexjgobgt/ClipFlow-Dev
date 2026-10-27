import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Last-resort error boundary.
 *
 * ClipFlow runs in the tray while a game is on screen, so an uncaught render
 * exception used to mean a white window and no way back except killing the
 * process — which also drops the rolling buffer. This keeps the shell alive and
 * gives the user a recovery path plus copyable diagnostics.
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });
    // Local log only — ClipFlow never reports anywhere.
    console.error("[clipflow] unhandled render error", error, info.componentStack);
  }

  private diagnostics = (): string => {
    const { error, info } = this.state;
    return [
      `ClipFlow UI error`,
      `message: ${error?.message ?? "unknown"}`,
      `stack: ${error?.stack ?? "—"}`,
      `component: ${info?.componentStack ?? "—"}`,
      `ua: ${navigator.userAgent}`,
      `time: ${new Date().toISOString()}`,
    ].join("\n");
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid h-screen w-screen place-items-center bg-[#e9ecef] p-6 text-[#0f172a]">
        <div className="panel-elevated w-full max-w-lg rounded-xl border border-[#cdd5df] bg-[#f8f9fa] p-6">
          <div className="text-[15px] font-semibold">ClipFlow hit an unexpected error</div>
          <p className="mt-2 text-[12px] leading-relaxed text-[#475569]">
            The recording buffer keeps running in the background — nothing was lost.
            Reload the window to get the interface back.
          </p>

          <pre className="mt-3 max-h-32 overflow-auto rounded-lg border border-[#d3d9e0] bg-[#eceff2] p-3 font-mono text-[10px] leading-relaxed text-[#475569]">
            {error.message}
          </pre>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg border border-[#2563eb] bg-[#2563eb] px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-[#1d4ed8]"
            >
              Reload window
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(this.diagnostics());
              }}
              className="rounded-lg border border-[#d3d9e0] bg-[#eceff2] px-3.5 py-1.5 text-[12px] text-[#0f172a] hover:border-[#bcc5cf]"
            >
              Copy diagnostics
            </button>
          </div>
        </div>
      </div>
    );
  }
}
