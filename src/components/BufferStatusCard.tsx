import { useEffect, useMemo, useRef, useState } from "react";
import type { EngineStats } from "../lib/types";
import { VENDOR_LABEL } from "../lib/types";
import { formatBytes, formatDuration } from "../lib/format";
import { cn } from "../utils/cn";

interface Props {
  stats: EngineStats;
  hotkey: string;
  busy?: boolean;
  eco?: { active: boolean; reason: "battery" | "ram" | "off" } | null;
  onToggle: () => void;
  onSave: () => void;
  onSelectDuration?: (seconds: number) => void;
  onOpenSettings?: () => void;
}

/** Pre-set instant replay durations commonly used in gaming */
const REPLAY_DURATIONS = [15, 30, 60, 120];

/** Minimalist sparkline showing per-frame hardware encode latency */
function LatencySparkline({ value }: { value: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const history = useRef<number[]>([]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    history.current.push(value);
    if (history.current.length > 60) history.current.shift();

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const data = history.current;
    const max = Math.max(2.5, ...data) * 1.2;

    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / Math.max(data.length - 1, 1)) * w;
      const y = h - (v / max) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "rgba(37, 99, 235, 0.14)");
    grad.addColorStop(1, "rgba(37, 99, 235, 0.0)");
    ctx.fillStyle = grad;
    ctx.fill();
  }, [value]);

  return <canvas ref={ref} className="h-7 w-full" aria-label="Encode latency graph" />;
}

export default function BufferStatusCard({
  stats,
  hotkey,
  busy,
  eco,
  onToggle,
  onSave,
  onSelectDuration,
  onOpenSettings,
}: Props) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const armed = stats.state === "buffering" || stats.state === "flushing";

  // Friendly plain-language recording state
  const statusConfig = useMemo(() => {
    if (stats.privacy_active) {
      return {
        badge: "Recording paused",
        tone: "text-amber-700 border-amber-500/30 bg-amber-500/10",
        dot: "bg-amber-400",
        summary: "Privacy mode active — capture paused while desktop or browser is focused.",
        actionReady: false,
      };
    }
    switch (stats.state) {
      case "buffering":
        return {
          badge: "Recording buffer active",
          tone: "text-emerald-700 border-emerald-500/30 bg-emerald-500/10",
          dot: "bg-emerald-400",
          summary: "Continuously caching recent gameplay into memory. Press hotkey to save.",
          actionReady: true,
        };
      case "flushing":
        return {
          badge: "Saving clip to disk…",
          tone: "text-blue-700 border-blue-400/30 bg-blue-500/10",
          dot: "bg-blue-400 animate-rec",
          summary: "Packaging replay buffer into an MP4 video file in under 50 ms.",
          actionReady: false,
        };
      case "starting":
        return {
          badge: "Initializing recorder…",
          tone: "text-blue-700 border-blue-400/30 bg-blue-500/10",
          dot: "bg-blue-400 animate-rec",
          summary: "Connecting to D3D11 display duplication and spinning up hardware encoder.",
          actionReady: false,
        };
      case "recovering":
        return {
          badge: "Reconnecting capture…",
          tone: "text-amber-700 border-amber-500/30 bg-amber-500/10",
          dot: "bg-amber-400 animate-rec",
          summary: "Display resolution changed or GPU reset. Re-establishing capture stream.",
          actionReady: false,
        };
      case "error":
        return {
          badge: "Recording unavailable",
          tone: "text-red-600 border-red-500/30 bg-red-500/10",
          dot: "bg-red-400",
          summary: stats.last_error ?? "Capture pipeline encountered an error. Check settings.",
          actionReady: false,
        };
      case "idle":
      default:
        return {
          badge: "Ready to record",
          tone: "text-[#475569] border-[#d3d9e0] bg-[#f8f9fa]",
          dot: "bg-[#64748b]",
          summary: "Replay buffer is on standby. Arm the buffer to start capturing gameplay.",
          actionReady: false,
        };
    }
  }, [stats.state, stats.privacy_active, stats.last_error]);

  // Audio health status calculations
  const audioInfo = useMemo(() => {
    const rawErr = stats.audio_error?.toLowerCase() ?? "";
    const isMicError = rawErr.includes("microphone") || rawErr.includes("mic");
    const isSysError = rawErr.includes("loopback") || rawErr.includes("system") || rawErr.includes("render");
    const isGeneralErr = Boolean(stats.audio_error && !isMicError && !isSysError);

    const gameAudio = !stats.audio_system
      ? {
          status: "Disabled",
          tone: "text-[#475569] bg-[#eceff2] border-[#d3d9e0]",
          dot: "bg-[#64748b]",
          message: "Game audio capture is turned off in settings.",
          isError: false,
        }
      : stats.audio_error && (isSysError || isGeneralErr)
        ? {
            status: "Device unavailable",
            tone: "text-red-600 bg-red-500/10 border-red-500/30",
            dot: "bg-red-400",
            message: stats.audio_error,
            isError: true,
          }
        : armed
          ? {
              status: "Capturing game audio",
              tone: "text-emerald-700 bg-emerald-500/10 border-emerald-500/30",
              dot: "bg-emerald-400",
              message: "48 kHz stereo loopback recording cleanly.",
              isError: false,
            }
          : {
              status: "Ready on standby",
              tone: "text-[#475569] bg-[#eceff2] border-[#d3d9e0]",
              dot: "bg-emerald-500/70",
              message: "Will capture game audio once buffer is armed.",
              isError: false,
            };

    const microphone = !stats.audio_mic
      ? {
          status: "Disabled",
          tone: "text-[#475569] bg-[#eceff2] border-[#d3d9e0]",
          dot: "bg-[#64748b]",
          message: "Microphone recording is turned off in settings.",
          isError: false,
        }
      : stats.audio_error && (isMicError || isGeneralErr)
        ? {
            status: "Microphone unavailable",
            tone: "text-amber-700 bg-amber-500/10 border-amber-500/30",
            dot: "bg-amber-400",
            message: stats.audio_error,
            isError: true,
          }
        : armed
          ? {
              status: "Microphone active",
              tone: "text-emerald-700 bg-emerald-500/10 border-emerald-500/30",
              dot: "bg-emerald-400",
              message: "Voice commentary mixed directly into clip.",
              isError: false,
            }
          : {
              status: "Ready on standby",
              tone: "text-[#475569] bg-[#eceff2] border-[#d3d9e0]",
              dot: "bg-emerald-500/70",
              message: "Will record voice once buffer is armed.",
              isError: false,
            };

    return { gameAudio, microphone };
  }, [stats.audio_system, stats.audio_mic, stats.audio_error, armed]);

  // Buffer fill fraction
  const fillPercent = useMemo(() => {
    if (!stats.buffer_seconds || stats.buffer_seconds <= 0) return 0;
    return Math.min(100, Math.round((stats.buffered_seconds / stats.buffer_seconds) * 100));
  }, [stats.buffered_seconds, stats.buffer_seconds]);

  return (
    <section className="panel rounded-xl p-5 space-y-5">
      {/* ------------------------------------------------ Top: Recording Status Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#d3d9e0] pb-4">
        <div className="flex items-start gap-3">
          <span className={cn("mt-1.5 h-3 w-3 shrink-0 rounded-full", statusConfig.dot)} />
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <span className={cn("rounded-full border px-3 py-0.5 text-[12px] font-semibold tracking-wide", statusConfig.tone)}>
                {statusConfig.badge}
              </span>

              {eco?.active && (
                <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-700">
                  ECO Mode ({eco.reason === "battery" ? "Battery" : "RAM saver"})
                </span>
              )}
            </div>

            <p className="mt-1 text-[13px] text-[#475569]">
              {statusConfig.summary}
            </p>

            <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-[#475569]">
              <span>{stats.width > 0 ? `${stats.width}×${stats.height}` : "1080p display"}</span>
              <span>·</span>
              <span>{stats.target_fps} FPS target</span>
              <span>·</span>
              <span>{stats.encoder.hardware ? stats.encoder.friendly_name : "Software Encoder"}</span>
              {stats.capture_fps > 0 && (
                <>
                  <span>·</span>
                  <span className="text-[#475569]">{stats.capture_fps.toFixed(0)} FPS live</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Arm / Disarm Buffer Toggle */}
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className={cn(
            "rounded-lg border px-4 py-2 font-medium text-[12px] transition-colors",
            armed
              ? "border-[#bcc5cf] bg-[#eceff2] text-[#0f172a] hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-600"
              : "border-[#2563eb]/40 bg-[#2563eb]/10 text-[#2563eb] hover:bg-[#2563eb]/20 hover:border-[#2563eb]",
            busy && "cursor-wait opacity-60",
          )}
        >
          {armed ? "Pause Buffer" : "Start Buffer"}
        </button>
      </div>

      {/* ------------------------------------------------ Center: Primary Action & Replay Duration */}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] items-stretch">
        {/* Main CTA: Save Clip Button */}
        <div className="rounded-xl border border-[#d3d9e0] bg-[#f8f9fa] p-4 flex flex-col justify-between gap-3">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold tracking-wider uppercase text-[#475569]">
                Instant Replay
              </span>
              <span className="font-mono text-[11px] text-[#475569]">
                Hotkey: <kbd className="rounded border border-[#bcc5cf] bg-[#eceff2] px-1.5 py-0.5 font-semibold text-[#0f172a]">{hotkey.toUpperCase()}</kbd>
              </span>
            </div>

            <p className="mt-1.5 text-[12px] leading-relaxed text-[#475569]">
              Saves the last {stats.buffer_seconds} seconds of gameplay directly to an MP4 video file.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSave}
              disabled={!statusConfig.actionReady || busy}
              className={cn(
                "flex-1 flex items-center justify-center gap-2.5 rounded-lg py-3 px-4 font-semibold text-[13px] transition-all",
                statusConfig.actionReady && !busy
                  ? "bg-[#2563eb] text-white shadow-md hover:bg-[#1d4ed8] active:scale-[0.99] cursor-pointer"
                  : "bg-[#eceff2] text-[#475569] border border-[#d3d9e0] cursor-not-allowed",
              )}
            >
              {busy ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-900 border-t-transparent" />
                  <span>Saving Clip…</span>
                </>
              ) : (
                <>
                  <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current">
                    <path d="M3 2.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.8.4L8 10.333l-4.2 3.567a.5.5 0 0 1-.8-.4v-11z" />
                  </svg>
                  <span>Save Last {stats.buffer_seconds} Seconds</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Replay Duration Selector */}
        <div className="rounded-xl border border-[#d3d9e0] bg-[#f8f9fa] p-4 flex flex-col justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold tracking-wider uppercase text-[#475569]">
              Replay Duration
            </div>
            <p className="mt-1 text-[12px] text-[#475569]">
              Choose how much recent gameplay to keep in high-speed RAM.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {REPLAY_DURATIONS.map((dur) => {
              const active = stats.buffer_seconds === dur;
              return (
                <button
                  key={dur}
                  type="button"
                  onClick={() => onSelectDuration?.(dur)}
                  disabled={busy}
                  className={cn(
                    "flex-1 rounded-lg border py-2 text-center font-mono text-[12px] font-semibold transition-all",
                    active
                      ? "border-[#2563eb] bg-[#2563eb]/15 text-[#2563eb]"
                      : "border-[#d3d9e0] bg-[#eceff2] text-[#475569] hover:border-[#bcc5cf] hover:text-slate-900",
                  )}
                >
                  {dur >= 60 ? `${dur / 60}m` : `${dur}s`}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between font-mono text-[11px] text-[#475569]">
            <span>Buffer capacity:</span>
            <span className="text-[#0f172a] font-medium">
              {formatDuration(stats.buffered_seconds)} / {stats.buffer_seconds}s ({fillPercent}%)
            </span>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------ Audio Health Cards (Split Game Audio & Mic) */}
      <div className="grid gap-3 sm:grid-cols-2">
        {/* Game Audio */}
        <div className="rounded-xl border border-[#d3d9e0] bg-[#f8f9fa] p-3.5 flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#d3d9e0] bg-[#eceff2] text-[#0f172a]">
            <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.5">
              <path d="M2.5 6.5h2.5l3.5-3.5v10L5 9.5H2.5v-3z" />
              <path d="M11 5.5a3.5 3.5 0 0 1 0 5" strokeLinecap="round" />
            </svg>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold text-[#0f172a]">Game Audio</span>
              <div className="flex items-center gap-1.5">
                <span className={cn("flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium", audioInfo.gameAudio.tone)}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", audioInfo.gameAudio.dot)} />
                  {audioInfo.gameAudio.status}
                </span>
                {onOpenSettings && (audioInfo.gameAudio.isError || !stats.audio_system) && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="text-[10px] font-medium text-[#2563eb] hover:underline cursor-pointer"
                  >
                    Setup →
                  </button>
                )}
              </div>
            </div>
            <p className="mt-1 text-[11px] text-[#475569] leading-normal truncate">
              {audioInfo.gameAudio.message}
            </p>
          </div>
        </div>

        {/* Microphone */}
        <div className="rounded-xl border border-[#d3d9e0] bg-[#f8f9fa] p-3.5 flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#d3d9e0] bg-[#eceff2] text-[#0f172a]">
            <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.5">
              <rect x="5.5" y="2" width="5" height="8" rx="2.5" />
              <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" strokeLinecap="round" />
            </svg>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold text-[#0f172a]">Microphone</span>
              <div className="flex items-center gap-1.5">
                <span className={cn("flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium", audioInfo.microphone.tone)}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", audioInfo.microphone.dot)} />
                  {audioInfo.microphone.status}
                </span>
                {onOpenSettings && (audioInfo.microphone.isError || !stats.audio_mic) && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="text-[10px] font-medium text-[#2563eb] hover:underline cursor-pointer"
                  >
                    Setup →
                  </button>
                )}
              </div>
            </div>
            <p className="mt-1 text-[11px] text-[#475569] leading-normal truncate">
              {audioInfo.microphone.message}
            </p>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------ Expandable Technical Diagnostics */}
      <div className="rounded-lg border border-[#d3d9e0]/70 bg-[#f1f3f5] overflow-hidden">
        <button
          type="button"
          onClick={() => setShowDiagnostics((v) => !v)}
          className="w-full flex items-center justify-between px-3.5 py-2.5 text-left transition-colors hover:bg-[#eceff2]"
        >
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold tracking-wide text-[#475569]">
              Technical Diagnostics & System Details
            </span>
            <span className="font-mono text-[10px] text-[#475569]">
              ({stats.encode_ms_avg.toFixed(1)} ms latency · {formatBytes(stats.process_rss_bytes, 0)} RAM)
            </span>
          </div>

          <span className="font-mono text-[11px] text-[#475569]">
            {showDiagnostics ? "Hide Details ▲" : "View Details ▼"}
          </span>
        </button>

        {showDiagnostics && (
          <div className="border-t border-[#d3d9e0] p-4 space-y-3.5 animate-fade">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 font-mono text-[11px]">
              <div className="rounded border border-[#d3d9e0] bg-[#f8f9fa] p-2.5">
                <div className="text-[10px] text-[#475569] uppercase">Display Acquire</div>
                <div className="mt-1 font-semibold text-[#0f172a]">
                  {stats.gpu_submit_ms_avg.toFixed(2)} ms
                </div>
                <div className="text-[10px] text-[#475569] mt-0.5">DXGI duplication latency</div>
              </div>

              <div className="rounded border border-[#d3d9e0] bg-[#f8f9fa] p-2.5">
                <div className="text-[10px] text-[#475569] uppercase">Encoding Latency</div>
                <div className="mt-1 font-semibold text-[#2563eb]">
                  {stats.encode_ms_avg.toFixed(2)} ms / frame
                </div>
                <div className="text-[10px] text-[#475569] mt-0.5">{stats.encoder.codec} hardware MFT</div>
              </div>

              <div className="rounded border border-[#d3d9e0] bg-[#f8f9fa] p-2.5">
                <div className="text-[10px] text-[#475569] uppercase">Memory Footprint</div>
                <div className="mt-1 font-semibold text-[#0f172a]">
                  {formatBytes(stats.process_rss_bytes, 0)}
                </div>
                <div className="text-[10px] text-[#475569] mt-0.5">{formatBytes(stats.ring_bytes)} ring buffer</div>
              </div>

              <div className="rounded border border-[#d3d9e0] bg-[#f8f9fa] p-2.5">
                <div className="text-[10px] text-[#475569] uppercase">Dropped Frames</div>
                <div className={cn("mt-1 font-semibold", stats.dropped_frames > 0 ? "text-amber-700" : "text-[#0f172a]")}>
                  {stats.dropped_frames} frames
                </div>
                <div className="text-[10px] text-[#475569] mt-0.5">{stats.device_resets} device resets</div>
              </div>
            </div>

            {/* Hardware Encoder Info & Latency Sparkline */}
            <div className="rounded border border-[#d3d9e0] bg-[#f8f9fa] p-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-[#0f172a]">
                  {VENDOR_LABEL[stats.encoder.vendor]} · {stats.encoder.friendly_name}
                </span>
                <span className="font-mono text-[10px] text-[#475569]">
                  {stats.encoder.adapter_name}
                </span>
              </div>
              <div className="mt-2">
                <LatencySparkline value={stats.encode_ms_avg} />
              </div>
            </div>

            {stats.last_error && (
              <div className="rounded border border-red-500/30 bg-red-500/10 p-2.5 font-mono text-[11px] text-red-700">
                <span className="font-semibold text-red-700">Last Engine Fault: </span>
                {stats.last_error}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
