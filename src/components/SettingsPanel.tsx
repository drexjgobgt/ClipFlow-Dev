import { useEffect, useMemo, useRef, useState } from "react";
import { clipflow } from "../lib/bridge";
import type {
  AppSettings,
  AudioDevice,
  EngineStats,
  MonitorInfo,
  PowerState,
  UpdateProgress,
} from "../lib/types";
import { formatBytes } from "../lib/format";
import { isIntegratedAdapter } from "../lib/gpu";
import { cn } from "../utils/cn";
import { Row, Toggle } from "./ui";

interface Props {
  settings: AppSettings;
  stats: EngineStats;
  monitors: MonitorInfo[];
  version: string;
  /** Live battery/RAM snapshot for the ECO telemetry row (null = not read yet). */
  power?: PowerState | null;
  onChange: (patch: Partial<AppSettings>) => void;
  onRestartEngine: () => void;
  onOpenFolder: () => void;
  onChooseFolder: () => void;
  updateProgress?: UpdateProgress | null;
  onCheckForUpdates: () => void;
  native: boolean;
}

const BUFFER_PRESETS = [15, 30, 60, 120, 300];
const FPS_PRESETS = [30, 60, 120, 144];
const CLEANUP_PRESETS = [
  { days: 0, label: "Off" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
  { days: 60, label: "60 days" },
];

/**
 * Turns a raw keydown into a global-shortcut accelerator string, or null when
 * the combo is not a valid global hotkey (no modifier, or a modifier key alone).
 */
function acceleratorFromEvent(e: KeyboardEvent): string | null {
  if (e.key === "Escape") return "__cancel__";
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Win");

  const key = e.key;
  if (["Control", "Alt", "Shift", "Meta", "CapsLock", "Tab"].includes(key)) return null;

  let token: string | null = null;
  if (/^[a-z0-9]$/i.test(key)) token = key.toUpperCase();
  else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) token = key.toUpperCase();
  else if (key === " ") token = "Space";
  else return null;

  if (mods.length === 0) return null;
  return [...mods, token].join("+");
}

/** Click-to-record hotkey badge. */
function HotkeyRecorder({
  value,
  recording,
  onStart,
}: {
  value: string;
  recording: boolean;
  onStart: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!recording) return;
    ref.current?.focus();
  }, [recording]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onStart}
      disabled={recording}
      title="Click, then press the new key combination"
      className={cn(
        "relative rounded border px-3 py-1 font-mono text-[11px] font-semibold tracking-wide transition-colors",
        recording
          ? "border-[#2563eb] bg-[#2563eb]/20 text-[#2563eb]"
          : "border-[#bcc5cf] bg-[#f8f9fa] text-[#0f172a] hover:border-[#2563eb]/60 hover:bg-[#eceff2]",
      )}
    >
      {recording ? (
        <>
          <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-rec rounded-full bg-[#2563eb] align-middle" />
          Press keys…
        </>
      ) : (
        value.toUpperCase()
      )}
    </button>
  );
}

export default function SettingsPanel({
  settings,
  stats,
  monitors,
  version,
  power,
  onChange,
  onRestartEngine,
  onOpenFolder,
  onChooseFolder,
  updateProgress,
  onCheckForUpdates,
  native,
}: Props) {
  const [recording, setRecording] = useState<"save" | "toggle" | null>(null);
  const [bitrate, setBitrate] = useState(settings.bitrateKbps);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [scanningDevices, setScanningDevices] = useState(false);

  // Engine value wins while recording; before a start we infer from the active
  // monitor's adapter so the Game Mode copy is correct on an idle iGPU laptop.
  const integrated = useMemo(() => {
    if (stats.integrated_gpu) return true;
    const active =
      monitors.find((m) => m.index === settings.monitorIndex) ??
      monitors.find((m) => m.primary) ??
      monitors[0];
    return isIntegratedAdapter(active?.adapter);
  }, [stats.integrated_gpu, monitors, settings.monitorIndex]);

  useEffect(() => {
    setBitrate(settings.bitrateKbps);
  }, [settings.bitrateKbps]);

  const refreshAudioDevices = async () => {
    setScanningDevices(true);
    try {
      const devs = await clipflow.getAudioInputDevices();
      setAudioDevices(devs);
    } catch {
      // Fallback
    } finally {
      setScanningDevices(false);
    }
  };

  useEffect(() => {
    void refreshAudioDevices();
  }, []);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const accel = acceleratorFromEvent(e);
      if (accel === "__cancel__") {
        setRecording(null);
        return;
      }
      if (!accel) return;
      const patch = recording === "save" ? { hotkeySave: accel } : { hotkeyToggle: accel };
      onChange(patch);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

  const projectedRam =
    (settings.bufferSeconds * settings.bitrateKbps * 1000) / 8 * 1.6;
  // Game Mode caps the *effective* rate without destroying the user's saved
  // preference, so the 30/60 shortcut should highlight what is actually used.
  // Integrated GPUs share the die with the game and are capped harder.
  const integratedCap = integrated ? 30 : 60;
  const effectiveFps = settings.performanceMode
    ? Math.min(settings.targetFps, integratedCap)
    : settings.targetFps;

  return (
    <div className="space-y-4">
      {/* ---------------- 0. Performance & Game Mode ---------------- */}
      <section className="panel rounded-xl p-5 space-y-4 border-[#2563eb]/35">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#d3d9e0] pb-3">
          <div>
            <h3 className="text-[13px] font-semibold text-[#0f172a]">
              Performance &amp; Game Mode
            </h3>
            <p className="text-[11px] text-[#475569] mt-0.5">
              Keeps the recorder out of your game's way. Recommended for Valorant, CS2 and other competitive titles.
            </p>
          </div>
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-700">
            AUDIO + TRIM ALWAYS ON
          </span>
        </div>

        <Row
          label="Game Mode"
          hint={
            integrated
              ? "Integrated GPU detected: caps capture at 720p/30 and runs the capture thread at normal priority so the game always wins a scheduling race."
              : "Caps capture at 1080p/60, uses the speed-first encoder tune, and runs the capture thread at normal priority so the game always wins a scheduling race."
          }
        >
          <Toggle
            on={settings.performanceMode}
            onClick={() => onChange({ performanceMode: !settings.performanceMode })}
          />
        </Row>

        <div className="rounded-lg border border-[#d3d9e0] bg-[#f1f3f5] p-3">
          <div className="text-[11px] font-semibold text-[#0f172a]">
            Want the lightest possible capture?
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-[#475569]">
            Record at 30 FPS instead of 60. Clips stay sharp and audio is untouched, but
            the encoder does half the work. Apply it with the restart button at the
            bottom of Video &amp; Replay Quality.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[30, 60].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onChange({ targetFps: f })}
                className={cn(
                  "rounded border px-2.5 py-1 font-mono text-[11px] transition-colors",
                  effectiveFps === f
                    ? "border-[#2563eb] bg-[#2563eb] text-white font-semibold"
                    : "border-[#d3d9e0] bg-[#eceff2] text-[#475569] hover:text-slate-900",
                )}
              >
                {f} FPS
              </button>
            ))}
          </div>
          {settings.performanceMode && (
            <p className="mt-2 text-[10px] text-[#475569]">
              Effective now: {effectiveFps} FPS. Your saved choice is kept for when Game Mode is off.
            </p>
          )}
        </div>
      </section>

      {/* ---------------- 1. Video & Recording Quality ---------------- */}
      <section className="panel rounded-xl p-5 space-y-4">
        <div className="border-b border-[#d3d9e0] pb-3">
          <h3 className="text-[13px] font-semibold text-[#0f172a]">
            Video & Replay Quality
          </h3>
          <p className="text-[11px] text-[#475569] mt-0.5">
            Configure resolution, buffer size, target frame rate, and hardware encoder
          </p>
        </div>

        <div>
          <Row label="Buffer duration" hint="How many seconds of gameplay are kept in continuous rolling memory.">
            <div className="flex gap-1.5">
              {BUFFER_PRESETS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onChange({ bufferSeconds: s })}
                  className={cn(
                    "rounded border px-2.5 py-1 font-mono text-[11px] transition-colors",
                    settings.bufferSeconds === s
                      ? "border-[#2563eb] bg-[#2563eb] text-white font-semibold"
                      : "border-[#d3d9e0] bg-[#eceff2] text-[#475569] hover:text-slate-900",
                  )}
                >
                  {s >= 60 ? `${s / 60}m` : `${s}s`}
                </button>
              ))}
            </div>
          </Row>

          <Row
            label="Target frame rate"
            hint={
              settings.performanceMode && settings.targetFps > effectiveFps
                ? `Game Mode caps the effective rate at ${effectiveFps} FPS. Your higher preference is kept for when Game Mode is off.`
                : "Paced capture rate with sub-millisecond precision."
            }
          >
            <div className="flex gap-1.5">
              {FPS_PRESETS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => onChange({ targetFps: f })}
                  className={cn(
                    "rounded border px-2.5 py-1 font-mono text-[11px] transition-colors",
                    settings.targetFps === f
                      ? "border-[#2563eb] bg-[#2563eb] text-white font-semibold"
                      : "border-[#d3d9e0] bg-[#eceff2] text-[#475569] hover:text-slate-900",
                  )}
                >
                  {f} FPS
                </button>
              ))}
            </div>
          </Row>

          <Row
            label="Video codec"
            hint="HEVC provides better visual quality at smaller file sizes on supported GPUs."
          >
            <div className="flex gap-1.5">
              {(["h264", "hevc"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onChange({ codec: c })}
                  className={cn(
                    "rounded border px-2.5 py-1 font-mono text-[11px] transition-colors",
                    settings.codec === c
                      ? "border-[#2563eb] bg-[#2563eb] text-white font-semibold"
                      : "border-[#d3d9e0] bg-[#eceff2] text-[#475569] hover:text-slate-900",
                  )}
                >
                  {c === "h264" ? "H.264 (Universal)" : "HEVC / H.265"}
                </button>
              ))}
            </div>
          </Row>

          <Row
            label={`Video bitrate: ${(bitrate / 1000).toFixed(0)} Mb/s`}
            hint={`Estimated memory ceiling: ~${formatBytes(projectedRam)}`}
          >
            <input
              type="range"
              className="cf-range w-44"
              min={3000}
              max={60000}
              step={1000}
              value={bitrate}
              onChange={(e) => setBitrate(Number(e.target.value))}
              onPointerUp={() => onChange({ bitrateKbps: bitrate })}
              onKeyUp={() => onChange({ bitrateKbps: bitrate })}
            />
          </Row>

          <Row label="Source display" hint="Which monitor ClipFlow captures.">
            <select
              value={settings.monitorIndex}
              onChange={(e) => onChange({ monitorIndex: Number(e.target.value) })}
              className="rounded border border-[#d3d9e0] bg-[#e9ecef] px-2.5 py-1.5 text-[11px] text-[#0f172a] outline-none focus:border-[#2563eb]"
            >
              {monitors.map((m) => (
                <option key={m.index} value={m.index} className="bg-[#e9ecef]">
                  {m.name} ({m.width}×{m.height}) {m.primary ? "— Primary" : ""}
                </option>
              ))}
            </select>
          </Row>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#d3d9e0] pt-3">
          <button
            type="button"
            onClick={onRestartEngine}
            className="rounded-lg border border-[#2563eb]/50 bg-[#2563eb]/15 px-3.5 py-1.5 text-[12px] font-semibold text-[#2563eb] transition-colors hover:bg-[#2563eb]/25"
          >
            Apply & Restart Engine
          </button>
          <span className="text-[11px] text-[#475569]">
            Capture settings apply after a restart. Buffer size changes live.
          </span>
        </div>
      </section>

      {/* ---------------- 2. Audio Setup & Diagnostics ---------------- */}
      <section className="panel rounded-xl p-5 space-y-4">
        <div className="border-b border-[#d3d9e0] pb-3">
          <h3 className="text-[13px] font-semibold text-[#0f172a]">
            Audio Setup & Devices
          </h3>
          <p className="text-[11px] text-[#475569] mt-0.5">
            Manage game sound capture and voice commentary recording
          </p>
        </div>

        <div>
          <Row label="Capture game audio" hint="Records game sound and system audio via low-latency loopback.">
            <Toggle
              on={settings.captureSystemAudio}
              onClick={() => onChange({ captureSystemAudio: !settings.captureSystemAudio })}
            />
          </Row>

          {settings.captureSystemAudio && (
            <Row label={`Game audio volume: ${settings.gameVolume}%`}>
              <input
                type="range"
                className="cf-range w-44"
                min={0}
                max={100}
                step={5}
                value={settings.gameVolume}
                onChange={(e) => onChange({ gameVolume: Number(e.target.value) })}
              />
            </Row>
          )}

          <Row label="Capture microphone" hint="Mixes your voice commentary directly into the video clip.">
            <Toggle
              on={settings.captureMicrophone}
              onClick={() => onChange({ captureMicrophone: !settings.captureMicrophone })}
            />
          </Row>

          {settings.captureMicrophone && (
            <>
              <Row
                label="Microphone input device"
                hint="Choose which microphone ClipFlow captures into the clip audio."
              >
                <div className="flex items-center gap-2">
                  <select
                    className="max-w-[240px] truncate rounded border border-[#d3d9e0] bg-[#e9ecef] px-2.5 py-1.5 text-[11px] text-[#0f172a] focus:border-[#2563eb] focus:outline-none"
                    value={settings.micDeviceId || "default"}
                    onChange={(e) => {
                      const val = e.target.value;
                      onChange({ micDeviceId: val === "default" ? null : val });
                    }}
                  >
                    <option value="default">
                      Default ({audioDevices.find((d) => d.isDefault)?.name || "System Default"})
                    </option>
                    {audioDevices.map((dev) => (
                      <option key={dev.id} value={dev.id}>
                        {dev.name} {dev.isDefault ? "(Default)" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void refreshAudioDevices()}
                    title="Rescan microphones"
                    disabled={scanningDevices}
                    className="flex h-7 w-7 items-center justify-center rounded border border-[#d3d9e0] bg-[#eceff2] text-[#475569] transition-colors hover:border-[#2563eb] hover:text-slate-900 disabled:opacity-50"
                  >
                    <svg
                      className={cn("h-3.5 w-3.5", scanningDevices && "animate-spin")}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                      />
                    </svg>
                  </button>
                </div>
              </Row>

              <Row label={`Microphone volume: ${settings.micVolume}%`}>
                <input
                  type="range"
                  className="cf-range w-44"
                  min={0}
                  max={100}
                  step={5}
                  value={settings.micVolume}
                  onChange={(e) => onChange({ micVolume: Number(e.target.value) })}
                />
              </Row>

              <div className="mt-2 rounded-lg border border-[#d3d9e0] bg-[#f1f3f5] p-3 text-[11px] text-[#475569] space-y-1">
                <div className="flex items-center justify-between text-[11px] font-semibold text-[#0f172a]">
                  <span>Audio Health Status</span>
                  <span className={cn(stats.audio_mic ? "text-emerald-700" : "text-[#475569]")}>
                    {stats.audio_mic ? "Mic Active" : "Mic Standby"}
                  </span>
                </div>
                <div className="text-[11px]">
                  Active microphone:{" "}
                  <span className="font-medium text-[#0f172a]">
                    {settings.micDeviceId
                      ? audioDevices.find((d) => d.id === settings.micDeviceId)?.name || "Selected Device"
                      : `Default (${audioDevices.find((d) => d.isDefault)?.name || "System Default"})`}
                  </span>
                </div>
                <p className="text-[10px] text-[#475569] pt-1">
                  If microphone audio is missing, confirm Windows permits desktop applications under Windows Settings &gt; Privacy &amp; security &gt; Microphone.
                </p>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ---------------- 3. Hotkeys & Shortcuts ---------------- */}
      <section className="panel rounded-xl p-5 space-y-4">
        <div className="border-b border-[#d3d9e0] pb-3">
          <h3 className="text-[13px] font-semibold text-[#0f172a]">
            Keyboard Shortcuts
          </h3>
          <p className="text-[11px] text-[#475569] mt-0.5">
            Global hotkeys that function while gaming in borderless and full-screen modes
          </p>
        </div>

        <div>
          <Row label="Save instant replay" hint="Flushes rolling memory buffer to an MP4 video file.">
            <HotkeyRecorder
              value={settings.hotkeySave}
              recording={recording === "save"}
              onStart={() => setRecording("save")}
            />
          </Row>

          <Row label="Start / Pause buffer" hint="Arms or disarms continuous memory recording.">
            <HotkeyRecorder
              value={settings.hotkeyToggle}
              recording={recording === "toggle"}
              onStart={() => setRecording("toggle")}
            />
          </Row>
        </div>
      </section>

      {/* ---------------- 4. Storage & Library ---------------- */}
      <section className="panel rounded-xl p-5 space-y-4">
        <div className="border-b border-[#d3d9e0] pb-3">
          <h3 className="text-[13px] font-semibold text-[#0f172a]">
            Storage & File Management
          </h3>
          <p className="text-[11px] text-[#475569] mt-0.5">
            Configure where clips are saved and manage automatic cleanup
          </p>
        </div>

        <div>
          <Row label="Save location" hint={settings.outputDir}>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onOpenFolder}
                className="rounded border border-[#d3d9e0] bg-[#eceff2] px-3 py-1 text-[11px] font-medium text-[#0f172a] hover:border-[#2563eb]"
              >
                Open Folder
              </button>
              <button
                type="button"
                onClick={onChooseFolder}
                className="rounded border border-[#d3d9e0] bg-[#eceff2] px-3 py-1 text-[11px] font-medium text-[#0f172a] hover:border-[#2563eb]"
              >
                Change Folder
              </button>
            </div>
          </Row>

          <Row label="Organize clips by game" hint="Saves clips into subfolders named after the active game title.">
            <Toggle
              on={settings.organizeByGame}
              onClick={() => onChange({ organizeByGame: !settings.organizeByGame })}
            />
          </Row>

          <Row label="Automatic cleanup" hint="Automatically deletes older clips at startup to conserve drive space.">
            <div className="flex gap-1.5">
              {CLEANUP_PRESETS.map((p) => (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => onChange({ autoCleanupDays: p.days })}
                  className={cn(
                    "rounded border px-2.5 py-1 text-[11px] transition-colors",
                    settings.autoCleanupDays === p.days
                      ? "border-[#2563eb] bg-[#2563eb] text-white font-semibold"
                      : "border-[#d3d9e0] bg-[#eceff2] text-[#475569] hover:text-slate-900",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Row>
        </div>
      </section>

      {/* ---------------- 5. Workflow & Gaming Experience ---------------- */}
      <section className="panel rounded-xl p-5 space-y-4">
        <div className="border-b border-[#d3d9e0] pb-3">
          <h3 className="text-[13px] font-semibold text-[#0f172a]">
            Workflow & Gaming Experience
          </h3>
          <p className="text-[11px] text-[#475569] mt-0.5">
            Configure desktop notifications and background behaviour
          </p>
        </div>

        <div>
          <Row label="Open trimmer after saving" hint="Displays the quick-trim editor immediately after saving a replay.">
            <Toggle
              on={settings.openTrimmerAfterSave}
              onClick={() => onChange({ openTrimmerAfterSave: !settings.openTrimmerAfterSave })}
            />
          </Row>

          <Row label="Privacy mode" hint="Pauses capture and clears buffer whenever a non-game window has focus.">
            <Toggle
              on={settings.privacyPauseWhenUnfocused}
              onClick={() => onChange({ privacyPauseWhenUnfocused: !settings.privacyPauseWhenUnfocused })}
            />
          </Row>

          <Row label="Auto-save on game exit" hint="Saves the last 30s buffer automatically when your game closes.">
            <Toggle
              on={settings.autosaveOnGameExit}
              onClick={() => onChange({ autosaveOnGameExit: !settings.autosaveOnGameExit })}
            />
          </Row>

          <Row label="Play sound on clip save" hint="Plays a subtle audio cue when a replay clip is saved.">
            <Toggle
              on={settings.playSaveSound}
              onClick={() => onChange({ playSaveSound: !settings.playSaveSound })}
            />
          </Row>

          <Row label="Arm buffer on startup" hint="Begins recording to memory automatically when ClipFlow launches.">
            <Toggle
              on={settings.autostartBuffer}
              onClick={() => onChange({ autostartBuffer: !settings.autostartBuffer })}
            />
          </Row>

          <Row label="Launch with Windows" hint="Starts ClipFlow quietly in the system tray on sign-in.">
            <Toggle
              on={settings.launchAtStartup}
              onClick={() => onChange({ launchAtStartup: !settings.launchAtStartup })}
            />
          </Row>

          <Row label="Minimize to system tray" hint="Closing or minimizing keeps ClipFlow running in the background.">
            <Toggle
              on={settings.minimizeToTray}
              onClick={() => onChange({ minimizeToTray: !settings.minimizeToTray })}
            />
          </Row>

          <Row label="Keep window on top" hint="Pins the ClipFlow window above other open applications.">
            <Toggle
              on={settings.alwaysOnTop}
              onClick={() => onChange({ alwaysOnTop: !settings.alwaysOnTop })}
            />
          </Row>
        </div>
      </section>

      {/* ---------------- 6. Adaptive ECO Mode ---------------- */}
      <section className="panel rounded-xl p-5 space-y-4">
        <div className="border-b border-[#d3d9e0] pb-3">
          <h3 className="text-[13px] font-semibold text-[#0f172a]">
            Adaptive Performance (ECO Mode)
          </h3>
          <p className="text-[11px] text-[#475569] mt-0.5">
            Conserve system battery and memory under hardware pressure
          </p>
        </div>

        <div>
          <Row
            label="Enable adaptive resource conservation"
            hint="Temporarily scales down buffer length on low battery or high memory pressure."
          >
            <Toggle
              on={settings.adaptiveEco}
              onClick={() => onChange({ adaptiveEco: !settings.adaptiveEco })}
            />
          </Row>

          {settings.adaptiveEco && (
            <>
              <Row
                label={`Battery trigger threshold: ≤ ${settings.ecoBatteryThresholdPct}%`}
                hint="Enables ECO conservation when battery percentage drops below this value."
              >
                <input
                  type="range"
                  className="cf-range w-44"
                  min={5}
                  max={100}
                  step={5}
                  value={settings.ecoBatteryThresholdPct}
                  onChange={(e) =>
                    onChange({ ecoBatteryThresholdPct: Number(e.target.value) })
                  }
                />
              </Row>
              <Row
                label={`Memory pressure trigger: < ${settings.ecoRamFreeGbs} GiB free`}
                hint="Enables ECO conservation when available system RAM is below this threshold."
              >
                <input
                  type="range"
                  className="cf-range w-44"
                  min={1}
                  max={16}
                  step={1}
                  value={settings.ecoRamFreeGbs}
                  onChange={(e) => onChange({ ecoRamFreeGbs: Number(e.target.value) })}
                />
              </Row>

              <div className="mt-2 rounded-lg border border-[#d3d9e0] bg-[#f1f3f5] p-3 text-[11px]">
                <div className="flex items-center justify-between font-semibold text-[#0f172a]">
                  <span>System Resource Monitor</span>
                  {power ? (
                    <span className={cn(power.onBattery ? "text-amber-700" : "text-emerald-700")}>
                      {power.onBattery ? `Battery ${power.batteryPercent}%` : "AC Power Connected"}
                    </span>
                  ) : (
                    <span className="text-[#475569]">Reading sensors…</span>
                  )}
                </div>
                <div className="mt-1 font-mono text-[11px] text-[#475569]">
                  {power
                    ? `${formatBytes(power.availableRamBytes)} free of ${formatBytes(power.totalRamBytes)} total RAM`
                    : "—"}
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ---------------- 7. Application & Updates ---------------- */}
      <section className="panel rounded-xl p-5 space-y-4">
        <div className="border-b border-[#d3d9e0] pb-3">
          <h3 className="text-[13px] font-semibold text-[#0f172a]">
            Application & Updates
          </h3>
          <p className="text-[11px] text-[#475569] mt-0.5">
            Software release information and local privacy guarantees
          </p>
        </div>

        <div>
          <Row label="Runtime environment" hint="Execution host and window shell platform.">
            <span className="rounded border border-[#d3d9e0] bg-[#eceff2] px-2.5 py-1 font-mono text-[11px] text-[#0f172a]">
              {native ? "Windows Desktop (Tauri Native)" : "Web Preview (Browser Sandbox)"}
            </span>
          </Row>

          <Row label="Installed version" hint="Native Rust core with Tauri v2 framework.">
            <span className="rounded border border-[#d3d9e0] bg-[#eceff2] px-2.5 py-1 font-mono text-[11px] text-[#0f172a]">
              v{version}
            </span>
          </Row>

          <Row
            label="Check for updates at startup"
            hint="Sends one HTTPS request to github.com for the signed release manifest. No telemetry, no identifiers. Off by default — use the button below to check manually."
          >
            <Toggle
              on={settings.checkUpdatesOnStartup}
              onClick={() =>
                onChange({ checkUpdatesOnStartup: !settings.checkUpdatesOnStartup })
              }
              label="Check for updates at startup"
            />
          </Row>

          <Row
            label="Check for updates"
            hint="Automatic updates are temporarily unavailable in this build — the button opens the Releases page so you can download the newest installer."
          >
            <button
              type="button"
              onClick={onCheckForUpdates}
              className="rounded-lg border border-[#2563eb]/40 bg-[#2563eb]/10 px-3.5 py-1.5 text-[12px] font-semibold text-[#2563eb] hover:bg-[#2563eb]/20 transition-colors"
            >
              Check for Updates
            </button>
          </Row>

          {updateProgress && (
            <div className="mt-3 space-y-1.5 rounded-lg border border-[#d3d9e0] bg-[#f1f3f5] p-3">
              <div className="flex items-center justify-between font-mono text-[11px] text-[#475569]">
                <span>
                  {updateProgress.phase === "DOWNLOADING" ? "Downloading update…" : updateProgress.phase}
                </span>
                {updateProgress.total > 0 && (
                  <span>
                    {formatBytes(updateProgress.downloaded)} / {formatBytes(updateProgress.total)}
                  </span>
                )}
              </div>
              {updateProgress.total > 0 && (
                <div className="h-1.5 overflow-hidden rounded-full bg-[#e9ecef]">
                  <div
                    className="h-full bg-[#2563eb] transition-all duration-200"
                    style={{
                      width: `${Math.min(100, (updateProgress.downloaded / updateProgress.total) * 100)}%`,
                    }}
                  />
                </div>
              )}
            </div>
          )}

          <Row label="Exit ClipFlow" hint="Closes all capture pipelines and terminates the background process.">
            <button
              type="button"
              onClick={() => void clipflow.quit()}
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-1.5 text-[11px] font-medium text-red-600 hover:border-red-400 hover:bg-red-500/20"
            >
              Quit Application
            </button>
          </Row>
        </div>
      </section>
    </div>
  );
}
