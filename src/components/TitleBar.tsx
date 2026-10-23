import { clipflow } from "../lib/bridge";
import { cn } from "../utils/cn";

interface Props {
  armed: boolean;
  native: boolean;
  version: string;
}

export default function TitleBar({ armed, native, version }: Props) {
  return (
    <header
      className="drag-region flex h-10 shrink-0 select-none items-center justify-between border-b border-[#d3d9e0] bg-[#e9ecef] px-3.5"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest(".no-drag")) return;
        void clipflow.startDragging();
      }}
    >
      <div className="flex items-center gap-2.5">
        {/* App Mark */}
        <div className="flex h-5 w-5 items-center justify-center rounded bg-[#eceff2] text-[#2563eb] border border-[#d3d9e0]">
          <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current" aria-hidden="true">
            <path d="M4 3.5v9l8-4.5-8-4.5z" />
          </svg>
        </div>

        <div className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-semibold tracking-normal text-[#0f172a]">
            ClipFlow
          </span>
          <span className="font-mono text-[10px] text-[#475569]">
            v{version}
          </span>
        </div>

        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide",
            armed
              ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
              : "border border-[#d3d9e0] bg-[#f8f9fa] text-[#475569]",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              armed ? "bg-emerald-400 animate-rec" : "bg-[#64748b]",
            )}
          />
          {armed ? "Recording Buffer Active" : "Ready on Standby"}
        </span>

        {!native && (
          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-700">
            SIMULATED PREVIEW
          </span>
        )}
      </div>

      <div className="no-drag flex items-center gap-1">
        <button
          onClick={() => void clipflow.minimize()}
          className="grid h-7 w-8 place-items-center rounded text-[#475569] transition-colors hover:bg-[#eceff2] hover:text-slate-900"
          title="Minimize"
          aria-label="Minimize"
        >
          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25">
            <line x1="2" y1="6" x2="10" y2="6" />
          </svg>
        </button>
        <button
          onClick={() => void clipflow.toggleMaximize()}
          className="grid h-7 w-8 place-items-center rounded text-[#475569] transition-colors hover:bg-[#eceff2] hover:text-slate-900"
          title="Maximize"
          aria-label="Maximize"
        >
          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25">
            <rect x="2.5" y="2.5" width="7" height="7" rx="0.5" />
          </svg>
        </button>
        <button
          onClick={() => void clipflow.hideToTray()}
          className="grid h-7 w-8 place-items-center rounded text-[#475569] transition-colors hover:bg-[#eceff2] hover:text-slate-900"
          title="Hide to tray (keeps recording in background)"
          aria-label="Hide to tray"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.25">
            <path d="M3 4l4 4 4-4" />
            <line x1="2" y1="11" x2="12" y2="11" />
          </svg>
        </button>
        <button
          onClick={() => void clipflow.quit()}
          className="grid h-7 w-8 place-items-center rounded text-[#475569] transition-colors hover:bg-red-500/20 hover:text-red-600"
          title="Quit ClipFlow"
          aria-label="Quit"
        >
          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25">
            <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" />
            <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
          </svg>
        </button>
      </div>
    </header>
  );
}
