import { useState } from "react";
import type { EngineStats } from "../lib/types";
import { formatBytes, formatDuration } from "../lib/format";
import { cn } from "../utils/cn";

interface Props {
  stats: EngineStats;
  performanceMode: boolean;
  /** True when the capture adapter is an integrated GPU (engine or monitor). */
  integratedGpu: boolean;
  onTogglePerformanceMode: () => void;
  onRestartEngine: () => void;
}

/**
 * Friendly "is this costing me frames?" card. Technical counters stay behind
 * a disclosure so the default view is three plain-language facts: capture
 * quality, encoder health and audio.
 */
export default function PipelinePanel({
  stats,
  performanceMode,
  integratedGpu,
  onTogglePerformanceMode,
  onRestartEngine,
}: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const armed = stats.state === "buffering" || stats.state === "flushing";
  const pendingRestart = stats.performance_mode !== performanceMode;
  const resolution =
    stats.width > 0 ? `${stats.width} × ${stats.height}` : "Native display";
  const encoder = stats.encoder.hardware ? stats.encoder.friendly_name : "Software encoder";
  const audio = [
    stats.audio_system ? "Game audio" : null,
    stats.audio_mic ? "Microphone" : null,
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <section className="panel rounded-xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-3.5">
        <div>
          <h3 className="text-[14px] font-semibold text-text-primary">Performance</h3>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            Clipping should never cost you a round.
          </p>
        </div>
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
            performanceMode
              ? "border-emerald-300 bg-emerald-50 text-emerald-700"
              : "border-border bg-surface-elevated text-text-secondary",
          )}
        >
          {performanceMode ? "Game Mode ON" : "Game Mode OFF"}
        </span>
      </div>

      <div className="rounded-xl border border-accent/25 bg-accent-subtle p-4">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-accent shadow-sm">
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8">
              <path d="M12 3l7 3v5c0 4.4-3 8.1-7 9-4-0.9-7-4.6-7-9V6l7-3z" />
              <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-text-primary">
              {performanceMode
                ? "Low-impact mode keeps the game first"
                : "Full-quality mode is active"}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
              {performanceMode
                ? integratedGpu
                  ? "Capture is capped at 720p / 30 FPS, the encoder favours speed, and ClipFlow stays quiet in the background while you play."
                  : "Capture is capped at 1080p / 60 FPS, the encoder favours speed, and ClipFlow stays quiet in the background while you play."
                : "Capture follows your monitor and frame-rate settings exactly. Turn Game Mode on if you notice stutter."}
            </p>
          </div>
          <button
            type="button"
            onClick={onTogglePerformanceMode}
            className={cn(
              "relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
              performanceMode ? "bg-accent hover:bg-accent-hover" : "bg-[#94a3b8] hover:bg-[#64748b]",
            )}
            role="switch"
            aria-checked={performanceMode}
            aria-label="Toggle Game Mode"
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform",
                performanceMode ? "translate-x-5" : "translate-x-0",
              )}
            />
          </button>
        </div>
      </div>

      {integratedGpu && performanceMode && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
          <p className="text-[11px] leading-relaxed text-amber-800">
            Integrated GPU detected ({stats.encoder.adapter_name}). The game and the
            encoder share one graphics chip and its memory bandwidth, so Game Mode
            records at 720p/30 to protect your frame rate.
          </p>
        </div>
      )}

      {pendingRestart && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
          <span className="text-[11px] text-amber-800">
            Game Mode changed — restart the engine to apply it.
          </span>
          <button
            type="button"
            onClick={onRestartEngine}
            className="rounded-md border border-amber-400 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100"
          >
            Apply now
          </button>
        </div>
      )}

      <div className="grid gap-2.5 sm:grid-cols-3">
        <Metric label="Capture" value={resolution} hint={`${stats.target_fps} FPS target`} />
        <Metric
          label="Encoder"
          value={stats.encoder.hardware ? "Hardware" : "Software"}
          hint={encoder}
          tone={stats.encoder.hardware ? "ok" : "warn"}
        />
        <Metric
          label="Audio"
          value={audio || "Off"}
          hint={armed ? "Recording into clips" : "Starts with the buffer"}
          tone={audio ? "ok" : "idle"}
        />
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3 font-mono text-[11px] text-text-muted">
        <span>
          {formatDuration(stats.buffered_seconds)} / {stats.buffer_seconds}s buffered
        </span>
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="font-sans text-[11px] font-medium text-text-secondary hover:text-accent"
        >
          {showDetails ? "Hide technical details" : "Technical details"}
        </button>
      </div>

      {showDetails && (
        <div className="animate-fade space-y-2 rounded-lg border border-border bg-surface-elevated p-3 font-mono text-[11px] text-text-secondary">
          <DetailRow label="Encoder" value={`${stats.encoder.codec} · ${encoder}`} />
          <DetailRow label="Encode latency" value={`${stats.encode_ms_avg.toFixed(2)} ms / frame`} />
          <DetailRow label="Capture latency" value={`${stats.gpu_submit_ms_avg.toFixed(2)} ms`} />
          <DetailRow label="Buffer in RAM" value={formatBytes(stats.ring_bytes)} />
          <DetailRow label="Dropped frames" value={String(stats.dropped_frames)} />
          <DetailRow label="GPU adapter" value={stats.encoder.adapter_name} />
        </div>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
  tone = "idle",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "ok" | "warn" | "idle";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-elevated px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
        {label}
      </div>
      <div className="mt-0.5 truncate text-[12px] font-semibold text-text-primary">{value}</div>
      <div
        className={cn(
          "mt-0.5 truncate text-[10px]",
          tone === "ok"
            ? "text-emerald-700"
            : tone === "warn"
              ? "text-amber-700"
              : "text-text-muted",
        )}
      >
        {hint}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-0.5 last:border-0">
      <span className="text-text-muted">{label}</span>
      <span className="truncate text-right text-text-primary">{value}</span>
    </div>
  );
}
