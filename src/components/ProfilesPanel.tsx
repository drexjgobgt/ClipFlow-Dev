import { useState } from "react";
import type {
  AppSettings,
  CaptureProfile,
  ForegroundGame,
  ProfileMapEntry,
} from "../lib/types";
import { cn } from "../utils/cn";
import { Row, Toggle } from "./ui";

interface Props {
  settings: AppSettings;
  foreground: ForegroundGame | null;
  activeProfileId: string | null;
  onChange: (patch: Partial<AppSettings>) => void;
  onApplyProfile: (profileId: string) => void;
  /** Resolves true when the profile was persisted successfully. */
  onSaveProfile: (profile: CaptureProfile) => Promise<boolean>;
  onDeleteProfile: (profileId: string) => void;
  onSetProfileMap: (map: ProfileMapEntry[]) => void;
  onRefreshForeground: () => void;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** One profile row: name, summary, Apply / Edit / Delete. */
function ProfileCard({
  profile,
  active,
  canDelete,
  onApply,
  onEdit,
  onDelete,
}: {
  profile: CaptureProfile;
  active: boolean;
  canDelete: boolean;
  onApply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 transition-colors duration-150",
        active
          ? "border-[#2563eb]/50 bg-[#e3e7eb]"
          : "border-[#d3d9e0] bg-[#f8f9fa] hover:border-[#bcc5cf]",
      )}
    >
      <div className="min-w-0 pr-2">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[#0f172a]">
            {profile.name}
          </span>
          {active && (
            <span className="rounded border border-[#2563eb]/30 bg-[#2563eb]/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide text-[#2563eb]">
              Active
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-[#475569]">
          {profile.bufferSeconds >= 60
            ? `${profile.bufferSeconds / 60}m`
            : `${profile.bufferSeconds}s`}{" "}
          buffer · {profile.targetFps} FPS · {(profile.bitrateKbps / 1000).toFixed(0)} Mb/s ·{" "}
          {profile.codec.toUpperCase()}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onApply}
          className={cn(
            "rounded border px-2.5 py-1 text-[11px] font-medium tracking-wide transition-colors",
            active
              ? "border-[#2563eb]/60 bg-[#2563eb]/20 text-[#2563eb] hover:bg-[#2563eb]/30"
              : "border-[#bcc5cf] bg-[#eceff2] text-[#0f172a] hover:border-[#2563eb] hover:text-slate-900",
          )}
        >
          {active ? "Re-apply" : "Apply"}
        </button>
        <button
          type="button"
          onClick={onEdit}
          title="Edit profile parameters"
          className="rounded border border-[#bcc5cf] bg-[#eceff2] px-2 py-1 text-[11px] text-[#475569] hover:border-[#a9b6c7] hover:text-slate-900"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={!canDelete}
          title="Delete profile"
          className="rounded border border-[#bcc5cf] bg-[#eceff2] px-2 py-1 text-[11px] text-[#475569] hover:border-red-400/50 hover:text-red-600 disabled:opacity-30"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/** Create / edit form for one profile. */
function ProfileEditor({
  profile,
  onSave,
  onCancel,
}: {
  profile: CaptureProfile;
  onSave: (p: CaptureProfile) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [bufferSeconds, setBufferSeconds] = useState(profile.bufferSeconds || 60);
  const [targetFps, setTargetFps] = useState(profile.targetFps || 60);
  const [bitrateKbps, setBitrateKbps] = useState(profile.bitrateKbps || 12_000);
  const [codec, setCodec] = useState<"h264" | "hevc">(profile.codec || "h264");

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({
      id: profile.id || slugify(trimmed) || `profile-${Date.now()}`,
      name: trimmed,
      bufferSeconds,
      targetFps,
      bitrateKbps,
      codec,
    });
  };

  const selectCls =
    "rounded border border-[#d3d9e0] bg-[#e9ecef] px-2 py-1 font-mono text-[11px] text-[#0f172a] outline-none focus:border-[#2563eb]";

  return (
    <div className="mt-2.5 rounded-lg border border-[#bcc5cf] bg-[#f8f9fa] p-3.5">
      <div className="flex items-center gap-2">
        <input
          name="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Profile name (e.g. Competitive FPS)"
          className="flex-1 rounded border border-[#d3d9e0] bg-[#e9ecef] px-2.5 py-1.5 text-[12px] text-[#0f172a] outline-none placeholder:text-[#475569] focus:border-[#2563eb]"
        />
        {profile.id && (
          <span className="shrink-0 font-mono text-[10px] text-[#475569]">
            {profile.id}
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5 font-mono text-[11px] text-[#475569]">
          Buffer
          <select
            name="profile-buffer"
            value={bufferSeconds}
            onChange={(e) => setBufferSeconds(Number(e.target.value))}
            className={selectCls}
          >
            {[15, 30, 60, 120, 300].map((s) => (
              <option key={s} value={s} className="bg-[#e9ecef]">
                {s >= 60 ? `${s / 60}m` : `${s}s`}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 font-mono text-[11px] text-[#475569]">
          FPS
          <select
            name="profile-fps"
            value={targetFps}
            onChange={(e) => setTargetFps(Number(e.target.value))}
            className={selectCls}
          >
            {[30, 60, 120, 144].map((f) => (
              <option key={f} value={f} className="bg-[#e9ecef]">
                {f}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 font-mono text-[11px] text-[#475569]">
          Codec
          <select
            name="profile-codec"
            value={codec}
            onChange={(e) => setCodec(e.target.value as "h264" | "hevc")}
            className={selectCls}
          >
            <option value="h264" className="bg-[#e9ecef]">H.264</option>
            <option value="hevc" className="bg-[#e9ecef]">HEVC (H.265)</option>
          </select>
        </label>

        <label className="flex items-center gap-1.5 font-mono text-[11px] text-[#475569]">
          Bitrate
          <select
            name="profile-bitrate"
            value={bitrateKbps}
            onChange={(e) => setBitrateKbps(Number(e.target.value))}
            className={selectCls}
          >
            {[8_000, 12_000, 20_000, 30_000, 50_000].map((b) => (
              <option key={b} value={b} className="bg-[#e9ecef]">
                {(b / 1000).toFixed(0)} Mb/s
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3.5 flex items-center justify-end gap-2 border-t border-[#d3d9e0] pt-2.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-[#bcc5cf] bg-[#eceff2] px-3 py-1 text-[11px] text-[#475569] hover:text-slate-900"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!name.trim()}
          className="rounded border border-[#2563eb] bg-[#2563eb] px-3 py-1 text-[11px] font-medium text-white hover:bg-[#1d4ed8] disabled:opacity-40"
        >
          Save Profile
        </button>
      </div>
    </div>
  );
}

/** One exe -> profile mapping row in the auto-switch list. */
function MapRow({
  entry,
  index,
  profiles,
  onChange,
  onRemove,
}: {
  entry: ProfileMapEntry;
  index: number;
  profiles: CaptureProfile[];
  onChange: (index: number, next: ProfileMapEntry) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded border border-[#d3d9e0] bg-[#f8f9fa] p-2">
      <input
        value={entry.exeName}
        onChange={(e) => onChange(index, { ...entry, exeName: e.target.value })}
        placeholder="executable.exe (e.g. valorant.exe)"
        className="flex-1 rounded border border-[#d3d9e0] bg-[#e9ecef] px-2 py-1 font-mono text-[11px] text-[#0f172a] outline-none placeholder:text-[#475569] focus:border-[#2563eb]"
      />
      <select
        value={entry.profileId}
        onChange={(e) => onChange(index, { ...entry, profileId: e.target.value })}
        className="rounded border border-[#d3d9e0] bg-[#e9ecef] px-2 py-1 text-[11px] text-[#0f172a] outline-none focus:border-[#2563eb]"
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id} className="bg-[#e9ecef]">
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onRemove(index)}
        title="Remove mapping"
        className="rounded border border-[#bcc5cf] bg-[#eceff2] px-2 py-1 text-[11px] text-[#475569] hover:border-red-400 hover:text-red-600"
      >
        ✕
      </button>
    </div>
  );
}

export default function ProfilesPanel({
  settings,
  foreground,
  activeProfileId,
  onChange,
  onApplyProfile,
  onSaveProfile,
  onDeleteProfile,
  onSetProfileMap,
  onRefreshForeground,
}: Props) {
  const [editing, setEditing] = useState<CaptureProfile | null>(null);

  const addMapRow = () => {
    const firstProfileId = settings.profiles[0]?.id ?? "default";
    const next = [...settings.profileMap, { exeName: "", profileId: firstProfileId }];
    onSetProfileMap(next);
  };

  const removeMapRow = (index: number) => {
    const next = settings.profileMap.filter((_, i) => i !== index);
    onSetProfileMap(next);
  };

  const commitMap = (index: number, entry: ProfileMapEntry) => {
    const next = [...settings.profileMap];
    next[index] = entry;
    onSetProfileMap(next);
  };

  return (
    <section className="panel rounded-xl p-5 space-y-4">
      <div className="border-b border-[#d3d9e0] pb-3">
        <h3 className="text-[13px] font-semibold text-[#0f172a]">
          Game Profiles
        </h3>
        <p className="text-[11px] text-[#475569] mt-0.5">
          Tune buffer duration, FPS, and bitrate presets per game with automatic switching
        </p>
      </div>

      <div className="space-y-1">
        <Row
          label="Auto-switch by focused game"
          hint="Automatically apply mapped profile preset when a game window is focused"
        >
          <Toggle
            on={settings.autoSwitchProfiles}
            onClick={() => onChange({ autoSwitchProfiles: !settings.autoSwitchProfiles })}
            label="Auto-switch profiles"
          />
        </Row>

        <Row
          label="Foreground window"
          hint={foreground ? foreground.title : "Desktop or unmapped window"}
        >
          <div className="flex items-center gap-2">
            <span className="rounded border border-[#bcc5cf] bg-[#f8f9fa] px-2 py-1 font-mono text-[11px] text-[#0f172a]">
              {foreground ? foreground.exe : "—"}
            </span>
            <button
              type="button"
              onClick={onRefreshForeground}
              title="Re-check the focused window now"
              className="rounded border border-[#bcc5cf] bg-[#eceff2] px-2 py-1 text-[11px] text-[#475569] hover:text-slate-900"
            >
              Detect
            </button>
          </div>
        </Row>
      </div>

      <div className="mt-3.5 space-y-2">
        {settings.profiles.map((p) => (
          <ProfileCard
            key={p.id}
            profile={p}
            active={activeProfileId === p.id}
            canDelete={settings.profiles.length > 1}
            onApply={() => onApplyProfile(p.id)}
            onEdit={() => setEditing({ ...p })}
            onDelete={() => onDeleteProfile(p.id)}
          />
        ))}
      </div>

      {editing && (
        <ProfileEditor
          profile={editing}
          onSave={async (p) => {
            const ok = await onSaveProfile(p);
            if (ok) setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      <button
        type="button"
        onClick={() =>
          setEditing({
            id: "",
            name: "",
            bufferSeconds: 60,
            targetFps: 60,
            bitrateKbps: 12_000,
            codec: "h264",
          })
        }
        className="w-full rounded-lg border border-[#bcc5cf] bg-[#eceff2] px-3 py-2 text-[12px] font-medium text-[#0f172a] transition-colors hover:border-[#2563eb]/50 hover:bg-[#bcc5cf]"
      >
        + New Preset
      </button>

      <div className="mt-5 border-t border-[#d3d9e0] pt-3.5">
        <div className="text-[11px] font-semibold tracking-wide text-[#475569]">
          Game Detection Mappings
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-[#475569]">
          Map an executable file name (e.g. <span className="font-mono text-[#0f172a]">valorant.exe</span>) to
          a profile preset.
        </p>

        <div className="mt-3 space-y-2">
          {settings.profileMap.map((m, i) => (
            <MapRow
              key={`${m.exeName}-${i}`}
              entry={m}
              index={i}
              profiles={settings.profiles}
              onChange={commitMap}
              onRemove={removeMapRow}
            />
          ))}
          <button
            type="button"
            onClick={addMapRow}
            className="w-full rounded border border-[#d3d9e0] bg-[#f8f9fa] px-3 py-1.5 text-[11px] text-[#475569] hover:border-[#bcc5cf] hover:text-slate-900"
          >
            + Add Game Mapping
          </button>
        </div>
      </div>
    </section>
  );
}
