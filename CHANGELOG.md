# Changelog

All notable changes to **ClipFlow** are documented here. The project follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [1.6.0] - unreleased

### Fixed

- **Saving could leave the engine stuck in "Saving…" forever.** `flush_to_disk` set the engine to `Flushing` and then used `?` on folder creation and the mux, returning *before* restoring the previous state. One disk-full, locked-file or unmounted-folder error left the deck showing "Saving clip to disk…" with the Save button disabled until the engine was restarted — which also dropped the buffer. Every failure path now restores the state and deletes the partial MP4.
- **Longer replay buffers silently delivered less than requested.** `RollingRingBuffer::set_window` changed the time window but never updated the byte ceiling that enforces it, so going 60 s → 300 s kept the 60 s cap (~141 MB at 12 Mbps) and held roughly 96 s. The ceiling is now recomputed from `(window, bitrate)` on every change.
- **Concurrent saves could overwrite each other.** The flush lock lived in the hotkey path only, so a deck save racing `Alt + C` could mux into the same second-resolution filename. The lock now belongs to the engine and covers every entry point (deck, hotkey, tray, auto-save), and filenames get a numeric suffix on collision instead of silently replacing the earlier clip.
- **Tray "Save last 30 s" saved a clip nobody could see.** It wrote the file without building metadata or emitting the save event, so the gallery did not refresh and no confirmation appeared. It now routes through the same shared path as the deck and the hotkey.
- **Clip previews broke after changing the output folder.** The `asset:` protocol scope is a static glob in `tauri.conf.json`, so a library moved to e.g. `D:\Clips` still listed thumbnails (they are data URLs from Rust) while the trimmer's `<video>` refused to load. The scope is now widened at runtime to the configured folder.
- **Settings could be half-applied.** `update_settings` mutated the live settings as it went, so a failure partway through (folder creation, autostart registry, disk full on save) left memory and `settings.json` disagreeing — a new hotkey registered with Windows but never persisted would silently revert on restart. The patch is now applied to a clone and committed only after the save succeeds.
- **Privacy mode leaked audio into the buffer.** The gate cleared the ring, but the audio thread never checked it, and `prune()` anchored audio eviction to the (now empty) video queue — so audio accumulated without bound while the user was alt-tabbed. The audio thread now honours the gate and the ring bounds the audio track independently.
- **Batch operations froze the window.** Deleting, renaming, snapshotting, and enumerating monitors or audio devices ran on the main thread; a batch delete of hundreds of clips locked the whole UI. They now run on the blocking pool.
- **Snapshots overwrote each other.** Two frame grabs from the same clip resolved to the same PNG name and the first was lost; collisions now get a suffix.
- **`CHANGELOG.md` contained corrupted emoji** (broken surrogate pairs from an earlier encoding round-trip), and the file carried a double BOM. Both are cleaned up.

### Changed

- **Update checks are now opt-in.** ClipFlow described itself as having "no background updater" while calling the updater on every launch, which opens an HTTPS connection to GitHub before the user has read anything. The startup probe now defaults to **off** and can be enabled in Settings. README and the bundle description were corrected to match.
- **The window is now single-instance.** The code claimed it, but the plugin was never added, so a second launch fought the first over DXGI Desktop Duplication and failed with a confusing capture error. Launching again now focuses the existing window.

### Known limitation

- **Automatic updates are disabled in this build.** The `TAURI_SIGNING_PRIVATE_KEY` secret does not match the minisign public key embedded in `tauri.conf.json`, so no signed `latest.json` can be produced — every release since v1.4.2 failed at the signing step for this reason. This release ships plain installers with `createUpdaterArtifacts: false`. The **Check for Updates** button now says so plainly and opens the Releases page instead of surfacing a raw plugin error. Recording, saving, trimming and the library are unaffected. Restoring auto-update requires a valid key pair; the steps are documented in [`docs/RELEASE_PROCESS.md`](docs/RELEASE_PROCESS.md), and users on the old key will need one manual reinstall.

### Removed

- **GIF export** — `media/gif.rs` (825 lines, 16 tests) and the `export_clip_gif` command were unreachable from the UI since 1.5.0. Removed together with the `gif` and `color_quant` crates.
- **HUD overlay leftovers** — `set_hud_visible`, `force_topmost`, `set_window_excluded_from_capture`, `hud_enabled` and `hud_position`. The window itself was already gone; these were dead weight that made the overlay look supported.
- **Unused IPC commands** — `read_clip_as_data_url`, `get_system_report`, `get_output_dir`, `show_main_window`, `set_save_hotkey`, `set_toggle_hotkey`. None had a caller.
- **Unused dependencies, features and capabilities** — `once_cell`, `crossbeam-channel`, ten unused `windows` features, the `fs:` permissions and `tauri-plugin-fs` (the frontend never imported it), and the non-existent `trimmer` window from the capability list.

### Tests

- **New ring-buffer suite (15 tests)** covering the logic that decides whether a clip can be saved at all: GOP-aligned eviction, "last N seconds" snapshots, generation isolation, the byte ceiling tracking the window, and audio hygiene. `prune`/`snapshot` previously had **zero** coverage while the removed GIF module had sixteen.
- Rust suite: 43 passing. Frontend: 61 passing. `cargo check` is warning-free.

## [1.5.0] - 2026-10-24

### Performance

- **Game Mode is now the default** — capture is capped at **1080p / 60 FPS**, the hardware encoder is biased toward speed (`CODECAPI_AVEncCommonQuality = 55` + `AVEncCommonQualityVsSpeed = 80`, B-frames off), >1080p monitors are downscaled with the correct aspect ratio, and the video processor runs in `OPTIMAL_SPEED` mode. The 60 FPS cap is now enforced on **every** start path (deck ARM, Apply & Restart, profile switch and hotkey), not just at launch. Clip audio and lossless trimming are unaffected. A toggle in **Settings → Performance & Game Mode** restores native-resolution capture if wanted.
- **Integrated-GPU awareness** — when the capture adapter is an integrated GPU (Intel Iris Xe/UHD, AMD Radeon Graphics), Game Mode tightens automatically to **720p / 30 FPS / 6 Mbps**: the game and the encoder share one chip and its memory bandwidth, so this is the setting that actually protects frame rate. The deck shows "Integrated GPU detected" with the adapter name, and turning Game Mode off still gives full native resolution.
- **Removed the frame-drop sources** — the always-on-top HUD overlay window is gone, gallery cards no longer autoplay a decoded video on hover, GIF export was removed from the trimmer, and the "Simulate GPU Reset" test button is gone.
- **Gentler thread scheduling** — in Game Mode the capture thread runs at `THREAD_PRIORITY_NORMAL` and the audio thread at `NORMAL` (polling at 10 ms) so the game always wins a scheduling race; with Game Mode off they stay at `ABOVE_NORMAL`. Neither uses MMCSS or `TIME_CRITICAL` any more, and the capture loop no longer spin-waits the last 0.4 ms of every frame.
- **No decode spike when a clip is saved** — thumbnails are no longer generated synchronously on the save hotkey. The gallery and Home "Recent Replays" decode them lazily, only while the ClipFlow window is actually visible, and share one cache.
- **Background work goes quiet** — engine stats are emitted at 1 Hz and only while the main window is visible (and one failed emit can no longer kill the heartbeat); the recording pulse animation pauses while the deck is hidden or unfocused; battery/RAM polling runs only when ECO is enabled; foreground focus polling runs only when auto-switch, privacy mode or auto-save-on-exit is enabled, and at 5 s instead of 2 s; per-game folder resolution no longer reads cross-process window titles.
- **Gallery** — thumbnails stay static (click to open the trimmer and decode there), so browsing never competes with the game for the video decoder.

### Changed

- **☀ New soft off-white UI theme** — the whole app (deck, gallery, trimmer, settings, dialogs, toasts) is now a low-glare gray off-white: `#e9ecef` background, `#f8f9fa` cards, `#d3d9e0` borders, dark slate text and a blue accent. Nothing is pure white any more, so long sessions in a dark room are easier on the eyes; focus rings, inputs, sliders and hover states were retuned for contrast.
- **Friendlier home screen** — the technical "Recording Pipeline" card became a plain-language **Performance** card (Game Mode status, capture/encoder/audio health) with diagnostics behind a disclosure.
- **Audio clipping and video trimming remain first-class** — game audio, microphone mixing and keyframe stream-copy trim/split are untouched by the performance work.

### Removed

- HUD overlay window, hover video previews, GIF export and the GPU-reset simulation button.

## [1.4.2] - 2026-08-11

### Added

- **The overlay is now a real control panel** — stays on top of games reliably (`SetWindowPos(HWND_TOPMOST)` after show + a 2 s re-assert in the stats heartbeat, which fixes WebView2 silently dropping the topmost style), is **draggable**anywhere on its surface, and its position **persists across launches** (`settings.hudPosition`, saved throttled on move and exactly on hide).
- **⎙ SAVE from the overlay** — save the instant replay without alt-tabbing: behaves like the hotkey (the deck is never raised, no trimmer opens) with `SAVING… / ✓ SAVED / ✕ FAILED` feedback, dimmed with an explanatory tooltip while the buffer is disarmed or privacy mode is active.
- **▶ ARM / ■ STOP from the overlay** — arm with the persisted capture settings or stop the buffer, no need to open the deck. The HUD now stays up whenever enabled (STANDBY state when disarmed) so it doubles as a control panel; tooltips show your real rebound hotkeys.
- **ℹ Richer pill** — live `buffered/total` seconds, `resolution@fps` and the configured `bitrate` (`· 12Mb/s`, new `bitrate_kbps` in engine stats), plus a PRIV chip while privacy mode is paused.
- **GIF quality overhaul** — each frame now gets its own **frame-accurate 256-colour palette** (per-frame NeuQuant local colour table) instead of one global average, so GIFs keep their colours and the dithering noise mostly disappears. The global palette pool/sample was bumped for the header.

### Removed

- **ECO simulation** — the SIMULATE battery/RAM buttons and injection are gone; the live battery/RAM telemetry row in Settings stays.

## [1.4.1] - 2026-08-11

### Added

- **Batch library management** — multi-select mode (plain click, Ctrl-click, Shift-click ranges and an ALL button) with a contextual bar: favourite / unfavourite, add / remove tags, copy paths as a file drop and bulk delete. Selections span pages and survive through the virtualised grid.
- **Adaptive capture (ECO)** — when battery is low or free RAM is tight, the rolling buffer shrinks to a preset (30 s) with an fps cap and restores itself as soon as conditions clear, live on the running engine (the persisted setting is never touched). Settings shows a live battery/RAM telemetry row and **SIMULATE BATTERY 15% / SIMULATE LOW RAM**buttons so the whole loop is testable on a desktop.
- **GIF export** — the trimmer exports the selection as an animated GIF (160–720 px, 5–30 fps) straight from the clip via Media Foundation + pure-Rust encoding: no ffmpeg, no temp files, two-pass bounded memory.
- **⚡ Probe cache + lazy thumbnails** — the gallery scan keys on (size, mtime) in a persistent cache (`probe_cache.json` in AppData), so a library of thousands of clips rescans as a stat-call walk instead of opening Media Foundation per file. Orphaned entries are pruned and the cache saves atomically (temp-file + rename). Thumbnails decode lazily per visible card with a capped LRU cache.
- **LOAD MORE pagination + infinite scroll** — the gallery renders clips in pages of 60 with a **LOAD MORE · +N / LOAD ALL**fallback row, and auto-loads the next page as you scroll near the bottom (IntersectionObserver sentinel, 480 px pre-load). The page resets when the filter/sort set changes; batch selection still works across unloaded pages.

### Fixed

- **GIFs looked smeared and banded** — bilinear resampling replaces nearest-neighbour and Floyd-Steinberg dithering (NeuQuant's O(1) lookup on the export path) kills the banding on gradients; the palette is sampled from more frames.
- **GIF toast reported wrong numbers** — the export confirmation now shows the real playback fps (100/delay), duration, frame count and file size.
- **The REC HUD appeared inside clips** — the overlay window is excluded from screen capture via `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, so gameplay clips never contain it.

### Tests

- Suite grown to **36 Rust + 61 frontend** (97 total): GIF pixel math (bilinear blends, dithering bounds), probe-cache mechanics (miss persists, hit without rewrite, re-probe on change, orphan pruning, atomic save), ClipMetaStore batch methods, windowing math, privacy-gate and ECO hysteresis.

## [1.3.1] - 2026-08-11

### Performance

- **⚡ Virtualised clip gallery** — the grid now only mounts the rows near the scroll viewport (windowed rendering with an overscan buffer), so a library with thousands of clips keeps a viewport-full of cards in the DOM instead of thousands of `<img>`/`<video>` nodes. The windowing math lives in a pure, unit-tested module (`src/hooks/useVirtualGrid.ts`); row height is measured once and re-measured on column changes; an IntersectionObserver re-windows when the grid becomes visible again.
- **Memoised cards + stable handlers** — `GalleryGrid` and `ClipCard` are memoised and receive `useCallback` handlers directly (the old inline lambda wrappers made the memo never hit), so the 2 s stats poll, toasts and tab switches no longer re-render the whole gallery. `deleteClip` reads `activeClip` through a ref to stay referentially stable.
- **Lazy/async thumbnails** — gallery thumbnails decode off the main thread (`decoding="async"`, `loading="lazy"`) and hover handlers are stable `useCallback`s.

### UX

- **Gallery scroll restored** — opening a clip remembers where you were and closing the trimmer puts the scroll exactly back, even after a trim/split refreshed the list. The gallery is scroll-locked while the modal is up (the overlay is its own scroll container, so the trimmer stays reachable on short windows).
- **Gallery view persists across restarts** — query, game filter, favourites-only, audio-only, tag filter, sort key and compact mode are saved to localStorage and restored on launch (`src/lib/galleryState.ts`, sanitised per-field, corrupt blobs fall back to defaults). A persisted filter pointing at a game/tag that no longer exists falls back gracefully instead of showing an empty library.

### CI

- **CI gates every PR and release** — new `ci.yml` runs `tsc --noEmit`, `vitest` and `vite build` (frontend job) plus `cargo test` (Rust job) on every pull request and push to main, with per-branch concurrency. The release workflow now also runs typecheck + unit tests before publishing — a PR with compile errors can no longer pass (SonarCloud alone was not enough).

### Tests

- Test suite grown from 20 to **43** (8 Rust + 35 frontend): 14 windowing-math tests (`computeVisibleRows`, column/breakpoint and gap helpers) and 9 gallery-state persistence tests (sanitisation, round-trip, corrupt storage).

## [1.3.0] - 2026-08-10

### Added

- **Privacy mode** — with *Privacy mode* on, capture pauses whenever **no game has focus**: the ring buffer is cleared and the engine stops feeding the encoder, so clips can only ever contain gameplay. The gate turns on at startup, when the setting changes, and live via the foreground poll; the deck shows *PRIVACY PAUSED* while active. Saving (hotkey / UI / tray) while paused shows a clear explanation instead of a bare "empty buffer".
- **Game/mic mix balance** — two new sliders (*Game audio %* / *Microphone %*, 0–100) in Settings → Capture Engine, applied per-source in the audio mixer **live, without an engine restart**. The default is byte-identical to the old fixed −3 dB mix.
- **⭐ Favourites + manual tags** — star any clip from its card or the trimmer (gold ★ badge), and add custom tags (`#clutch`, `#fails`…) in the trimmer. New ★ FAVS filter and clickable tag chips in the library. All metadata lives in a private local sidecar (`clip_meta.json` in AppData) — no cloud, no telemetry.

### Fixed

- **Privacy mode could block Alt+C mid-match** — games running elevated or behind anti-cheat deny `OpenProcess` from a non-admin ClipFlow, so the game was "not detected" and privacy stayed paused (empty ring + blocked saves). Foreground detection now resolves the exe through a **process snapshot** (`CreateToolhelp32Snapshot`) that needs no handle to the target, and the gate flipped to an **optimistic default**: pause only when the foreground is positively ClipFlow or the desktop — a failed query keeps recording so Alt+C never breaks.
- **Split at playhead was flaky** — two back-to-back Media Foundation trim sessions raced startup/shutdown and failed in bursts. Splitting now runs as **one native task** (probe duration, two sequential stream-copy trims with a beat between sessions); a failed split cleans up both half-files so no stray `.mp4` lingers.
- **App sluggish with privacy on** — the 2 s foreground poll could flap the gate and wipe the ring buffer repeatedly. The gate now has a **5 s hysteresis window**: a quick alt-tab or detection blip never pauses, clears or spams toasts; turning privacy off un-gates immediately.

### Tests

- First unit-test suite: **8 Rust tests** (`cargo test`) for the split policy (`split_at_seconds`) and collision-free trim naming (`suggested_trim_path`), plus **12 frontend tests** (`npm test`, new vitest setup) for the privacy-gate hysteresis state machine and the optimistic foreground default.

## [1.2.0] - 2026-08-09

### Added

- **Clips tagged with their game** — every save is tagged with the game in the foreground (`cs2`, `eldenring`...). The tag survives restarts because it is derived from the clip's folder, no sidecar files. The gallery gains a per-game **filter dropdown**and each card shows a game badge.
- **Per-game folders** — with *Organize clips by game* on, clips land in `Videos/ClipFlow/<game>/`. The library scan is recursive, so old root clips and new sub-folder clips appear together. Stats and cleanup cover the whole tree.
- **Stats dashboard** — a new **STATS** tab: total clips, storage used, this-week counters, games tagged, plus a per-game breakdown with bytes bars.
- **On-screen REC HUD** — an always-on-top, click-through indicator (● REC · buffered seconds) pinned to the corner of the screen while the buffer is armed. Toggle in Settings → Workflow.
- **✂ Split at playhead** — the trimmer can cut a clip in two at the current frame (two stream-copy trims, no re-encode) with the new **SPLIT AT PLAYHEAD**button.
- **Auto-save on game exit** — when the focused game closes or loses focus (10 s minimum focus, 60 s cooldown), the last 30 s are saved automatically and tagged with the game that just left.

### Fixed

- **Audio capture retries + visible errors** — games holding the audio device in *exclusive mode* made the WASAPI loopback fail with `AUDCLNT_E_DEVICE_IN_USE` and ClipFlow would silently record clips with no audio track. The audio thread now retries every second until the device is free, and the real reason is surfaced on the deck (red *WASAPI loopback* stage in the pipeline + toast on change).
- **Alt+C no longer steals focus from games** — saving with the hotkey used to raise and focus the ClipFlow window, which minimised or paused fullscreen-exclusive games. Now, when a game has focus, the save happens without touching the window and is confirmed with a native Windows toast (toasts don't steal focus). Auto-saves and tray saves never open the trimmer either.

## [1.1.3] - 2026-08-09

### Added

- **Three-tab navigation** — the side rail is now PIPELINE · PROFILES · SETTINGS. The capture profiles moved to their own tab, so Settings no longer scrolls forever.
- **Quick profile switch in the deck** — one-click profile chips (Default / Competitivo / Cine) under the GAME · PROFILE indicator, no Settings needed.
- **Native notification on auto profile switch** — Windows toast when the foreground game changes your capture profile (manual applies stay quiet).
- **Launch at startup** — Settings → Workflow: start ClipFlow hidden to tray at Windows sign-in (registry Run key, kept in sync with the setting).
- **Auto cleanup** — Settings → Workflow: delete clips older than 7/14/30/60 days at every launch to keep the folder tidy.

## [1.1.2] - 2026-08-09

### Added

- **Per-game capture profiles** — make a few generic presets (e.g. *Default*, *Competitivo* with a short buffer, *Cine* with HEVC + long buffer) and map foreground games to them. The buffer window applies live the moment a profile is applied; fps, bitrate and codec apply on the next engine start.
- **Auto-switch by foreground game** — with the toggle on, ClipFlow watches which window has focus and applies the mapped profile automatically (2 s poll, anti-flap cooldown). Unmapped games and the desktop fall back to the *Default* profile. Focus detection is a single cheap Win32 query (`GetForegroundWindow` + process image name), polled off the main thread.
- **Game mapping editor** — Settings → CAPTURE PROFILES: add/rename/delete profiles, and map any executable (e.g. `cs2.exe`) to a profile. The deck shows the current **GAME · PROFILE**chip at a glance.

## [1.1.1] - 2026-08-09

### Added

- **Session counter** in the Instant Replay panel: clips + bytes saved during the current run.
- Release pipeline now ships the **portable exe** on every release (`ClipFlow_vX.Y.Z_Portable.exe`).

### Fixed

- CI release creation permission (`contents: write` at job level) so the pipeline can publish releases automatically.

## [1.1.0] - 2026-08-09

### Added

- **Automatic updates via GitHub Releases** — signed installers (`.sig` + `latest.json`), checked on demand from Settings → About & Updates or silently at launch, with a one-click download & install + restart flow. Still no background updater service.
- **Custom hotkeys** — click the hotkey badge in Settings and press any new combination. Both the *save* (default `Alt+C`) and *arm/disarm* (default `Alt+Shift+C`) shortcuts rebind live and persist across restarts. Combos without a modifier are rejected (Windows reserves bare keys for typing).
- **HEVC (H.265) codec** — new toggle in Settings. Roughly halves file size while keeping hardware encoding (NVENC/AMF/QSV); applies on engine restart.
- **Open in external player** — new `▶` button on gallery cards and in the trimmer to play a clip in your default media player.
- **Rename clips** — inline rename in the trimmer (the header filename becomes editable).
- **PNG snapshots** — `◉ SNAPSHOT PNG` in the trimmer captures the current frame (hardware decode) into the ClipFlow output folder.
- **Gallery sort & filters** — sort by newest/oldest/largest/smallest/longest/shortest, an `♪ AUDIO` filter, and a `▦ COMPACT` grid view.
- **Clear library** — `✕ CLEAR` removes every clip with an explicit confirmation dialog.
- **Save confirmation sound** — the `playSaveSound` setting now actually works: a short locally-generated shutter blip on every flush.
- **Always-on-top** — pin the control deck above full-screen games from Settings.
- **Flush statistics** — the Instant Replay panel tracks last / average / best flush latency for the session.
- **First-run onboarding** — a dismissible overlay teaches the two hotkeys and the output folder on first launch.
- **Check for updates** — manual `RELEASES ↗` button in Settings opens the GitHub Releases page. Still zero background updater, zero telemetry.

### Fixed

- Hotkey validation at startup prevents a corrupt `settings.json` from registering dangerous bare-key shortcuts.
- `Settings` deserialization is now forward-compatible (`#[serde(default)]` on new fields), so existing `settings.json` files survive the upgrade.

## [1.0.0] - 2026-07-20

### Added

- Sub-50 ms instant replay flush (`Alt+C`) from a GPU-encoded rolling ring buffer.
- DXGI Desktop Duplication + Direct3D 11 capture with hardware H.264 MFT encoding (NVENC / AMF / QSV).
- WASAPI system audio loopback + microphone mixing, AAC-LC 48 kHz on a unified QPC clock.
- Key-frame stream-copy trimmer (lossless, no re-encode).
- Tray icon with Capture / Show / Folder / Quit menu.
- Gallery with hover-preview, copy-to-clipboard (CF_HDROP), reveal-in-Explorer and delete.
- Single portable binary, no account, no telemetry, no background updater.
