import { useState } from "react";
import type { EngineStats } from "../lib/types";
import { formatBytes, formatDuration } from "../lib/format";
import { cn } from "../utils/cn";

interface Props {
  stats: EngineStats;
}

export default function PipelinePanel({ stats }: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const armed = stats.state === "buffering" || stats.state === "flushing";

  const errLower = stats.audio_error?.toLowerCase() ?? "";
  const isMicError = errLower.includes("microphone") || errLower.includes("mic");
  const isSysError = errLower.includes("loopback") || errLower.includes("system") || errLower.includes("render");
  const isGeneralAudioError = Boolean(stats.audio_error && !isMicError && !isSysError);

  const stages = [
    {
      name: "Screen Capture",
      status: armed && stats.width > 0 ? "Active" : armed ? "Connecting" : "Standby",
      tone: armed && stats.width > 0 ? "ok" : armed ? "warn" : "idle",
      description: "Capturing display frames with low-latency Windows desktop duplication.",
      tech: `${stats.width > 0 ? `${stats.width}×${stats.height}` : "1080p"} BGRA · ${stats.gpu_submit_ms_avg.toFixed(2)} ms blit latency`,
    },
    {
      name: "Video Encoding",
      status: armed ? "Active" : "Standby",
      tone: armed ? "ok" : "idle",
      description: `Hardware GPU encoding with ${stats.encoder.friendly_name}.`,
      tech: `${stats.encoder.codec} hardware MFT · ${stats.encode_ms_avg.toFixed(2)} ms / frame · zero copy`,
    },
    {
      name: "Game Audio",
      status: !stats.audio_system
        ? "Disabled"
        : stats.audio_error && (isSysError || isGeneralAudioError)
          ? "Error"
          : armed
            ? "Active"
            : "Standby",
      tone: !stats.audio_system
        ? "idle"
        : stats.audio_error && (isSysError || isGeneralAudioError)
          ? "err"
          : armed
            ? "ok"
            : "idle",
      description: stats.audio_system
        ? "Recording game and system sound cleanly at 48 kHz stereo."
        : "Game audio recording is turned off in settings.",
      tech: `WASAPI loopback · A/V drift: ${stats.audio_drift_ms.toFixed(2)} ms`,
    },
    {
      name: "Microphone",
      status: !stats.audio_mic
        ? "Disabled"
        : stats.audio_error && (isMicError || isGeneralAudioError)
          ? "Error"
          : armed
            ? "Active"
            : "Standby",
      tone: !stats.audio_mic
        ? "idle"
        : stats.audio_error && (isMicError || isGeneralAudioError)
          ? "err"
          : armed
            ? "ok"
            : "idle",
      description: stats.audio_mic
        ? "Capturing voice commentary mixed directly into clips."
        : "Microphone recording is disabled in settings.",
      tech: "Low-latency WASAPI input mixed into AAC stream",
    },
    {
      name: "Clip Saving",
      status: stats.state === "flushing" ? "Writing MP4…" : armed ? "Ready" : "Standby",
      tone: stats.state === "flushing" ? "warn" : armed ? "ok" : "idle",
      description: "Direct pass-through muxer writes MP4 files instantly without re-encoding.",
      tech: `${formatDuration(stats.buffered_seconds)} buffered in RAM · ${formatBytes(stats.ring_bytes)} cached`,
    },
  ];

  return (
    <section className="panel rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between border-b border-[#303744] pb-3">
        <div>
          <h3 className="text-[13px] font-semibold text-[#e8ecf2]">
            Recording Pipeline
          </h3>
          <p className="text-[11px] text-[#a0a9b6] mt-0.5">
            Real-time status of each capture and encoding stage
          </p>
        </div>

        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
            armed
              ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
              : "border border-[#303744] bg-[#222832] text-[#a0a9b6]",
          )}
        >
          {armed ? "Pipeline Healthy" : "Standby"}
        </span>
      </div>

      {/* Simplified 5 Stages */}
      <ol className="space-y-3">
        {stages.map((stage, idx) => (
          <li key={stage.name} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full transition-colors",
                  stage.tone === "ok"
                    ? "bg-emerald-400"
                    : stage.tone === "warn"
                      ? "bg-amber-400 animate-rec"
                      : stage.tone === "err"
                        ? "bg-red-400"
                        : "bg-[#727e90]",
                )}
              />
              {idx < stages.length - 1 && (
                <span
                  className={cn(
                    "mt-1 w-px flex-1",
                    stage.tone === "ok" ? "bg-emerald-500/20" : "bg-[#303744]",
                  )}
                />
              )}
            </div>

            <div className="min-w-0 flex-1 pb-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-[#e8ecf2]">
                  {stage.name}
                </span>
                <span
                  className={cn(
                    "text-[11px] font-medium",
                    stage.tone === "ok"
                      ? "text-emerald-400"
                      : stage.tone === "warn"
                        ? "text-amber-300 font-semibold"
                        : stage.tone === "err"
                          ? "text-red-400 font-semibold"
                          : "text-[#727e90]",
                  )}
                >
                  {stage.status}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-[#a0a9b6] leading-normal">
                {stage.description}
              </p>
            </div>
          </li>
        ))}
      </ol>

      {/* Expandable Technical Details */}
      <div className="border-t border-[#303744] pt-3">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center justify-between w-full text-left font-mono text-[11px] text-[#a0a9b6] hover:text-[#e8ecf2] transition-colors py-1"
        >
          <span>Advanced Diagnostic Details</span>
          <span className="text-[#727e90]">{showAdvanced ? "▲" : "▼"}</span>
        </button>

        {showAdvanced && (
          <div className="mt-3 space-y-2 rounded-lg border border-[#303744] bg-[#161a22] p-3 font-mono text-[10px] text-[#a0a9b6] animate-fade">
            <div className="flex justify-between py-1 border-b border-[#242b36]">
              <span className="text-[#727e90]">GPU Adapter:</span>
              <span className="text-[#e8ecf2] truncate max-w-[200px]">{stats.encoder.adapter_name}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-[#242b36]">
              <span className="text-[#727e90]">Dedicated VRAM:</span>
              <span className="text-[#e8ecf2]">{stats.encoder.dedicated_vram_mb} MB</span>
            </div>
            <div className="flex justify-between py-1 border-b border-[#242b36]">
              <span className="text-[#727e90]">Ring Keyframe Chunks:</span>
              <span className="text-[#e8ecf2]">{stats.ring_frames}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-[#242b36]">
              <span className="text-[#727e90]">Dropped Frames:</span>
              <span className={stats.dropped_frames > 0 ? "text-amber-400" : "text-[#e8ecf2]"}>
                {stats.dropped_frames}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-[#242b36]">
              <span className="text-[#727e90]">DXGI Device Resets:</span>
              <span className={stats.device_resets > 0 ? "text-amber-400" : "text-[#e8ecf2]"}>
                {stats.device_resets}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-[#242b36]">
              <span className="text-[#727e90]">Audio / Video Drift:</span>
              <span className="text-[#e8ecf2]">{stats.audio_drift_ms.toFixed(2)} ms</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-[#727e90]">Recorder Uptime:</span>
              <span className="text-[#e8ecf2]">{formatDuration(stats.uptime_seconds)}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
