import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import BufferStatusCard from "./components/BufferStatusCard";
import ClipTrimmerModal from "./components/ClipTrimmerModal";
import GalleryGrid from "./components/GalleryGrid";
import PipelinePanel from "./components/PipelinePanel";
import ProfilesPanel from "./components/ProfilesPanel";
import SettingsPanel from "./components/SettingsPanel";
import StatsPanel from "./components/StatsPanel";
import TitleBar from "./components/TitleBar";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { DEFAULT_SETTINGS, clipflow } from "./lib/bridge";
import { formatBytes, formatDuration, formatRelativeTime } from "./lib/format";
import { loadGalleryState, saveGalleryState, type SortKey } from "./lib/galleryState";
import { PrivacyGateHysteresis, shouldGateForForeground } from "./lib/privacyGate";
import { decideEco, EcoHysteresis } from "./lib/powerPolicy";
import { EMPTY_SELECTION, selectionCount, selectionReducer } from "./lib/selection";
import { playSaveSound } from "./lib/sound";
import { isIntegratedAdapter } from "./lib/gpu";
import { cacheThumbnail, getCachedThumbnail } from "./lib/thumbCache";
import type {
  AppSettings,
  CaptureProfile,
  ClipMetadata,
  ClipSavedPayload,
  EngineStats,
  ForegroundGame,
  MonitorInfo,
  PowerState,
  ProfileMapEntry,
  UpdateProgress,
} from "./lib/types";
import { cn } from "./utils/cn";

const APP_VERSION = "1.6.0";

/**
 * How long the privacy-gate state must stay put before it actually flips the
 * engine. A quick alt-tab (or a one-off foreground-detection blip) never wipes
 * the ring buffer, re-forces an encoder key frame or spams toasts; the ring
 * clear on gate-on still drops any stray desktop frames, so the guarantee
 * holds.
 */
const PRIVACY_HYSTERESIS_MS = 5000;

/**
 * How long the ECO state must hold before the buffer actually shrinks/restores.
 * A momentary free-RAM blip must never churn the rolling window or spam toasts.
 */
const ECO_HYSTERESIS_MS = 6000;

/** Gallery pagination: how many clips each LOAD MORE page reveals. The grid is
 * virtualised on top of this, so even the full library stays DOM-light; the
 * page size just bounds the initial render and scroll extent for thousands of
 * clips. */
const GALLERY_PAGE_SIZE = 60;

const IDLE_STATS: EngineStats = {
  state: "idle",
  encoder: {
    vendor: "unavailable",
    friendly_name: "Not initialised",
    codec: "H.264",
    hardware: false,
    adapter_name: "—",
    dedicated_vram_mb: 0,
  },
  width: 0,
  height: 0,
  target_fps: 60,
  bitrate_kbps: 0,
  performance_mode: true,
  integrated_gpu: false,
  capture_fps: 0,
  buffer_seconds: 60,
  buffered_seconds: 0,
  ring_bytes: 0,
  ring_frames: 0,
  process_rss_bytes: 17 * 1024 * 1024,
  encode_ms_avg: 0,
  gpu_submit_ms_avg: 0,
  dropped_frames: 0,
  device_resets: 0,
  audio_system: true,
  audio_mic: false,
  audio_drift_ms: 0,
  audio_error: null,
  privacy_active: false,
  uptime_seconds: 0,
  last_error: null,
};

type ToastTone = "ok" | "warn" | "err" | "info";
interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

const TONE_STYLES: Record<ToastTone, string> = {
  ok: "border-emerald-500/40 bg-[#f8f9fa] text-[#0f172a] shadow-xl",
  warn: "border-amber-500/40 bg-[#f8f9fa] text-[#0f172a] shadow-xl",
  err: "border-red-500/40 bg-[#f8f9fa] text-[#0f172a] shadow-xl",
  info: "border-[#2563eb]/40 bg-[#f8f9fa] text-[#0f172a] shadow-xl",
};

export default function App() {
  const [stats, setStats] = useState<EngineStats>(IDLE_STATS);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [clips, setClips] = useState<ClipMetadata[]>([]);
  const [loadingClips, setLoadingClips] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"home" | "clips" | "profiles" | "stats" | "settings">("home");
  const [activeClip, setActiveClip] = useState<ClipMetadata | null>(null);
  const [activeFlushMs, setActiveFlushMs] = useState<number | undefined>(undefined);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sessionSaves, setSessionSaves] = useState(0);
  const [sessionBytes, setSessionBytes] = useState(0);
  // Restore the last gallery view (filter / sort / compact) from localStorage.
  const [initialGallery] = useState(loadGalleryState);
  const [query, setQuery] = useState(initialGallery.query);
  const [gameFilter, setGameFilter] = useState<string>(initialGallery.gameFilter);
  const [sortKey, setSortKey] = useState<SortKey>(initialGallery.sortKey);
  const [audioOnly, setAudioOnly] = useState(initialGallery.audioOnly);
  const [favOnly, setFavOnly] = useState(initialGallery.favOnly);
  const [tagFilter, setTagFilter] = useState<string | null>(initialGallery.tagFilter);
  const [compact, setCompact] = useState(initialGallery.compact);
  // LOAD MORE pagination: only the first N filtered clips render; the button
  // reveals more. Resets to the first page whenever the filter set changes.
  const [visibleCount, setVisibleCount] = useState(GALLERY_PAGE_SIZE);
  // Multi-select (batch management): pure reducer, paths keyed by clip path.
  const [selection, dispatchSelection] = useReducer(selectionReducer, EMPTY_SELECTION);
  const [selectMode, setSelectMode] = useState(false);
  const [confirmDeleteSelection, setConfirmDeleteSelection] = useState(false);
  const [tagAction, setTagAction] = useState<"add" | "remove" | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [foreground, setForeground] = useState<ForegroundGame | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [ecoState, setEcoState] = useState<{
    active: boolean;
    reason: "battery" | "ram" | "off";
  } | null>(null);
  // Live battery/RAM snapshot for the Settings telemetry row — polled even
  // when ECO is off so the panel always shows what the machine is doing.
  const [powerNow, setPowerNow] = useState<PowerState | null>(null);
  const [onboarding, setOnboarding] = useState<boolean>(() => {
    try {
      return localStorage.getItem("clipflow.onboarding.seen") !== "1";
    } catch {
      return false;
    }
  });

  const native = clipflow.isTauri();
  const toastId = useRef(0);
  const mainRef = useRef<HTMLElement | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Privacy-gate hysteresis lives in a pure, unit-tested state machine
  // (src/lib/privacyGate.ts): the desired gate flips instantly, but the engine
  // only learns about it after PRIVACY_HYSTERESIS_MS of stability.
  const privacyHysteresis = useRef<PrivacyGateHysteresis | null>(null);
  if (privacyHysteresis.current === null) {
    privacyHysteresis.current = new PrivacyGateHysteresis(PRIVACY_HYSTERESIS_MS);
  }
  const activeProfileIdRef = useRef(activeProfileId);
  activeProfileIdRef.current = activeProfileId;

  // Gallery scroll restore: capture where the user was when the trimmer opens
  // and put it back exactly when it closes — even after a trim/split refreshed
  // the list. Main is scroll-locked while the modal is up (inline style on
  // <main>, so React removes it automatically on unmount) and the gallery
  // can't drift behind the overlay and make the restore fight the user.
  const galleryScroll = useRef<number | null>(null);
  const trimmerWasOpen = useRef(false);

  // Pause the always-running recording pulse while the deck is hidden or
  // unfocused (i.e. while a game owns the screen). On an integrated GPU even
  // the compositor animation competes for the shared memory bandwidth.
  useEffect(() => {
    const sync = () => {
      const idle = document.visibilityState !== "visible" || !document.hasFocus();
      document.documentElement.dataset.deckIdle = idle ? "true" : "false";
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);

  useEffect(() => {
    if (activeClip && !trimmerWasOpen.current) {
      trimmerWasOpen.current = true;
      galleryScroll.current = mainRef.current?.scrollTop ?? null;
    } else if (!activeClip && trimmerWasOpen.current) {
      trimmerWasOpen.current = false;
      const top = galleryScroll.current;
      galleryScroll.current = null;
      if (top != null) {
        // Restore on the next frame so the modal unmount commits first.
        requestAnimationFrame(() => {
          if (mainRef.current) mainRef.current.scrollTop = top;
        });
      }
    }
  }, [activeClip]);

  const pushToast = useCallback((tone: ToastTone, title: string, body?: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, tone, title, body }].slice(-4));
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const refreshClips = useCallback(async () => {
    try {
      // Metadata only: the native probe cache makes this O(files) of stats;
      // thumbnails are decoded lazily per visible card (see GalleryGrid).
      const list = await clipflow.getClips(false);
      setClips(list);
    } catch (e) {
      pushToast("err", "Could not read clips folder", String(e));
    } finally {
      setLoadingClips(false);
    }
  }, [pushToast]);

  // ------------------------------------------------------------- bootstrap
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Read the freshly loaded settings for the cleanup check below — the
      // `settingsRef` still points at the render-time defaults here because
      // React has not re-rendered yet.
      let loaded: AppSettings | null = null;
      try {
        const [s, st, mons] = await Promise.all([
          clipflow.getSettings(),
          clipflow.getStats(),
          clipflow.getMonitors(),
        ]);
        if (cancelled) return;
        loaded = s;
        setSettings(s);
        setStats(st);
        setMonitors(mons);
      } catch {
        /* keep defaults */
      }

      // Auto-cleanup: delete clips older than the configured age (0 = off).
      try {
        const days = loaded?.autoCleanupDays ?? 0;
        if (days > 0) {
          const deleted = await clipflow.cleanupOldClips(days);
          if (deleted > 0) {
            pushToast(
              "warn",
              `Auto-cleanup removed ${deleted} clip${deleted === 1 ? "" : "s"}`,
              `Older than ${days} days — folder is tidy.`,
            );
          }
        }
      } catch {
        /* cleanup is best-effort */
      }
      await refreshClips();

      // Silent update probe — OPT-IN, off by default.
      //
      // ClipFlow's proposition is "no telemetry, no background network", but
      // this used to call `check()` unconditionally on every launch, which made
      // that claim untrue: it opens an HTTPS connection to github.com before
      // the user has read anything. The manual button in Settings always
      // works; this only controls the silent startup probe.
      if (clipflow.isTauri() && loaded?.checkUpdatesOnStartup) {
        try {
          const update = await check();
          if (update && !cancelled) {
            pushToast(
              "info",
              `Update v${update.version} available`,
              "Open Settings → Application & Updates → Check for Updates to install.",
            );
          }
        } catch {
          /* updater unreachable — ignore */
        }
      }

      // In the browser the Rust autostart does not exist — arm the simulated
      // engine so the deck is alive immediately.
      if (!clipflow.isTauri()) {
        try {
          const st = await clipflow.startBuffer(
            DEFAULT_SETTINGS.bufferSeconds,
            DEFAULT_SETTINGS.targetFps,
          );
          if (!cancelled) setStats(st);
        } catch {
          /* ignore */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshClips]);

  // -------------------------------------------------------------- events
  useEffect(() => {
    const offs: Array<() => void> = [];
    let disposed = false;
    const attach = (p: Promise<() => void>) => {
      void p.then((off) => {
        if (disposed) off();
        else offs.push(off);
      });
    };

    attach(Promise.resolve(clipflow.onStats((s) => setStats(s))));
    attach(Promise.resolve(clipflow.onBufferState((s) => setStats(s))));
    attach(
      Promise.resolve(
        clipflow.onClipSaved((payload: ClipSavedPayload) => {
          setClips((prev) => [payload.clip, ...prev.filter((c) => c.path !== payload.clip.path)]);
          setSessionSaves((n) => n + 1);
          setSessionBytes((b) => b + payload.clip.size_bytes);
          if (settingsRef.current.playSaveSound) playSaveSound();
          pushToast(
            "ok",
            `Clip saved in ${payload.flushMs.toFixed(1)} ms`,
            `${payload.clip.file_name} · ${formatDuration(payload.clip.duration_seconds)} · ${formatBytes(
              payload.clip.size_bytes,
            )}`,
          );
          // The Rust side decides: hotkey saves while a game has focus do NOT
          // raise the deck (that would steal focus and minimise the game), so
          // the trimmer must stay closed then. Browser sim falls back to the
          // setting.
          if (payload.openTrimmer ?? settingsRef.current.openTrimmerAfterSave) {
            setActiveClip(payload.clip);
            setActiveFlushMs(payload.flushMs);
          }
        }),
      ),
    );
    attach(
      Promise.resolve(clipflow.onError((msg) => pushToast("err", "Engine error", String(msg)))),
    );
    attach(
      Promise.resolve(
        clipflow.onHotkey((accel) => pushToast("info", `${accel} triggered`)),
      ),
    );

    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, [pushToast]);

  // ------------------------------------------------------------- actions
  const handleSave = useCallback(
    async (maxSeconds?: number) => {
      setBusy(true);
      try {
        const clip = await clipflow.saveInstantReplay(maxSeconds, "ui");
        if (!native) return; // the sim already emitted clip-saved
        setClips((prev) => [clip, ...prev.filter((c) => c.path !== clip.path)]);
        if (settingsRef.current.openTrimmerAfterSave) setActiveClip(clip);
      } catch (e) {
        pushToast("err", "Save failed", String(e));
      } finally {
        setBusy(false);
      }
    },
    [native, pushToast],
  );

  const handleToggle = useCallback(async () => {
    setBusy(true);
    try {
      const armed = stats.state === "buffering" || stats.state === "flushing";
      const next = armed
        ? await clipflow.stopBuffer()
        : await clipflow.startBuffer(settings.bufferSeconds, settings.targetFps);
      setStats(next);
      pushToast(armed ? "warn" : "ok", armed ? "Buffer disarmed" : "Buffer armed", 
        armed ? "Rolling history released from RAM." : `${settings.bufferSeconds}s rolling window is live.`);
    } catch (e) {
      pushToast("err", "Engine failed to start", String(e));
    } finally {
      setBusy(false);
    }
  }, [stats.state, settings.bufferSeconds, settings.targetFps, pushToast]);

  // Browser shim for the global hotkey (Tauri registers the real one in Rust).
  useEffect(() => {
    if (clipflow.isTauri()) return;
    const save = settings.hotkeySave.split("+").map((s) => s.trim().toLowerCase());
    const toggle = settings.hotkeyToggle.split("+").map((s) => s.trim().toLowerCase());
    const onKey = (e: KeyboardEvent) => {
      if (clipflow.isTauri()) return;
      const pressed = (k: string[]) =>
        k.length >= 2 &&
        k.includes("alt") === e.altKey &&
        k.includes("ctrl") === e.ctrlKey &&
        k.includes("shift") === e.shiftKey &&
        k.includes("win") === e.metaKey &&
        k.some((t) => e.key.toLowerCase() === t || e.code.toLowerCase() === t);
      if (pressed(save)) {
        e.preventDefault();
        clipflow.emitLocalHotkey(settings.hotkeySave);
        void handleSave();
      } else if (pressed(toggle)) {
        e.preventDefault();
        clipflow.emitLocalHotkey(settings.hotkeyToggle);
        void handleToggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, handleToggle, settings.hotkeySave, settings.hotkeyToggle]);

  const patchSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        // `update_settings` already applies the live buffer change to the
        // running engine, so a second `setBufferSeconds` round-trip here was
        // pure duplication (two IPC calls per slider move).
        const next = await clipflow.updateSettings(patch);
        setSettings(next);
        // A manual capture tweak means the deck is no longer driven by a
        // profile — drop the active-profile badge until the next apply.
        if (patch.bufferSeconds || patch.targetFps || patch.bitrateKbps || patch.codec) {
          setActiveProfileId(null);
        }
      } catch (e) {
        pushToast("err", "Could not persist settings", String(e));
      }
    },
    [pushToast],
  );

  // ------------------------------------------------- capture profiles
  const applyProfile = useCallback(
    async (
      profileId: string,
      source: "manual" | "auto" = "manual",
      gameExe?: string | null,
    ) => {
      if (busy) return;
      try {
        const prev = settingsRef.current;
        const next = await clipflow.applyProfile(profileId);
        setSettings(next);
        setActiveProfileId(profileId);
        const profile = next.profiles.find((p) => p.id === profileId);
        const needsRestart =
          !!profile &&
          (profile.codec !== prev.codec ||
            profile.bitrateKbps !== prev.bitrateKbps ||
            profile.targetFps !== prev.targetFps);
        pushToast(
          "ok",
          profile ? `${profile.name} profile active` : "Profile applied",
          needsRestart
            ? `Buffer ${next.bufferSeconds}s live — restart the engine for bitrate/codec/fps changes.`
            : `Buffer ${next.bufferSeconds}s · ${next.targetFps} fps · ${(
                next.bitrateKbps / 1000
              ).toFixed(0)} Mb/s · live now`,
        );
        // Native toast only for auto-switches (manual applies already toast in
        // the deck and are usually deliberate, not background activity).
        const exe = gameExe ?? foreground?.exe;
        if (source === "auto" && profile && exe) {
          void clipflow.notify(
            `${profile.name} profile active`,
            `${exe} — buffer ${next.bufferSeconds}s`,
          );
        }
      } catch (e) {
        pushToast("err", "Could not apply profile", String(e));
      }
    },
    [busy, foreground, pushToast],
  );

  const saveProfile = useCallback(
    async (profile: CaptureProfile): Promise<boolean> => {
      try {
        const next = await clipflow.saveProfile(profile);
        setSettings(next);
        pushToast("ok", "Profile saved", `${profile.name || profile.id} · ${profile.bufferSeconds}s buffer`);
        return true;
      } catch (e) {
        pushToast("err", "Could not save profile", String(e));
        return false;
      }
    },
    [pushToast],
  );

  const deleteProfile = useCallback(
    async (profileId: string) => {
      try {
        const next = await clipflow.deleteProfile(profileId);
        setSettings(next);
        setActiveProfileId((cur) => (cur === profileId ? null : cur));
        pushToast("warn", "Profile deleted", profileId);
      } catch (e) {
        pushToast("err", "Could not delete profile", String(e));
      }
    },
    [pushToast],
  );

  const setProfileMap = useCallback(
    async (map: ProfileMapEntry[]) => {
      try {
        const next = await clipflow.setProfileMap(map);
        setSettings(next);
      } catch (e) {
        pushToast("err", "Could not save game mapping", String(e));
      }
    },
    [pushToast],
  );

  const refreshForeground = useCallback(async () => {
    try {
      const game = await clipflow.getForegroundGame();
      setForeground(game);
    } catch {
      /* ignore */
    }
  }, []);

  // Foreground polling is opt-in: it only runs when a feature that actually
  // needs it is on (auto-switch, privacy gate, auto-save on exit) or while the
  // Profiles tab is open. With the defaults, gaming sessions do zero focus
  // queries in the background.
  const needsForegroundPoll =
    settings.autoSwitchProfiles ||
    settings.privacyPauseWhenUnfocused ||
    settings.autosaveOnGameExit ||
    tab === "profiles";
  const applyProfileRef = useRef(applyProfile);
  applyProfileRef.current = applyProfile;
  useEffect(() => {
    if (!needsForegroundPoll) {
      setForeground(null);
      return;
    }
    let cancelled = false;
    let lastFocusedExe: string | null = null;
    let focusedSince = Date.now();
    let lastSwitchExe: string | null = null;
    let lastApplyAt = 0;
    let lastAutosaveAt = 0;

    const tick = async () => {
      if (cancelled) return;
      let game: ForegroundGame | null = null;
      try {
        game = await clipflow.getForegroundGame();
      } catch {
        return;
      }
      if (cancelled) return;
      // Keep the previous reference when the focus is unchanged so the 2 s
      // poll never forces a deck re-render.
      setForeground((prev) => {
        if (!game && !prev) return prev;
        if (game && prev && game.exe === prev.exe && game.title === prev.title) return prev;
        return game;
      });
      const exe = game?.exe ?? "";

      // Auto-save when the focused app leaves (game exit). Independent of
      // profile auto-switching. Needs 10 s of focus (no desktop flicks) and a
      // 60 s cooldown (no clip spam). The clip is tagged with the game that
      // just left, which is why the flush carries `lastFocusedExe`.
      if (
        lastFocusedExe &&
        exe !== lastFocusedExe &&
        settingsRef.current.autosaveOnGameExit
      ) {
        const now = Date.now();
        if (now - focusedSince > 10_000 && now - lastAutosaveAt > 60_000) {
          lastAutosaveAt = now;
          try {
            await clipflow.saveInstantReplay(30, "autosave", lastFocusedExe);
            pushToast(
              "ok",
              "Auto-saved on game exit",
              `${lastFocusedExe} — last 30 s saved`,
            );
          } catch {
            /* buffer not armed — nothing to auto-save */
          }
        }
      }
      // Only reset focusedSince when the focused app actually changes — if we
      // reset on every tick, `now - focusedSince` is always ≤ 2 s and the
      // 10-second stability guard for auto-save on game exit never fires.
      if (exe !== lastFocusedExe) {
        lastFocusedExe = exe;
        focusedSince = Date.now();
      }

      // Privacy mode: gate the engine only when the foreground is *positively*
      // our own deck or the desktop, so the ring is cleared and capture pauses
      // — clips can never contain desktop content. If the foreground query
      // fails (elevated/anti-cheat games deny the query from a non-admin
      // ClipFlow), we keep recording: breaking Alt+C mid-match is worse than
      // an ambiguous frame. Mirrors privacy_should_gate() on the Rust side.
      // Runs AFTER the auto-save check so the last 30 s of a closed game are
      // still flushed before the gate drops the history.
      if (settingsRef.current.privacyPauseWhenUnfocused) {
        // The desired state flips instantly, but the engine only sees it after
        // PRIVACY_HYSTERESIS_MS of stability — a quick alt-tab or a transient
        // detection blip never wipes the ring or spams toasts.
        const desired = shouldGateForForeground(exe);
        const gate = privacyHysteresis.current!.tick(true, desired);
        if (gate !== null) {
          try {
            await clipflow.setPrivacyGate(gate);
            privacyHysteresis.current!.commit(gate);
            pushToast(
              "info",
              gate ? "Privacy mode paused" : "Privacy mode off",
              gate
                ? "No game is focused — nothing is being recorded right now."
                : "Gameplay capture resumed.",
            );
          } catch {
            // Invoke failed — keep the previous gate; the next tick retries.
          }
        }
      } else {
        // Privacy off: un-gate immediately (the machine returns `false` once
        // if a gate was ever armed, then settles to `null`).
        const gate = privacyHysteresis.current!.tick(false, false);
        if (gate !== null) {
          await clipflow.setPrivacyGate(false);
        }
      }

      if (!settingsRef.current.autoSwitchProfiles || !exe) return;
      if (exe === lastSwitchExe) return; // focus unchanged since last poll
      lastSwitchExe = exe;
      const now = Date.now();
      if (now - lastApplyAt < 4000) return; // anti-flap cooldown
      const { profiles, profileMap } = settingsRef.current;
      const entry = profileMap.find((m) => m.exeName.toLowerCase() === exe);
      const target = entry ? profiles.find((p) => p.id === entry.profileId) : null;
      if (target) {
        if (target.id === activeProfileIdRef.current) return;
        lastApplyAt = now;
        await applyProfileRef.current(target.id, "auto", exe);
      } else if (activeProfileIdRef.current && activeProfileIdRef.current !== "default") {
        // Unmapped game / desktop → back to the Default profile.
        const def = profiles.find((p) => p.id === "default");
        if (def) {
          lastApplyAt = now;
          await applyProfileRef.current(def.id, "auto", exe);
        }
      }
    };
    void tick();
    const iv = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [needsForegroundPoll, pushToast]);

  // Adaptive capture (ECO): polled only while ECO is enabled. When it is off
  // there is no background battery/RAM polling at all, which keeps the deck
  // completely quiet during a match.
  const ecoHysteresis = useRef<EcoHysteresis | null>(null);
  if (ecoHysteresis.current === null) {
    ecoHysteresis.current = new EcoHysteresis(ECO_HYSTERESIS_MS);
  }
  const ecoAppliedBuffer = useRef<number | null>(null);
  useEffect(() => {
    if (!settings.adaptiveEco) {
      if (ecoAppliedBuffer.current !== null) {
        ecoAppliedBuffer.current = null;
        void clipflow.setBufferSeconds(settingsRef.current.bufferSeconds);
      }
      setEcoState(null);
      setPowerNow(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      let power: PowerState;
      try {
        power = await clipflow.getPowerState();
      } catch {
        return; // telemetry unavailable — try again next poll
      }
      if (cancelled) return;
      // Live telemetry for the Settings row (object identity preserved when the
      // snapshot is unchanged so the panel skips re-renders on every poll).
      setPowerNow((prev) =>
        prev &&
        prev.onBattery === power.onBattery &&
        prev.batteryPercent === power.batteryPercent &&
        prev.availableRamBytes === power.availableRamBytes &&
        prev.totalRamBytes === power.totalRamBytes
          ? prev
          : power,
      );
      const s = settingsRef.current;
      const decision = decideEco(power, s);
      // Keep the object identity when nothing changed so the deck skips re-renders.
      setEcoState((prev) =>
        prev && prev.active === decision.active && prev.reason === decision.reason
          ? prev
          : { active: decision.active, reason: decision.reason },
      );
      const flip = ecoHysteresis.current!.tick(decision.active);
      const target = decision.active ? decision.ecoBufferSeconds : s.bufferSeconds;
      if (ecoAppliedBuffer.current === target) {
        if (flip !== null) ecoHysteresis.current!.commit(flip);
        return;
      }
      // Either the state just flipped, or the live buffer drifted from the ECO
      // target (e.g. the user changed it in Settings while ECO was active) —
      // re-assert so the chip never lies about what the engine is doing.
      try {
        await clipflow.setBufferSeconds(target);
        ecoAppliedBuffer.current = target;
        if (flip !== null) ecoHysteresis.current!.commit(flip);
        pushToast(
          "info",
          decision.active ? "ECO mode active" : "ECO mode off",
          decision.active
            ? `${decision.reason === "battery" ? "Battery low" : "Low RAM"} — buffer ${decision.ecoBufferSeconds}s live. The ${decision.ecoFps} FPS cap applies after the next engine restart.`
            : `Full ${s.bufferSeconds}s buffer restored.`,
        );
      } catch {
        // invoke failed — the next poll retries
      }
    };
    void tick();
    const iv = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [settings.adaptiveEco, pushToast]);

  const checkForUpdates = useCallback(async () => {
    if (!native) {
      // Browser preview has no updater — fall back to the Releases page.
      await clipflow.openReleasesPage();
      return;
    }
    setBusy(true);
    setUpdateProgress({ phase: "PENDING", downloaded: 0, total: 0 });
    try {
      const update = await check();
      if (!update) {
        setUpdateProgress(null);
        pushToast("ok", "Up to date", `ClipFlow v${APP_VERSION} is the latest release.`);
        return;
      }
      pushToast(
        "info",
        `Update v${update.version} available`,
        "Downloading & installing — ClipFlow will restart.",
      );
      let downloaded = 0;
      const onProgress = (p: DownloadEvent) => {
        if (p.event === "Started") {
          setUpdateProgress({ phase: "DOWNLOADING", downloaded: 0, total: p.data.contentLength ?? 0 });
        } else if (p.event === "Progress") {
          downloaded += p.data.chunkLength;
          setUpdateProgress((prev) =>
            prev
              ? { ...prev, downloaded }
              : { phase: "DOWNLOADING", downloaded, total: 0 },
          );
        } else if (p.event === "Finished") {
          setUpdateProgress({ phase: "INSTALLING", downloaded: 0, total: 0 });
        }
      };
      await update.downloadAndInstall(onProgress);
      setUpdateProgress(null);
      pushToast("ok", "Update installed", "Restarting ClipFlow…");
      await relaunch();
    } catch (e) {
      setUpdateProgress(null);
      // Auto-update is currently unavailable because no signed update manifest
      // is published (see .github/workflows/release.yml). A raw plugin error
      // like "Could not fetch a valid release JSON" tells the user nothing, so
      // explain it and send them to the download page instead.
      pushToast(
        "warn",
        "Automatic updates unavailable",
        "This build cannot update itself. Download the newest installer from the Releases page — recording is unaffected.",
      );
      // Keep the technical detail available without leading with it.
      console.warn("[clipflow] update check failed", e);
      try {
        await clipflow.openReleasesPage();
      } catch {
        /* opener unavailable — the toast already told them what to do */
      }
    } finally {
      setBusy(false);
    }
  }, [native, pushToast]);

  const chooseOutputFolder = useCallback(async () => {
    if (!native) {
      pushToast("info", "Browser preview", "Use the native app to change the output folder.");
      return;
    }
    try {
      const dir = await open({ directory: true, multiple: false, title: "Choose ClipFlow output folder" });
      if (typeof dir === "string" && dir.length > 0) {
        await patchSettings({ outputDir: dir });
        pushToast("ok", "Output folder changed", dir);
      }
    } catch (e) {
      pushToast("err", "Could not change folder", String(e));
    }
  }, [native, patchSettings, pushToast]);

  const restartEngine = useCallback(async () => {
    setBusy(true);
    try {
      await clipflow.stopBuffer();
      const next = await clipflow.startBuffer(settings.bufferSeconds, settings.targetFps);
      setStats(next);
      pushToast("ok", "Engine restarted", `${next.encoder.friendly_name}`);
    } catch (e) {
      pushToast("err", "Restart failed", String(e));
    } finally {
      setBusy(false);
    }
  }, [settings.bufferSeconds, settings.targetFps, pushToast]);

  const openClip = useCallback((clip: ClipMetadata) => {
    setActiveClip(clip);
    setActiveFlushMs(undefined);
    // Opening a clip ends any in-flight batch selection.
    dispatchSelection({ type: "clear" });
    setConfirmDeleteSelection(false);
    setTagAction(null);
  }, []);

  const copyClip = useCallback(
    async (clip: ClipMetadata) => {
      try {
        await clipflow.copyClip(clip.path);
        pushToast(
          "ok",
          native ? "Video copied to clipboard" : "Path copied",
          native ? "Paste it straight into Discord or Explorer." : clip.path,
        );
      } catch (e) {
        pushToast("err", "Clipboard failed", String(e));
      }
    },
    [native, pushToast],
  );

  const revealClip = useCallback(
    async (clip: ClipMetadata) => {
      try {
        await clipflow.revealClip(clip.path);
        if (!native) pushToast("info", "Path copied", clip.path);
      } catch (e) {
        pushToast("err", "Could not open Explorer", String(e));
      }
    },
    [native, pushToast],
  );

  // Read through a ref so `deleteClip` stays referentially stable (the gallery
  // is memoised) — the closure only needs the *current* activeClip at call time.
  const activeClipRef = useRef(activeClip);
  activeClipRef.current = activeClip;
  const deleteClip = useCallback(
    async (clip: ClipMetadata) => {
      try {
        await clipflow.deleteClip(clip.path);
        setClips((prev) => prev.filter((c) => c.path !== clip.path));
        if (activeClipRef.current?.path === clip.path) setActiveClip(null);
        pushToast("warn", "Clip deleted", clip.file_name);
      } catch (e) {
        pushToast("err", "Delete failed", String(e));
      }
    },
    [pushToast],
  );

  const toggleFavorite = useCallback(
    async (clip: ClipMetadata) => {
      const next = !clip.favorite;
      // Optimistic update: the gallery feels instant, the sidecar persists.
      setClips((prev) =>
        prev.map((c) => (c.path === clip.path ? { ...c, favorite: next } : c)),
      );
      setActiveClip((c) => (c && c.path === clip.path ? { ...c, favorite: next } : c));
      try {
        await clipflow.setClipFavorite(clip.path, next);
        pushToast(
          "ok",
          next ? "Added to favourites" : "Removed from favourites",
          clip.title,
        );
      } catch (e) {
        pushToast("err", "Could not update favourite", String(e));
      }
    },
    [pushToast],
  );

  const updateTags = useCallback(
    async (clip: ClipMetadata, tags: string[]) => {
      setClips((prev) =>
        prev.map((c) => (c.path === clip.path ? { ...c, tags } : c)),
      );
      setActiveClip((c) => (c && c.path === clip.path ? { ...c, tags } : c));
      try {
        await clipflow.setClipTags(clip.path, tags);
      } catch (e) {
        pushToast("err", "Could not save tags", String(e));
      }
    },
    [pushToast],
  );

  const saveTrimmed = useCallback(
    async (start: number, end: number) => {
      if (!activeClip) return;
      setBusy(true);
      try {
        const result = await clipflow.trimClip(activeClip.path, start, end, false);
        pushToast(
          "ok",
          `Trimmed in ${result.elapsed_ms.toFixed(0)} ms`,
          `${result.file_name} · ${formatDuration(result.duration_seconds)} · stream copy`,
        );
        setActiveClip(null);
        await refreshClips();
      } catch (e) {
        pushToast("err", "Trim failed", String(e));
      } finally {
        setBusy(false);
      }
    },
    [activeClip, pushToast, refreshClips],
  );

  const renameClip = useCallback(
    async (clip: ClipMetadata, newName: string) => {
      if (!newName.trim() || newName.trim() === clip.file_name) return;
      try {
        const path = await clipflow.renameClip(clip.path, newName.trim());
        const file_name = path.split(/[\\/]/).pop() ?? newName.trim();
        setActiveClip((c) =>
          c?.path === clip.path
            ? {
                ...c,
                path,
                file_name,
                title: file_name.replace(/\.mp4$/i, "").replace(/_/g, " "),
              }
            : c,
        );
        await refreshClips();
        pushToast("ok", "Clip renamed", file_name);
      } catch (e) {
        pushToast("err", "Rename failed", String(e));
      }
    },
    [pushToast, refreshClips],
  );

  const openExternalClip = useCallback(
    async (clip: ClipMetadata) => {
      try {
        await clipflow.openClip(clip.path);
        if (!native) pushToast("info", "No external player in browser preview", clip.path);
      } catch (e) {
        pushToast("err", "Could not open clip", String(e));
      }
    },
    [native, pushToast],
  );

  const splitClip = useCallback(
    async (splitSeconds: number) => {
      if (!activeClip) return;
      setBusy(true);
      try {
        const r = await clipflow.splitClip(activeClip.path, splitSeconds);
        pushToast(
          "ok",
          "Clip split into 2",
          `${r.partA.file_name} · ${r.partB.file_name}`,
        );
        setActiveClip(null);
        await refreshClips();
      } catch (e) {
        pushToast("err", "Split failed", String(e));
      } finally {
        setBusy(false);
      }
    },
    [activeClip, pushToast, refreshClips],
  );

  const snapshotClip = useCallback(
    async (clip: ClipMetadata, pngBase64: string) => {
      try {
        const base = clip.file_name.replace(/\.mp4$/i, "").replace(/_/g, " ");
        const path = await clipflow.snapshotToOutput(pngBase64, base);
        pushToast(
          "ok",
          "Frame saved as PNG",
          native ? path : "Snapshot downloaded",
        );
      } catch (e) {
        pushToast("err", "Snapshot failed", String(e));
      }
    },
    [native, pushToast],
  );

  const clearLibrary = useCallback(async () => {
    setConfirmClear(false);
    setBusy(true);
    try {
      const deleted = await clipflow.deleteAllClips();
      await refreshClips();
      if (activeClip) setActiveClip(null);
      pushToast(
        "warn",
        deleted > 0 ? `Deleted ${deleted} clip${deleted === 1 ? "" : "s"}` : "Library is already empty",
      );
    } catch (e) {
      pushToast("err", "Could not clear library", String(e));
    } finally {
      setBusy(false);
    }
  }, [activeClip, pushToast, refreshClips]);

  // ---------------------------------------------------------------- derived
  const armed = stats.state === "buffering" || stats.state === "flushing";
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A persisted game/tag filter may point at a game or tag that no longer
    // exists (renamed exe, clips deleted) — fall back so the library never
    // looks mysteriously empty after a restart.
    const activeGameFilter =
      gameFilter === "all" || clips.some((c) => c.game === gameFilter) ? gameFilter : "all";
    const activeTagFilter =
      tagFilter && clips.some((c) => c.tags.includes(tagFilter)) ? tagFilter : null;
    const list = clips.filter((c) => {
      const matchesQuery =
        !q || c.title.toLowerCase().includes(q) || c.file_name.toLowerCase().includes(q);
      const matchesAudio = !audioOnly || c.has_audio;
      const matchesGame = activeGameFilter === "all" || c.game === activeGameFilter;
      const matchesFav = !favOnly || c.favorite;
      const matchesTag = !activeTagFilter || c.tags.includes(activeTagFilter);
      return matchesQuery && matchesAudio && matchesGame && matchesFav && matchesTag;
    });
    const sorted = [...list];
    switch (sortKey) {
      case "oldest":
        sorted.sort((a, b) => a.created_unix_ms - b.created_unix_ms);
        break;
      case "largest":
        sorted.sort((a, b) => b.size_bytes - a.size_bytes);
        break;
      case "smallest":
        sorted.sort((a, b) => a.size_bytes - b.size_bytes);
        break;
      case "longest":
        sorted.sort((a, b) => b.duration_seconds - a.duration_seconds);
        break;
      case "shortest":
        sorted.sort((a, b) => a.duration_seconds - b.duration_seconds);
        break;
      default:
        sorted.sort((a, b) => b.created_unix_ms - a.created_unix_ms);
    }
    return sorted;
  }, [clips, query, audioOnly, gameFilter, favOnly, tagFilter, sortKey]);

  // Paginated view handed to the grid: filters produce the full sorted list,
  // but only the first `visibleCount` entries render (LOAD MORE reveals the
  // rest). Batch selection still operates on the FULL filtered list, so a
  // shift-click range can span pages without loading them first.
  const visibleClips = useMemo(
    () => (visibleCount >= filtered.length ? filtered : filtered.slice(0, visibleCount)),
    [filtered, visibleCount],
  );

  // The visible order for shift-click ranges. Kept in a ref so the selection
  // click handler stays referentially stable (the gallery is memoised) while
  // still reading the freshest filter/sort at click time.
  const filteredPathsRef = useRef<string[]>([]);
  filteredPathsRef.current = filtered.map((c) => c.path);

  // ------------------------------------------------------ batch selection
  // Set form for O(1) membership tests in the virtualised grid.
  const selectedSet = useMemo(() => new Set(selection.selected), [selection.selected]);

  const handleCardSelect = useCallback(
    (clip: ClipMetadata, mods: { ctrl: boolean; shift: boolean }) => {
      dispatchSelection({
        type: "click",
        path: clip.path,
        order: filteredPathsRef.current,
        ctrl: mods.ctrl,
        shift: mods.shift,
      });
    },
    [],
  );

  const selectAllVisible = useCallback(() => {
    dispatchSelection({ type: "select-all", order: filteredPathsRef.current });
  }, []);

  const clearSelection = useCallback(() => {
    dispatchSelection({ type: "clear" });
    setConfirmDeleteSelection(false);
    setTagAction(null);
  }, []);

  const deleteSelected = useCallback(async () => {
    const paths = [...selection.selected];
    setConfirmDeleteSelection(false);
    if (paths.length === 0) return;
    setBusy(true);
    try {
      const n = await clipflow.deleteClips(paths);
      const gone = new Set(paths);
      setClips((prev) => prev.filter((c) => !gone.has(c.path)));
      if (activeClipRef.current && gone.has(activeClipRef.current.path)) {
        setActiveClip(null);
      }
      dispatchSelection({ type: "clear" });
      pushToast(
        "warn",
        `Deleted ${n} clip${n === 1 ? "" : "s"}`,
        n === paths.length ? undefined : `Requested ${paths.length}, removed ${n}.`,
      );
    } catch (e) {
      pushToast("err", "Delete failed", String(e));
    } finally {
      setBusy(false);
    }
  }, [selection.selected, pushToast]);

  const setSelectedFavorite = useCallback(
    async (favorite: boolean) => {
      const paths = [...selection.selected];
      if (paths.length === 0) return;
      // Optimistic: the gallery updates instantly, the sidecar persists.
      setClips((prev) =>
        prev.map((c) => (paths.includes(c.path) ? { ...c, favorite } : c)),
      );
      setActiveClip((c) => (c && paths.includes(c.path) ? { ...c, favorite } : c));
      try {
        const n = await clipflow.setClipsFavorite(paths, favorite);
        pushToast(
          "ok",
          favorite ? `Added ${n} to favourites` : `Removed ${n} from favourites`,
        );
      } catch (e) {
        pushToast("err", "Could not update favourites", String(e));
      }
    },
    [selection.selected, pushToast],
  );

  const applyTagToSelection = useCallback(
    async (tag: string, add: boolean) => {
      const clean = tag.trim().slice(0, 24);
      setTagAction(null);
      setTagInput("");
      if (!clean) return;
      const paths = [...selection.selected];
      if (paths.length === 0) return;
      if (add) {
        setClips((prev) =>
          prev.map((c) =>
            paths.includes(c.path) && !c.tags.includes(clean)
              ? { ...c, tags: [...c.tags, clean].slice(0, 12) } // backend caps at MAX_TAGS
              : c,
          ),
        );
      } else {
        setClips((prev) =>
          prev.map((c) =>
            paths.includes(c.path) ? { ...c, tags: c.tags.filter((t) => t !== clean) } : c,
          ),
        );
      }
      try {
        const n = add
          ? await clipflow.addClipsTag(paths, clean)
          : await clipflow.removeClipsTag(paths, clean);
        pushToast(
          "ok",
          add ? `Tagged ${n} clip${n === 1 ? "" : "s"}` : `Removed #${clean} from ${n} clips`,
        );
      } catch (e) {
        pushToast("err", "Could not update tags", String(e));
      }
    },
    [selection.selected, pushToast],
  );

  const copySelectedPaths = useCallback(async () => {
    const paths = [...selection.selected];
    if (paths.length === 0) return;
    try {
      await clipflow.copyClips(paths);
      pushToast(
        "ok",
        native ? "Clips copied to clipboard" : "Paths copied",
        native
          ? "Paste them straight into Discord or Explorer."
          : paths.join("\n"),
      );
    } catch (e) {
      pushToast("err", "Clipboard failed", String(e));
    }
  }, [selection.selected, native, pushToast]);

  // ESC clears the selection / exits select mode, file-manager style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selectionCount(selection) > 0) dispatchSelection({ type: "clear" });
      setSelectMode(false);
      setConfirmDeleteSelection(false);
      setTagAction(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection]);

  const totalBytes = useMemo(
    () => clips.reduce((acc, c) => acc + c.size_bytes, 0),
    [clips],
  );

  const games = useMemo(
    () => [...new Set(clips.map((c) => c.game).filter((g): g is string => !!g))].sort(),
    [clips],
  );

  const allTags = useMemo(
    () => [...new Set(clips.flatMap((c) => c.tags))].sort(),
    [clips],
  );

  // Surface audio capture failures (device busy / exclusive mode) the moment
  // they happen — the old behaviour hid them behind a stderr log line.
  const lastAudioError = useRef<string | null>(null);
  useEffect(() => {
    const cur = stats.audio_error ?? null;
    if (cur === lastAudioError.current) return;
    lastAudioError.current = cur;
    if (cur) {
      pushToast(
        "warn",
        "Audio capture unavailable",
        `${cur} — retrying automatically. Clips save with video only until it recovers.`,
      );
    } else if (settings.captureSystemAudio || settings.captureMicrophone) {
      pushToast("ok", "Audio capture recovered", "System audio is being recorded again.");
    }
  }, [stats.audio_error, settings.captureSystemAudio, settings.captureMicrophone, pushToast]);

  // Persist the gallery view whenever any filter / sort / compact option
  // changes, so reopening the app lands exactly where the user left it.
  useEffect(() => {
    saveGalleryState({ query, gameFilter, sortKey, audioOnly, favOnly, tagFilter, compact });
  }, [query, gameFilter, sortKey, audioOnly, favOnly, tagFilter, compact]);

  // A different filter/sort produces a different result set — jump back to the
  // first page so the new list is explored from the top.
  useEffect(() => {
    setVisibleCount(GALLERY_PAGE_SIZE);
  }, [query, gameFilter, sortKey, audioOnly, favOnly, tagFilter]);

  // Infinite scroll: a sentinel below the grid auto-loads the next page as it
  // nears the viewport bottom (480 px pre-load keeps scrolling smooth). The
  // observer is recreated whenever the filtered total changes so it always
  // compares against the current count; once everything is loaded the sentinel
  // unmounts and the observer disconnects. The LOAD MORE button below stays as
  // the explicit fallback, and the virtualised grid keeps revealed pages
  // DOM-light either way.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setVisibleCount((c) => (c >= filtered.length ? c : c + GALLERY_PAGE_SIZE));
      },
      { rootMargin: "0px 0px 480px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [filtered.length]);

  // The engine reports this while running; before a start we infer it from the
  // capture monitor's adapter so Settings can explain the iGPU cap right away.
  const integratedGpu = useMemo(() => {
    const active =
      monitors.find((m) => m.index === settings.monitorIndex) ??
      monitors.find((m) => m.primary) ??
      monitors[0];
    return isIntegratedAdapter(active?.adapter);
  }, [monitors, settings.monitorIndex]);

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-[#e9ecef] text-[#0f172a]">
      <TitleBar armed={armed} native={native} version={APP_VERSION} />

      {/* Top Desktop Navigation Bar */}
      <nav className="flex h-11 shrink-0 items-center justify-between border-b border-[#d3d9e0] bg-[#f8f9fa] px-5 select-none">
        <div className="flex items-center gap-1">
          {[
            { id: "home" as const, label: "Home" },
            { id: "clips" as const, label: "Clips", count: clips.length },
            { id: "profiles" as const, label: "Profiles" },
            { id: "stats" as const, label: "Statistics" },
            { id: "settings" as const, label: "Settings" },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-[12px] font-semibold transition-all",
                tab === item.id
                  ? "border border-[#2563eb]/40 bg-[#2563eb]/15 text-[#2563eb] shadow-sm"
                  : "text-[#475569] hover:bg-[#eceff2] hover:text-slate-900",
              )}
            >
              <span>{item.label}</span>
              {item.count !== undefined && (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 font-mono text-[10px]",
                    tab === item.id
                      ? "bg-[#2563eb]/25 text-[#2563eb]"
                      : "bg-[#eceff2] text-[#475569]",
                  )}
                >
                  {item.count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2.5 font-mono text-[11px]">
          {foreground && (
            <span
              title={`Focused Game: ${foreground.title}`}
              className="flex items-center gap-1.5 rounded-md border border-[#d3d9e0] bg-[#f8f9fa] px-2.5 py-1 text-[#475569]"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="max-w-[140px] truncate">{foreground.title || foreground.exe}</span>
            </span>
          )}

          <button
            type="button"
            onClick={() => void clipflow.openOutputFolder()}
            title="Open ClipFlow folder in File Explorer"
            className="flex items-center gap-1.5 rounded-md border border-[#d3d9e0] bg-[#f8f9fa] px-2.5 py-1 text-[#475569] hover:border-[#2563eb] hover:text-slate-900 transition-colors"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="1.5">
              <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5H12.5A1.5 1.5 0 0 1 14 6v6.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-8z" />
            </svg>
            <span>Videos\ClipFlow</span>
          </button>
        </div>
      </nav>

      {/* Main View Area */}
      <main
        ref={mainRef}
        className="relative z-10 flex-1 overflow-y-auto"
        style={activeClip ? { overflowY: "hidden" } : undefined}
      >
        {tab === "home" ? (
          /* ================================================== HOME VIEW */
          <div className="mx-auto max-w-[1440px] p-5 space-y-5">
            {/* Friendly Hero Recording Dashboard */}
            <BufferStatusCard
              stats={stats}
              hotkey={settings.hotkeySave}
              busy={busy}
              eco={ecoState}
              onToggle={handleToggle}
              onSave={() => void handleSave()}
              onSelectDuration={(sec) => void patchSettings({ bufferSeconds: sec })}
              onOpenSettings={() => setTab("settings")}
            />

            {/* Split Section: Recent Replays (Left) & Live Pipeline Summary (Right) */}
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
              {/* Recent Replays preview */}
              <div className="panel rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-[#d3d9e0] pb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[13px] font-semibold text-[#0f172a]">Recent Replays</h3>
                    <span className="rounded-full border border-[#d3d9e0] bg-[#eceff2] px-2 py-0.5 font-mono text-[10px] text-[#475569]">
                      {clips.length} total{sessionSaves > 0 ? ` · ${sessionSaves} this session (${formatBytes(sessionBytes)})` : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTab("clips")}
                    className="text-[12px] font-semibold text-[#2563eb] hover:text-[#1d4ed8] transition-colors"
                  >
                    View All Clips →
                  </button>
                </div>

                {clips.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2.5 py-12 text-center">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#d3d9e0] bg-[#eceff2] text-[#475569]">
                      <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.5">
                        <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <div className="text-[13px] font-semibold text-[#0f172a]">
                      Ready for your first clip
                    </div>
                    <p className="max-w-xs text-[12px] text-[#475569] leading-relaxed">
                      Start the buffer above, play your game, and press{" "}
                      <kbd className="rounded border border-[#bcc5cf] bg-[#eceff2] px-1.5 py-0.5 font-mono text-[10px] text-[#0f172a]">
                        {settings.hotkeySave}
                      </kbd>{" "}
                      to save recent gameplay.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {clips.slice(0, 4).map((clip) => (
                      <div
                        key={clip.id}
                        onClick={() => setActiveClip(clip)}
                        className="group relative cursor-pointer rounded-lg border border-[#d3d9e0] bg-[#f1f3f5] overflow-hidden hover:border-[#2563eb]/60 transition-all"
                      >
                        <div className="aspect-video w-full bg-[#e3e7eb] relative">
                          <LazyThumbnail clip={clip} />
                          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent pointer-events-none" />
                          <span className="absolute bottom-1.5 left-2 font-mono text-[10px] text-white bg-black/75 px-1.5 py-0.5 rounded border border-white/10">
                            {formatDuration(clip.duration_seconds)}
                          </span>
                          {clip.has_audio && (
                            <span className="absolute bottom-1.5 right-2 font-mono text-[9px] text-white/90 bg-black/75 px-1 py-0.5 rounded border border-white/10">
                              Audio
                            </span>
                          )}
                          {clip.game && (
                            <span className="absolute top-1.5 left-2 font-mono text-[9px] text-white bg-black/80 px-1.5 py-0.5 rounded border border-white/10">
                              {clip.game.toUpperCase()}
                            </span>
                          )}
                        </div>
                        <div className="p-2.5">
                          <div className="truncate text-[12px] font-medium text-[#0f172a]">{clip.title}</div>
                          <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-[#475569]">
                            <span>{formatRelativeTime(clip.created_unix_ms)}</span>
                            <span>{formatBytes(clip.size_bytes)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Friendly performance summary */}
              <PipelinePanel
                stats={stats}
                performanceMode={settings.performanceMode}
                integratedGpu={stats.integrated_gpu || integratedGpu}
                onTogglePerformanceMode={() =>
                  void patchSettings({ performanceMode: !settings.performanceMode })
                }
                onRestartEngine={() => void restartEngine()}
              />
            </div>
          </div>
        ) : tab === "clips" ? (
          /* ================================================== CLIPS LIBRARY VIEW */
          <div className="mx-auto max-w-[1440px] p-5 space-y-4">
            <section className="space-y-3.5">
              {/* Library Primary Header */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#d3d9e0] pb-3.5">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-[15px] font-semibold tracking-normal text-[#0f172a]">
                    Clip Library
                  </h2>
                  <span className="rounded-full border border-[#d3d9e0] bg-[#eceff2] px-2.5 py-0.5 font-mono text-[10px] text-[#475569]">
                    {clips.length} {clips.length === 1 ? "clip" : "clips"} · {formatBytes(totalBytes)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* Search box */}
                  <div className="relative">
                    <svg
                      className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#475569]"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <circle cx="7" cy="7" r="4.5" />
                      <path d="M10.5 10.5L14 14" />
                    </svg>
                    <input
                      name="clip-filter"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search title, filename…"
                      className="w-52 rounded-lg border border-[#d3d9e0] bg-[#f8f9fa] pl-8 pr-2.5 py-1.5 text-[11px] text-[#0f172a] outline-none placeholder:text-[#475569] focus:border-[#2563eb]"
                    />
                  </div>

                  {/* Game filter */}
                  <select
                    value={gameFilter}
                    onChange={(e) => setGameFilter(e.target.value)}
                    title="Filter by game"
                    className="rounded-lg border border-[#d3d9e0] bg-[#f8f9fa] px-2.5 py-1.5 text-[11px] text-[#0f172a] outline-none transition-colors hover:border-[#bcc5cf] focus:border-[#2563eb]"
                  >
                    <option value="all" className="bg-[#e9ecef]">All Games</option>
                    {games.map((g) => (
                      <option key={g} value={g} className="bg-[#e9ecef]">
                        {g}
                      </option>
                    ))}
                  </select>

                  {/* Sort dropdown */}
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                    title="Sort clips"
                    className="rounded-lg border border-[#d3d9e0] bg-[#f8f9fa] px-2.5 py-1.5 text-[11px] text-[#0f172a] outline-none transition-colors hover:border-[#bcc5cf] focus:border-[#2563eb]"
                  >
                    <option value="newest" className="bg-[#e9ecef]">Newest First</option>
                    <option value="oldest" className="bg-[#e9ecef]">Oldest First</option>
                    <option value="largest" className="bg-[#e9ecef]">Largest Size</option>
                    <option value="smallest" className="bg-[#e9ecef]">Smallest Size</option>
                    <option value="longest" className="bg-[#e9ecef]">Longest Duration</option>
                    <option value="shortest" className="bg-[#e9ecef]">Shortest Duration</option>
                  </select>
                </div>
              </div>

              {/* Secondary Toolbar: Filters & Actions */}
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                {/* Filter toggles */}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setAudioOnly((v) => !v)}
                    title="Only clips with recorded audio track"
                    className={cn(
                      "rounded-lg border px-2.5 py-1 text-[11px] transition-colors",
                      audioOnly
                        ? "border-[#2563eb] bg-[#2563eb]/15 text-[#2563eb] font-semibold"
                        : "border-[#d3d9e0] bg-[#f8f9fa] text-[#475569] hover:text-slate-900",
                    )}
                  >
                    With Audio
                  </button>

                  <button
                    type="button"
                    onClick={() => setFavOnly((v) => !v)}
                    title="Only starred clips"
                    className={cn(
                      "rounded-lg border px-2.5 py-1 text-[11px] transition-colors",
                      favOnly
                        ? "border-amber-400/50 bg-amber-400/15 text-amber-800 font-semibold"
                        : "border-[#d3d9e0] bg-[#f8f9fa] text-[#475569] hover:text-slate-900",
                    )}
                  >
                    ★ Favorites
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectMode((v) => !v);
                      setTagAction(null);
                    }}
                    title="Multi-select mode: click cards to select, Shift/Ctrl for ranges"
                    className={cn(
                      "rounded-lg border px-2.5 py-1 text-[11px] transition-colors",
                      selectMode || selectionCount(selection) > 0
                        ? "border-[#2563eb] bg-[#2563eb]/15 text-[#2563eb] font-semibold"
                        : "border-[#d3d9e0] bg-[#f8f9fa] text-[#475569] hover:text-slate-900",
                    )}
                  >
                    Select Mode
                  </button>

                  <button
                    type="button"
                    onClick={() => setCompact((v) => !v)}
                    title="Toggle compact 4-column grid view"
                    className={cn(
                      "rounded-lg border px-2.5 py-1 text-[11px] transition-colors",
                      compact
                        ? "border-[#bcc5cf] bg-[#eceff2] text-[#0f172a] font-semibold"
                        : "border-[#d3d9e0] bg-[#f8f9fa] text-[#475569] hover:text-slate-900",
                    )}
                  >
                    Compact View
                  </button>
                </div>

                {/* Library management actions */}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void refreshClips()}
                    className="rounded-lg border border-[#d3d9e0] bg-[#f8f9fa] px-2.5 py-1 text-[11px] text-[#475569] hover:border-[#bcc5cf] hover:text-slate-900 transition-colors"
                  >
                    Rescan
                  </button>

                  <button
                    type="button"
                    onClick={() => void clipflow.openOutputFolder()}
                    className="rounded-lg border border-[#d3d9e0] bg-[#f8f9fa] px-2.5 py-1 text-[11px] text-[#475569] hover:border-[#bcc5cf] hover:text-slate-900 transition-colors"
                  >
                    Open Folder
                  </button>

                  <button
                    type="button"
                    onClick={() => setConfirmClear(true)}
                    disabled={clips.length === 0}
                    title="Delete all clips in library"
                    className="rounded-lg border border-red-500/30 bg-[#f8f9fa] px-2.5 py-1 text-[11px] text-red-600/80 hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-700 disabled:opacity-30 transition-colors"
                  >
                    Clear All
                  </button>
                </div>
              </div>

              {/* Batch selection toolbar */}
              {(selectMode || selectionCount(selection) > 0) && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#2563eb]/40 bg-[#e7eef9] px-3.5 py-2">
                  <span className="font-mono text-[11px] font-semibold text-[#2563eb]">
                    {selectionCount(selection)} selected
                  </span>
                  <div className="h-4 w-px bg-[#d3d9e0]" />
                  <button
                    type="button"
                    onClick={() => void setSelectedFavorite(true)}
                    title="Star all selected clips"
                    className="rounded border border-[#d3d9e0] bg-[#eceff2] px-2 py-0.5 text-[11px] text-[#0f172a] hover:text-amber-700"
                  >
                    ★ Star
                  </button>
                  <button
                    type="button"
                    onClick={() => void setSelectedFavorite(false)}
                    title="Unstar all selected clips"
                    className="rounded border border-[#d3d9e0] bg-[#eceff2] px-2 py-0.5 text-[11px] text-[#0f172a] hover:text-slate-900"
                  >
                    ☆ Unstar
                  </button>
                  <button
                    type="button"
                    onClick={() => setTagAction(tagAction === "add" ? null : "add")}
                    title="Add a tag to every selected clip"
                    className={cn(
                      "rounded border px-2 py-0.5 text-[11px] transition-colors",
                      tagAction === "add"
                        ? "border-[#2563eb] bg-[#2563eb]/20 text-[#2563eb]"
                        : "border-[#d3d9e0] bg-[#eceff2] text-[#0f172a] hover:text-slate-900",
                    )}
                  >
                    + Tag
                  </button>
                  <button
                    type="button"
                    onClick={() => setTagAction(tagAction === "remove" ? null : "remove")}
                    title="Remove a tag from every selected clip"
                    className={cn(
                      "rounded border px-2 py-0.5 text-[11px] transition-colors",
                      tagAction === "remove"
                        ? "border-[#2563eb] bg-[#2563eb]/20 text-[#2563eb]"
                        : "border-[#d3d9e0] bg-[#eceff2] text-[#0f172a] hover:text-slate-900",
                    )}
                  >
                    − Tag
                  </button>
                  <button
                    type="button"
                    onClick={() => void copySelectedPaths()}
                    title="Copy paths of selected clips"
                    className="rounded border border-[#d3d9e0] bg-[#eceff2] px-2 py-0.5 text-[11px] text-[#0f172a] hover:text-slate-900"
                  >
                    Copy Paths
                  </button>
                  <button
                    type="button"
                    onClick={selectAllVisible}
                    disabled={selectionCount(selection) >= filtered.length}
                    className="rounded border border-[#d3d9e0] bg-[#eceff2] px-2 py-0.5 text-[11px] text-[#0f172a] hover:text-slate-900 disabled:opacity-40"
                  >
                    Select All
                  </button>

                  {confirmDeleteSelection ? (
                    <span className="flex items-center gap-1.5">
                      <span className="text-[11px] text-red-600">
                        Delete {selectionCount(selection)} clip{selectionCount(selection) === 1 ? "" : "s"}?
                      </span>
                      <button
                        type="button"
                        onClick={() => void deleteSelected()}
                        className="rounded border border-red-500/70 bg-red-500/20 px-2 py-0.5 text-[11px] font-semibold text-red-700 hover:bg-red-500/30"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteSelection(false)}
                        className="rounded border border-[#d3d9e0] bg-[#eceff2] px-2 py-0.5 text-[11px] text-[#475569] hover:text-slate-900"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteSelection(true)}
                      className="rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-600 hover:border-red-400 hover:bg-red-500/20"
                    >
                      Delete
                    </button>
                  )}

                  <div className="flex-1" />

                  {tagAction && (
                    <form
                      className="flex items-center gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void applyTagToSelection(tagInput, tagAction === "add");
                      }}
                    >
                      <input
                        autoFocus
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        placeholder={tagAction === "add" ? "tag to add…" : "tag to remove…"}
                        className="w-32 rounded border border-[#d3d9e0] bg-[#e9ecef] px-2 py-0.5 text-[11px] text-[#0f172a] outline-none placeholder:text-[#475569] focus:border-[#2563eb]"
                      />
                      <button
                        type="submit"
                        className="rounded border border-[#2563eb] bg-[#2563eb] px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-[#1d4ed8]"
                      >
                        Apply
                      </button>
                    </form>
                  )}

                  <button
                    type="button"
                    onClick={clearSelection}
                    title="Deselect all (Esc)"
                    className="rounded border border-[#d3d9e0] bg-[#eceff2] px-2 py-0.5 text-[11px] text-[#475569] hover:text-slate-900"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Tags Filter Row */}
              {allTags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[10px] text-[#475569]">TAGS:</span>
                  {allTags.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTagFilter((cur) => (cur === t ? null : t))}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 font-mono text-[10px] transition-colors",
                        tagFilter === t
                          ? "border-[#2563eb] bg-[#2563eb]/20 text-[#2563eb]"
                          : "border-[#d3d9e0] bg-[#f8f9fa] text-[#475569] hover:text-slate-900",
                      )}
                    >
                      #{t}
                    </button>
                  ))}
                  {tagFilter && (
                    <button
                      type="button"
                      onClick={() => setTagFilter(null)}
                      className="rounded-full border border-[#d3d9e0] bg-[#f8f9fa] px-2 py-0.5 font-mono text-[9px] text-[#475569] hover:text-slate-900"
                    >
                      Clear filter
                    </button>
                  )}
                </div>
              )}

              {/* Virtualized Gallery Grid */}
              <GalleryGrid
                clips={visibleClips}
                loading={loadingClips}
                compact={compact}
                totalClipsCount={clips.length}
                onResetFilters={() => {
                  setQuery("");
                  setGameFilter("all");
                  setAudioOnly(false);
                  setFavOnly(false);
                  setTagFilter(null);
                }}
                selectedPaths={selectedSet}
                selectMode={selectMode}
                onOpen={openClip}
                onSelect={handleCardSelect}
                onCopy={copyClip}
                onReveal={revealClip}
                onOpenExternal={openExternalClip}
                onDelete={deleteClip}
                onToggleFavorite={toggleFavorite}
              />

              {visibleClips.length < filtered.length && (
                <>
                  <div ref={sentinelRef} className="h-px" aria-hidden />
                  <div className="mt-4 flex flex-col items-center gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setVisibleCount((c) => c + GALLERY_PAGE_SIZE)}
                        className="rounded-lg border border-[#2563eb]/40 bg-[#2563eb]/10 px-4 py-2 text-[12px] font-semibold text-[#2563eb] transition-colors hover:bg-[#2563eb]/20"
                      >
                        Load More (+{Math.min(GALLERY_PAGE_SIZE, filtered.length - visibleClips.length)})
                      </button>
                      <button
                        type="button"
                        onClick={() => setVisibleCount(filtered.length)}
                        className="rounded-lg border border-[#d3d9e0] bg-[#f8f9fa] px-3.5 py-2 text-[12px] text-[#475569] hover:text-slate-900"
                      >
                        Load All ({filtered.length})
                      </button>
                    </div>
                    <span className="font-mono text-[10px] text-[#475569]">
                      Showing {visibleClips.length} of {filtered.length} clips
                    </span>
                  </div>
                </>
              )}
            </section>
          </div>
        ) : tab === "profiles" ? (
          /* ================================================== PROFILES VIEW */
          <div className="mx-auto max-w-[1000px] p-5">
            <ProfilesPanel
              settings={settings}
              foreground={foreground}
              activeProfileId={activeProfileId}
              onChange={(p) => void patchSettings(p)}
              onApplyProfile={(id) => void applyProfile(id)}
              onSaveProfile={saveProfile}
              onDeleteProfile={(id) => void deleteProfile(id)}
              onSetProfileMap={(map) => void setProfileMap(map)}
              onRefreshForeground={() => void refreshForeground()}
            />
          </div>
        ) : tab === "stats" ? (
          /* ================================================== STATS VIEW */
          <div className="mx-auto max-w-[1000px] p-5">
            <StatsPanel clips={clips} />
          </div>
        ) : (
          /* ================================================== SETTINGS VIEW */
          <div className="mx-auto max-w-[1000px] p-5">
            <SettingsPanel
              settings={settings}
              stats={stats}
              monitors={monitors}
              version={APP_VERSION}
              native={native}
              power={powerNow}
              onChange={(p) => void patchSettings(p)}
              onRestartEngine={() => void restartEngine()}
              onOpenFolder={() => void clipflow.openOutputFolder()}
              onChooseFolder={() => void chooseOutputFolder()}
              updateProgress={updateProgress}
              onCheckForUpdates={() => void checkForUpdates()}
            />
          </div>
        )}
      </main>

      {/* Toast Notifications — aria-live so screen readers announce them */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "animate-toast pointer-events-auto rounded-xl border px-3.5 py-2.5",
              TONE_STYLES[t.tone],
            )}
          >
            <div className="text-[12px] font-semibold tracking-wide">
              {t.title}
            </div>
            {t.body && (
              <div className="mt-1 break-words text-[11px] text-[#475569]">{t.body}</div>
            )}
          </div>
        ))}
      </div>

      {/* Trimmer Modal */}
      {activeClip && (
        <ClipTrimmerModal
          clip={activeClip}
          flushMs={activeFlushMs}
          busy={busy}
          onClose={() => setActiveClip(null)}
          onCopy={() => copyClip(activeClip)}
          onReveal={() => revealClip(activeClip)}
          onOpenExternal={() => void openExternalClip(activeClip)}
          onRename={(name) => void renameClip(activeClip, name)}
          onSnapshot={(png) => void snapshotClip(activeClip, png)}
          onSplit={(t) => void splitClip(t)}
          onDiscard={async () => {
            await deleteClip(activeClip);
            setActiveClip(null);
          }}
          onSaveTrimmed={saveTrimmed}
          onToggleFavorite={() => toggleFavorite(activeClip)}
          onUpdateTags={(tags) => updateTags(activeClip, tags)}
        />
      )}

      {/* Clear Library Confirmation Dialog */}
      {confirmClear && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4">
          <div
            className="animate-fade fixed inset-0 bg-[#0f172a]/45 backdrop-blur-sm"
            onClick={() => setConfirmClear(false)}
          />
          <div className="animate-pop panel-elevated relative z-10 w-full max-w-sm rounded-xl p-5 border border-[#d3d9e0] bg-[#f8f9fa]">
            <div className="text-[13px] font-semibold tracking-wide text-red-600">
              Delete All Clips?
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-[#475569]">
              This permanently removes all {clips.length} clip{clips.length === 1 ? "" : "s"} from
              the ClipFlow output folder. This action cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="rounded border border-[#d3d9e0] bg-[#eceff2] px-3 py-1.5 text-[11px] text-[#0f172a] hover:text-slate-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void clearLibrary()}
                disabled={busy}
                className="rounded border border-red-500/60 bg-red-500/20 px-3 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-500/30 disabled:opacity-40"
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* First-run Onboarding Dialog */}
      {onboarding && (
        <OnboardingOverlay
          hotkeySave={settings.hotkeySave}
          hotkeyToggle={settings.hotkeyToggle}
          onDismiss={() => {
            setOnboarding(false);
            try {
              localStorage.setItem("clipflow.onboarding.seen", "1");
            } catch {
              /* ignore */
            }
          }}
        />
      )}
    </div>
  );
}

/** Decodes a recent-replay thumbnail only while the deck is visible. */
function LazyThumbnail({ clip }: { clip: ClipMetadata }) {
  const [src, setSrc] = useState<string | null>(
    clip.thumbnail ?? getCachedThumbnail(clip.path) ?? null,
  );
  useEffect(() => {
    setSrc(clip.thumbnail ?? getCachedThumbnail(clip.path) ?? null);
    if (clip.thumbnail) return;
    let cancelled = false;
    const load = () => {
      // Saving happens mid-match with the deck hidden; do not spin up the
      // video decoder until the user actually opens ClipFlow.
      if (document.visibilityState !== "visible") return;
      const cached = getCachedThumbnail(clip.path);
      if (cached) {
        setSrc(cached);
        return;
      }
      void clipflow.getClipThumbnail(clip.path, 1).then((thumb) => {
        if (!cancelled && thumb) {
          cacheThumbnail(clip.path, thumb);
          setSrc(thumb);
        }
      });
    };
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", load);
    };
  }, [clip.path, clip.thumbnail]);

  if (src) {
    return <img src={src} alt={clip.title} className="h-full w-full object-cover" />;
  }
  return (
    <div className="absolute inset-0 grid place-items-center bg-[#eceff2]">
      <span className="font-mono text-[9px] text-[#475569]">CLIP</span>
    </div>
  );
}

/** First-run overlay: teaches the primary shortcuts to new users. */
function OnboardingOverlay({
  hotkeySave,
  hotkeyToggle,
  onDismiss,
}: {
  hotkeySave: string;
  hotkeyToggle: string;
  onDismiss: () => void;
}) {
  const steps = [
    {
      kbd: hotkeySave,
      title: "Save Instant Replay",
      body: "Flushes the hardware-encoded RAM buffer to an MP4 video file in under 50 ms while you stay in your game.",
    },
    {
      kbd: hotkeyToggle,
      title: "Start / Pause Buffer",
      body: "Arms or disarms continuous memory recording. Leave it running while playing; memory cost is under 150 MB.",
    },
    {
      kbd: "Videos\\ClipFlow",
      title: "Saved Locally on Your PC",
      body: "Clips, trims, and snapshots are stored locally in %USERPROFILE%\\Videos\\ClipFlow with zero cloud uploads.",
    },
  ];

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="animate-fade fixed inset-0 bg-[#0f172a]/45 backdrop-blur-sm" />
      <div className="animate-pop panel-elevated relative z-10 w-full max-w-md rounded-xl p-6 border border-[#bcc5cf] bg-[#f8f9fa]">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#eceff2] text-[#2563eb] border border-[#d3d9e0]">
            <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current">
              <path d="M4 3.5v9l8-4.5-8-4.5z" />
            </svg>
          </div>
          <div>
            <div className="text-[15px] font-semibold text-[#0f172a]">
              Welcome to ClipFlow
            </div>
            <div className="text-[12px] text-[#475569]">
              Lightweight instant replay for PC gaming
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-2.5">
          {steps.map((s, i) => (
            <div
              key={s.title}
              className="flex items-start gap-3 rounded-lg border border-[#d3d9e0] bg-[#eceff2] p-3"
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[#bcc5cf] text-[11px] font-semibold text-[#2563eb]">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-[#0f172a]">{s.title}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-[#475569]">{s.body}</div>
              </div>
              <kbd className="shrink-0 rounded border border-[#bcc5cf] bg-[#f8f9fa] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#0f172a]">
                {s.kbd}
              </kbd>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="mt-5 w-full rounded-lg border border-[#2563eb] bg-[#2563eb] py-2.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-[#1d4ed8]"
        >
          Start Clipping
        </button>
      </div>
    </div>
  );
}
