# ClipFlow — Audit Teknis & Rekomendasi Fitur

**Versi yang diaudit:** 1.5.0 (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`)
**Commit terakhir:** `9e9a527` — *chore(updater): rotate signing public key for signed auto-updates*
**Tanggal audit:** berdasarkan kondisi working tree saat audit dijalankan
**Sifat audit:** read-only pada saat audit. Implementasi Tahap 1 & sebagian Tahap 2 sudah dieksekusi setelah audit — lihat §20 untuk catatan implementasi, verifikasi, dan koreksi terhadap temuan awal.

---

## 0. Keputusan Produk yang Sudah Dikunci

Enam pertanyaan terbuka pada draf pertama audit ini sudah diputuskan. Keputusan di bawah **final** dan sudah tercermin di seluruh bagian laporan (rekomendasi yang ditolak ditandai eksplisit, bukan dihapus diam-diam).

| # | Pertanyaan | Keputusan | Dampak pada laporan |
| :-- | :--- | :--- | :--- |
| 1 | Nasib GIF export & HUD overlay | **Dihapus keduanya** | QW8 menjadi rencana hapus presisi per-baris. F30 & F38 ditandai "akan DIHAPUS". Test Rust turun 44 → 28. |
| 2 | Kebijakan update check saat startup | **Opt-in, default `false`** (rekomendasi saya, disetujui) | QW7 ditulis ulang dengan alasan penolakan alternatif default-`true`. |
| 3 | Target hardware minimum | **Rekomendasi saya: RAM 8 GB minimum, 4 GB best-effort** | Lihat §19 — batas `ring_cap_mb` dan peringatan UI disesuaikan. |
| 4 | Track audio terpisah | **Tidak dipisah — tetap satu track mix** | HI2 ditandai DITOLAK dengan konsekuensi & pengganti (ST2). F11 tetap "Tidak ada" secara sengaja. |
| 5 | Mesin uji GPU (NVIDIA/AMD/Intel) | **Rekomendasi saya: wajib sebelum menyentuh `recorder.rs`** | Lihat §19 — gate kualitas ditetapkan. |
| 6 | Baseline frame-time in-game | **Rekomendasi saya: wajib diukur di Tahap 1** | Lihat §19 — menjadi gerbang keluar Tahap 1. |

**Prinsip yang dipakai untuk #3, #5, #6:** audit ini tidak boleh menghasilkan klaim performa tanpa baseline. Karena tidak ada mesin uji maupun pengukuran in-game di repo, ketiganya saya rumuskan sebagai **syarat yang harus dipenuhi**, bukan angka yang saya karang.

---

## 1. Executive Summary

ClipFlow adalah aplikasi desktop Windows (Tauri v2 + Rust + React 19) untuk *instant replay*: merekam layar ke ring buffer terenkode di RAM, lalu menyimpannya ke MP4 saat hotkey ditekan. Audit menemukan bahwa **inti produk benar-benar berfungsi dan kualitas teknisnya di atas rata-rata** — pipeline GPU-resident (DXGI Desktop Duplication → `ID3D11VideoProcessor` → hardware MFT → ring buffer `Arc<[u8]>`) adalah desain yang tepat, dan banyak keputusan performa (snapshot pointer-copy, GOP-aligned eviction, lazy thumbnail, heartbeat 1 Hz yang visibility-gated) menunjukkan pematangan yang nyata.

Namun ada **tiga masalah kelas P1 yang terverifikasi dari kode** dan berpotensi merusak kepercayaan pengguna:

1. **Buffer bisa "diam-diam" lebih pendek dari yang dipilih pengguna.** `RollingRingBuffer::set_window()` mengubah jendela waktu tetapi **tidak** memperbarui `hard_byte_cap`. Menambah durasi dari 60 s → 120 s tanpa restart engine membuat cap lama (≈141 MB) menjadi pembatas sebenarnya (≈96 s pada 12 Mbps).
2. **Engine bisa macet permanen di state `Flushing`.** `flush_to_disk()` menetapkan state `Flushing`, lalu memakai `?` pada `create_dir_all` dan `mux_packets_to_mp4` **sebelum** mengembalikan state sebelumnya. Satu kegagalan I/O membuat UI menampilkan "Saving clip to disk…" selamanya dan tombol Save nonaktif sampai engine di-restart.
3. **Path save dari UI tidak memakai `flush_lock`.** `save_instant_replay` (IPC) melewati lock yang hanya dipakai jalur hotkey, sehingga save dari UI dan hotkey dapat berjalan bersamaan dan menulis ke nama file yang sama (resolusi nama = 1 detik).

Selain itu ditemukan satu **kontradiksi klaim privasi**: README dan `tauri.conf.json` menyatakan "no background updater" / "never opens an outbound socket", tetapi `App.tsx` memanggil `check()` (updater) tanpa syarat pada setiap startup — sebuah request HTTPS keluar. Ini bukan celah keamanan, tetapi klaim yang tidak akurat dan berisiko pada reputasi produk yang menjual privasi.

Dari sisi rekayasa: `src/App.tsx` adalah **monolit 2.138 baris** yang memuat lima layar, **34 `useState` + 1 `useReducer`** dan 13 `useEffect`, serta seluruh logika bisnis; ada **permukaan IPC mati** (perintah terdaftar tanpa pemanggil, modul GIF 825 baris tanpa jalur UI, `set_hud_visible` yang bahkan tidak terdaftar); duplikasi logika yang nyata (sanitasi nama file 3×, konstruksi `ClipMetadata` 2×, default settings 2×); dan **celah pengujian pada justru bagian paling kritis** — `RollingRingBuffer::prune/snapshot` tidak punya satu pun unit test, sementara `is_integrated_gpu` punya lima.

**Kesimpulan:** fondasi produk kuat, tetapi ada utang stabilitas dan kejujuran state yang harus ditutup sebelum menambah fitur. Urutan yang direkomendasikan: perbaiki state machine flush + cap buffer (Tahap 1), baru kemudian lakukan dekomposisi UI dan pemangkasan kode mati (Tahap 2), lalu fitur baru (Tahap 3).

**Keputusan produk sudah dikunci (§0):** GIF export dan HUD overlay **dihapus**; update check menjadi **opt-in (default off)**; audio **tetap satu track mix** (tidak dipisah). Dengan begitu QW8 kini berupa rencana hapus per-baris yang siap dieksekusi, dan HI2 (audio terpisah) keluar dari roadmap — digantikan ST2 (kalibrasi drift A/V) yang biayanya jauh lebih rendah untuk masalah yang lebih sering dikeluhkan.

---

## 2. Ringkasan Arsitektur dan Teknologi

### 2.1 Stack (terverifikasi dari manifest)

| Lapisan | Teknologi | Versi (dari manifest/lock) | Bukti |
| :--- | :--- | :--- | :--- |
| Shell desktop | Tauri | crate `tauri` 2.11.5 (lock), `@tauri-apps/api` 2.11.1 | `src-tauri/Cargo.lock`, `node_modules/@tauri-apps/api/package.json` |
| Backend | Rust, edition 2021, MSRV 1.77.2 | — | `src-tauri/Cargo.toml:8-9` |
| Frontend | React + TypeScript | React 19.2.6, TS 5.9.3 | `package.json:20-32` |
| Build | Vite + `vite-plugin-singlefile` | Vite 7.3.2 | `vite.config.ts:13` |
| Styling | Tailwind CSS v4 (`@theme`) | 4.1.17 | `src/index.css:1-25` |
| Test | Vitest (frontend), `cargo test` (Rust) | Vitest 4.1.10 | `vite.config.ts:27-30` |
| Media | Windows Media Foundation, DXGI, D3D11, WASAPI | crate `windows` 0.58.0 | `Cargo.toml:64-99` |

**Catatan versi:** `package.json` menyatakan `react`/`react-dom` `19.2.6` (pin eksak), sedangkan plugin Tauri memakai caret (`^`). Ini berarti `npm ci` reproducible untuk React tetapi tidak untuk plugin. Risiko rendah, tetapi menghilangkan manfaat pinning.

### 2.2 Struktur direktori (nyata)

```
ClipFlow-Dev/
├── src/                         # Frontend React (8.564 baris TS/TSX)
│   ├── App.tsx                  # 2.138 baris — monolit (5 tab + orkestrasi)
│   ├── components/              # 9 file komponen presentasional
│   ├── hooks/useVirtualGrid.ts  # virtualisasi grid + pure windowing math
│   └── lib/                     # bridge IPC, types, policy murni, simEngine
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs               # 357 — setup: tray, hotkey, heartbeat, invoke_handler
│   │   ├── commands.rs          # 1.475 — SEMUA handler IPC
│   │   ├── settings.rs          # 361 — Settings + profil + caps Game Mode
│   │   ├── hotkeys.rs           # 294 — registrasi & jalur Alt+C
│   │   ├── clipmeta.rs          # 300 — sidecar favourite/tags
│   │   ├── foreground.rs        # 145 — deteksi exe foreground
│   │   ├── power.rs             # 68 — telemetri baterai/RAM
│   │   └── media/
│   │       ├── recorder.rs      # 2.627 — capture+encode+ring+mux
│   │       ├── audio.rs         # 824 — WASAPI + AAC
│   │       ├── library.rs       # 955 — scan, probe, thumbnail, trim
│   │       └── gif.rs           # 825 — TIDAK DIPAKAI UI
│   ├── capabilities/default.json
│   └── tauri.conf.json
├── docs/screenshots/            # 2 PNG (sebelum audit)
└── .github/workflows/           # ci.yml, release.yml
```

**Ukuran kode:** Rust **8.249 baris**, frontend **8.564 baris** (dihitung dengan `Get-Content .Count` per file). Rasio seimbang untuk aplikasi desktop media.

### 2.3 Alur kerja utama (terverifikasi)

```
Startup
  └─ AppState::new()  → Settings::load() + seed_default_profiles() + ClipMetaStore::load()
  └─ setup(): tray, hotkey register, autostart registry sync, privacy gate awal
  └─ jika settings.autostart_buffer → engine.start(cfg) di spawn_blocking
  └─ heartbeat 1 Hz: emit EVT_STATS HANYA jika window "main" visible & tidak minimized

Capture (thread "clipflow-capture")
  IDXGIOutputDuplication.AcquireNextFrame
    → ID3D11Texture2D (BGRA) → CopyResource → ID3D11VideoProcessor (BGRA→NV12, scale)
    → IMFTransform.ProcessInput (NVENC/AMF/QSV MFT, zero-copy via IMFDXGIDeviceManager)
    → ProcessOutput → EncodedPacket{Arc<[u8]>, pts, keyframe} → RollingRingBuffer

Audio (thread "clipflow-audio", paralel)
  WASAPI loopback + mic → float mix (permille gain) → AAC MFT → EncodedPacket → ring yang sama

Alt+C (hotkey thread → async task → spawn_blocking)
  flush_lock.try_lock → cek privacy → engine.flush_to_disk
    → ring.snapshot() (pointer-copy, O(n) bukan O(bytes))
    → mux_packets_to_mp4 (IMFSinkWriter pass-through)
    → emit EVT_CLIP_SAVED → (opsional) toast native, BUKAN raise window
```

Desain "hotkey tidak pernah menaikkan window" (`hotkeys.rs:216-252`) adalah keputusan produk yang sangat baik dan sudah benar diimplementasikan.

### 2.4 Integrasi eksternal

- **Tidak ada backend/server.** Tidak ada database, tidak ada API pihak ketiga, tidak ada akun.
- Satu-satunya koneksi keluar: **updater** ke `https://github.com/drexjgobgt/ClipFlow-Dev/releases/latest/download/latest.json` (`tauri.conf.json:66-71`), dipanggil dari `App.tsx:280-293`.
- **Tidak ada file `.env`** di repo (diverifikasi). Variabel environment yang dibaca hanya `APPDATA`, `USERPROFILE`, `TEMP` (bukan secret). Tidak ada API key/token yang perlu dicatat.
- Kunci publik updater (`pubkey` di `tauri.conf.json:67`) adalah kunci **publik** — aman ada di repo. Private key ada di secret CI (`TAURI_SIGNING_PRIVATE_KEY`, `release.yml:60`) dan `.tauri/` di-gitignore. **Konfigurasi secret sudah benar.**

---

## 3. Inventaris Fitur Saat Ini

Legenda status: **Berfungsi** = jalur UI→IPC→Rust lengkap dan terverifikasi dari kode · **Parsial** = ada tetapi dengan batasan/kontrak yang mengejutkan · **UI-only** = tampilan ada, aksi tidak · **Mati** = kode ada tanpa pemanggil.

### 3.1 Capture & Rekaman

| # | Fitur | Status | Bukti / catatan |
| :-- | :--- | :--- | :--- |
| F1 | Rolling ring buffer di RAM (terenkode) | **Berfungsi** | `recorder.rs:368-515`; eviction GOP-aligned |
| F2 | Flush ke MP4 via hotkey `Alt+C` | **Berfungsi** | `hotkeys.rs:112-262` |
| F3 | Arm/disarm buffer via `Alt+Shift+C` | **Berfungsi** | `hotkeys.rs:264-293` |
| F4 | Arm/disarm dari deck | **Berfungsi** | `App.tsx:385-400`, `BufferStatusCard.tsx:267-280` |
| F5 | Game Mode (cap 1080p/60 + tuning encoder) | **Berfungsi** | `settings.rs:279-289`, `recorder.rs:1590-1605` |
| F6 | Deteksi iGPU → cap 720p/30/6 Mbps | **Berfungsi** | `recorder.rs:604-618, 2110-2120`; 5 unit test |
| F7 | Auto-recovery device lost (TDR/resolusi berubah) | **Berfungsi** | `recorder.rs:2268-2281`, backoff 40→2000 ms |
| F8 | Audio sistem (WASAPI loopback) + mix volume live | **Berfungsi** | `audio.rs:514-...`; gain permille live |
| F9 | Mikrofon + pemilihan device | **Berfungsi** | `audio.rs:40-178`, `commands.rs:1260-1262` |
| F10 | Retry otomatis device audio (1 s) | **Berfungsi** | `audio.rs:578-607` |
| F11 | Game audio + mic sebagai **dua track terpisah** | **Tidak ada** | Di-mix ke satu track AAC (`audio.rs` header, `recorder.rs:1968-1998`) |
| F12 | "Save last N seconds" dari deck (bukan full buffer) | **Tidak ada** | Deck hanya `saveInstantReplay()` tanpa `maxSeconds` (`App.tsx:372`) |
| F13 | Hotkey khusus "save last 30 s" | **Tidak ada** | Hanya tray item (`lib.rs:284-301`) |
| F14 | Simpan buffer saat disk penuh → gagal aman | **Parsial** | Error dikembalikan, tapi file parsial tertinggal + state macet (lihat B1) |

### 3.2 Library & Editing

| # | Fitur | Status | Bukti / catatan |
| :-- | :--- | :--- | :--- |
| F15 | Scan library + probe cache persisten | **Berfungsi** | `library.rs:61-87, 248-280`; atomic write |
| F16 | Thumbnail lazy per kartu + LRU 400 | **Berfungsi** | `GalleryGrid.tsx:88-124`, `thumbCache.ts` |
| F17 | Thumbnail **persisten antar sesi** | **Tidak ada** | Cache hanya `Map` in-memory; decode ulang tiap launch |
| F18 | Trim lossless (stream copy, keyframe-accurate) | **Berfungsi** | `library.rs:534-667` |
| F19 | Split di playhead (2 potongan, satu task) | **Berfungsi** | `commands.rs:432-473` |
| F20 | Snapshot frame → PNG | **Berfungsi** | `commands.rs:664-711`; **menimpa file** bernama sama |
| F21 | Rename + migrasi sidecar | **Berfungsi** | `commands.rs:531-558`, `clipmeta.rs:155-160` |
| F22 | Favorit & tag (single + batch) | **Berfungsi** | `clipmeta.rs`; 7 unit test |
| F23 | Multi-select (Ctrl/Shift/range) + batch delete/tag/copy | **Berfungsi** | `selection.ts` + 103 baris test |
| F24 | Pencarian, filter game/audio/favorit/tag, 6 sort | **Berfungsi** | `App.tsx:1048-1087` |
| F25 | Pagination 60 + infinite scroll + virtualisasi | **Berfungsi** | `App.tsx:1298-1311`, `useVirtualGrid.ts` |
| F26 | Copy file ke clipboard (CF_HDROP multi-file) | **Berfungsi** | `commands.rs:1349-1425` |
| F27 | Auto-cleanup klip lama saat startup | **Berfungsi** | `App.tsx:260-275`, `commands.rs:1114-1134` |
| F28 | Undo delete / recycle bin | **Tidak ada** | `delete_clip` = `remove_file` permanen |
| F29 | Gabung (concat) beberapa klip | **Tidak ada** | — |
| F30 | Export GIF | **Mati — akan DIHAPUS** | `gif.rs` 825 baris + `export_clip_gif` terdaftar, tapi **0 pemanggil UI** (dihapus di 1.5.0). Keputusan: hapus seluruhnya (lihat QW8) |
| F31 | Playback preview di trimmer | **Parsial** | Bergantung `asset:` scope statis → rusak jika output dir diubah (lihat B4) |

### 3.3 Profil, Privasi, Otomasi

| # | Fitur | Status | Bukti / catatan |
| :-- | :--- | :--- | :--- |
| F32 | Profil per-game (buffer/fps/bitrate/codec) | **Berfungsi** | `settings.rs:177-250`, `ProfilesPanel.tsx` |
| F33 | Auto-switch profil berdasarkan exe foreground | **Berfungsi** | `App.tsx:553-680`; poll 5 s, cooldown 4 s |
| F34 | Deteksi exe via Toolhelp snapshot (tahan anti-cheat) | **Berfungsi** | `foreground.rs:70-133` |
| F35 | Privacy mode (gate + hysteresis 5 s) | **Berfungsi** | `privacyGate.ts` + 140 baris test |
| F36 | Auto-save 30 s saat game kehilangan fokus | **Berfungsi** | `App.tsx:587-606`; guard 10 s fokus + cooldown 60 s |
| F37 | Adaptive ECO (baterai/RAM) | **Parsial** | Buffer live berubah, tapi **fps cap `ECO_FPS` tidak pernah diterapkan** — hanya dipakai di teks toast (`App.tsx:746`) |
| F38 | HUD overlay always-on-top | **Mati — akan DIHAPUS** | `set_hud_visible` ada di `commands.rs:1019-1072` tapi **tidak terdaftar** di `invoke_handler`; window `hud` tidak ada di `tauri.conf.json`. Keputusan: hapus seluruh blok (lihat QW8) |
| F39 | Simulate GPU reset | **Mati** | `commands.rs:1427-1430` + `bridge.ts:714-720`, tanpa tombol UI |

### 3.4 Sistem

| # | Fitur | Status | Bukti / catatan |
| :-- | :--- | :--- | :--- |
| F40 | Tray menu (save / save30 / toggle / show / folder / quit) | **Berfungsi** | `lib.rs:260-352` |
| F41 | Minimize to tray saat window ditutup | **Berfungsi** | `lib.rs:183-196` |
| F42 | Launch at startup (registry sync) | **Berfungsi** | `lib.rs:79-89`, `commands.rs:869-881` |
| F43 | Auto-update bertanda tangan (minisign) | **Berfungsi** | `App.tsx:761-806`, `release.yml:56-72` |
| F44 | Hotkey recorder (click-to-record) | **Berfungsi** | `SettingsPanel.tsx:46-106` |
| F45 | Single-instance guard | **Tidak ada** | Komentar `lib.rs:54-55` menyebut single-instance, tetapi **plugin `tauri-plugin-single-instance` tidak ada di `Cargo.toml`/`Cargo.lock`** → dua instance bisa jalan dan memperebutkan DXGI duplication |

> **Catatan F45:** Ini temuan penting. Komentar kode mengklaim perilaku yang tidak diimplementasikan. Dua instance ClipFlow berarti dua sesi encoder hardware dan dua ring buffer — dan DXGI Desktop Duplication hanya mengizinkan satu duplikator per output, sehingga instance kedua akan gagal dengan pesan yang membingungkan.

---

## 4. Temuan Bug dan Risiko

Setiap temuan ditandai **Confirmed** (terverifikasi dari kode/eksekusi), **Potential** (indikasi kuat, perlu reproduksi runtime), atau **Unknown**.

### B1 — Engine macet permanen di state `Flushing` saat flush gagal · **Confirmed** · P1

**Lokasi:** `src-tauri/src/media/recorder.rs:917-976`

```rust
let prev_state = *self.shared.state.read();      // 940
self.shared.set_state(EngineState::Flushing);    // 941
...
std::fs::create_dir_all(&out_dir)?;              // 952  ← early return
...
mux_packets_to_mp4(&path, &header, &video, &audio)?;  // 960 ← early return
...
self.shared.set_state(prev_state);               // 963  ← tidak pernah tercapai
```

**Dampak:** Setiap kegagalan I/O (disk penuh, folder di-unmount, path invalid, encoder header rusak, file dikunci antivirus) meninggalkan state `Flushing` permanen. UI menghitung `armed = buffering || flushing` dan `actionReady = false` untuk `flushing` (`BufferStatusCard.tsx:81, 103-110`), sehingga pengguna melihat "Saving clip to disk…" selamanya dengan tombol Save nonaktif. Satu-satunya pemulihan adalah restart engine — yang juga menghapus seluruh riwayat buffer.

**Tambahan:** file parsial tidak dibersihkan pada jalur error (bandingkan dengan `split_clip` yang sudah benar melakukannya di `commands.rs:459-467`).

**Reproduksi:** isi disk sampai penuh (atau set `output_dir` ke path read-only via `update_settings`), tekan Alt+C.

**Perbaikan yang disarankan:** bungkus mux dalam closure dan pulihkan state di semua jalur (pola RAII guard atau `let result = ...; self.shared.set_state(prev_state); result?`). Hapus file parsial jika mux gagal.

---

### B2 — Buffer lebih pendek dari yang dipilih pengguna (cap tidak ikut berubah) · **Confirmed** · P1

**Lokasi:** `recorder.rs:387-390` (`set_window`), `recorder.rs:593-598` (`ring_cap_mb`), `recorder.rs:870-874` (`set_buffer_seconds`)

```rust
pub fn set_window(&mut self, window_seconds: u32) {
    self.window_hns = window_seconds as i64 * HNS_PER_SECOND;
    self.prune();               // hard_byte_cap TIDAK diperbarui
}
```

`hard_byte_cap` hanya dihitung di `RollingRingBuffer::new()`, yang dipanggil dari `start()` (`recorder.rs:757-759`) dan `CaptureEngine::new()`.

**Hitungan (deterministik dari `ring_cap_mb`, 12 Mbps default):**

| Durasi dipilih | `hard_byte_cap` saat engine start 60 s | Kapasitas efektif cap lama | Yang benar-benar didapat |
| :--- | :--- | :--- | :--- |
| 60 s | 141 MB | ≈ 96 s | 60 s (window membatasi) ✔ |
| 120 s | 141 MB | ≈ 96 s | **≈ 96 s, bukan 120 s** ✘ |
| 300 s | 141 MB | ≈ 96 s | **≈ 96 s, bukan 300 s** ✘ |

**Dampak:** Pengguna menaikkan durasi replay (aksi paling umum kedua setelah save), UI menampilkan "Buffer capacity: 96s / 300s", dan klip yang diselamatkan lebih pendek dari yang dijanjikan. Ini kegagalan janji produk, bukan sekadar kosmetik — momen yang ingin diselamatkan bisa hilang.

**Catatan:** Settings menulis "Buffer size changes live" (`SettingsPanel.tsx:376`) — setengah benar. `apply_profile` dan ECO juga memakai jalur yang sama.

**Perbaikan:** hitung ulang `hard_byte_cap` di `set_window()` (butuh `bitrate_kbps`, atau simpan sebagai parameter `set_window(seconds, bitrate)`), dan panggil dengan bitrate aktif.

---

### B3 — Jalur save UI melewati `flush_lock`; tray "Save last 30 s" melewati lock **dan** event · **Confirmed** · P1

**Lokasi:** `commands.rs:255-259` (UI), `hotkeys.rs:138-149` (hotkey, memakai lock), `lib.rs:284-301` (tray save30, tanpa lock/event)

- `flush_lock` hanya di-`try_lock` di `hotkeys.rs:139`. `save_instant_replay` — jalur yang dipakai tombol Save di deck dan auto-save-on-exit — tidak menyentuhnya.
- Tray `save30` memanggil `engine.flush_to_disk(Some(30.0))` langsung, **tanpa** lock, **tanpa** membangun `ClipMetadata`, **tanpa** `emit(EVT_CLIP_SAVED)`.

**Dampak:**
1. Save dari UI + Alt+C bersamaan → dua `mux_packets_to_mp4` paralel. Karena nama file beresolusi detik (`ClipFlow_%Y-%m-%d_%H-%M-%S.mp4`, `recorder.rs:943-945`), keduanya bisa menulis ke path yang sama → file korup atau satu save hilang tanpa pesan.
2. Tray "Save last 30 s" berhasil menulis file tetapi gallery tidak refresh dan tidak ada toast — pengguna tidak tahu klip tersimpan (harus klik Rescan).

**Perbaikan:** pindahkan `flush_lock` ke dalam `CaptureEngine::flush_to_disk` (atau sediakan `flush_guarded()`), dan rute tray save30 melalui satu fungsi bersama yang juga membangun metadata + emit event.

---

### B4 — Preview trimmer rusak setelah output folder diubah · **Confirmed** · P1

**Lokasi:** `tauri.conf.json:34-37`, `bridge.ts:76-84`, `ClipTrimmerModal.tsx:68`

```json
"assetProtocol": {
  "enable": true,
  "scope": ["$VIDEO/ClipFlow/**", "$HOME/Videos/ClipFlow/**"]
}
```

`assetUrl()` mengubah **path apa pun** menjadi URL `asset:` via `convertFileSrc`, tanpa memeriksa scope. `update_settings` mengizinkan `output_dir` diubah ke lokasi mana pun (`commands.rs:841-847`), dan `App.tsx:808-822` menyediakan tombol "Change Folder".

**Dampak:** Setelah pengguna memindahkan folder ke `D:\Clips`, kartu gallery tetap berfungsi (thumbnail = data URL dari Rust), tetapi `<video>` di trimmer memakai `asset://localhost/...` yang ditolak CSP/scope → panel "NO PREVIEW STREAM" atau video gagal load. Fitur trim/split/snapshot tetap jalan, jadi gejalanya membingungkan ("klip saya rusak?").

**Perbaikan:** jadikan scope asset dinamis (`app.asset_protocol_scope().allow_directory(...)` saat `output_dir` berubah), atau hentikan pemakaian `asset:` dan pakai `read_clip_as_data_url` (yang sudah ada tapi mati) / custom protocol ber-scope.

---

### B5 — Paket audio menumpuk tanpa batas saat privacy gate aktif · **Confirmed (dari kode)** · P2

**Lokasi:** `recorder.rs:407-450` (`prune`), `recorder.rs:891-898` (`set_privacy_gate`), `audio.rs:566` (loop audio tidak memeriksa gate)

`prune()` menggunakan video sebagai penentu waktu:

```rust
let over_time = self.video.front().map(|p| p.pts_hns < cutoff).unwrap_or(false); // false saat video kosong
if !(over_time || over_bytes) || self.video.len() < 2 { break; }                 // break saat video < 2
...
let audio_cutoff = self.video.front().map(...).unwrap_or(i64::MIN);              // i64::MIN
while let Some(front) = self.audio.front() {
    if front.pts_hns >= audio_cutoff { break; }   // selalu break
```

`set_privacy_gate(true)` mengosongkan ring, tetapi thread audio **tidak** memeriksa `privacy_gate` — ia terus mendorong paket AAC ke ring yang video-nya kosong. Karena `video.len() < 2`, loop eviction langsung `break`, dan `audio_cutoff = i64::MIN` membuat audio tidak pernah dibuang.

**Dampak:** Selama privacy mode aktif (mis. pengguna alt-tab ke browser berjam-jam), ring mengakumulasi audio ≈24 KB/s (192 kbit/s) ≈ **86 MB/jam**, tanpa batas keras. Saat gate dibuka kembali, `prune()` akan membersihkannya, jadi ini kebocoran sementara — tetapi bertentangan dengan klaim "buffer kosong saat privacy mode" dan dapat memicu tekanan memori pada mesin 8 GB.

**Perbaikan:** (a) thread audio melewati `push` saat `privacy_gate` aktif, dan/atau (b) `prune()` juga membatasi audio berdasarkan `audio.back().pts_hns - window_hns` dan `hard_byte_cap` secara independen dari video.

---

### B6 — Nama file beresolusi detik → save kedua dalam detik yang sama menimpa yang pertama · **Confirmed** · P2

**Lokasi:** `recorder.rs:943-945`

Tidak ada pemeriksaan eksistensi (bandingkan `library.rs:304-317` yang sudah benar untuk `suggested_trim_path`). `flush_lock` (bila dipakai) mengurangi jendela race tetapi tidak menghilangkannya: dua save berturut-turut dalam detik yang sama tetap mungkin terjadi pada disk cepat (flush < 50 ms), dan jalur UI tidak memakai lock sama sekali (B3).

**Dampak:** Kehilangan data tanpa pesan. Pengguna menekan Alt+C dua kali karena mengira yang pertama gagal → klip pertama hilang.

**Perbaikan:** tambahkan suffix unik (`_2`, `_3`) atau milidetik, dan/atau tolak save jika file tujuan sudah ada.

---

### B7 — Perintah sinkron melakukan I/O/COM/DXGI blocking di main thread · **Confirmed (perilaku Tauri terdokumentasi)** · P2

Dokumentasi resmi Tauri v2 menyatakan: *"Commands without the `async` keyword are executed on the main thread"* ([Calling Rust from the Frontend](https://v2.tauri.app/develop/calling-rust/), bagian *Async Commands*).

Perintah sinkron yang melakukan kerja berat/blocking:

| Perintah | Kerja blocking | Lokasi |
| :--- | :--- | :--- |
| `delete_clips(paths)` | N × `remove_file` | `commands.rs:578-586` |
| `delete_all_clips` | `scan_directory` + N × delete | `commands.rs:518-528` |
| `delete_clip` | `remove_file` | `commands.rs:511-513` |
| `rename_clip` | `rename` + sidecar save | `commands.rs:531-558` |
| `save_png_snapshot` | `create_dir_all` + `write` (PNG bisa MB) | `commands.rs:684-711` |
| `get_monitors` | enumerasi DXGI adapter/output | `commands.rs:1254-1257` |
| `get_audio_input_devices` | COM enumerate + property store | `commands.rs:1259-1262` |
| `get_system_report` | `enumerate_monitors()` + RSS | `commands.rs:1334-1343` |

**Dampak:** Menghapus 200 klip dalam batch, atau merescan device audio saat driver lambat, membekukan seluruh WebView (termasuk animasi dan tombol). Tidak ada indikator loading yang bisa dirender selama freeze.

**Perbaikan:** ubah ke `async fn` + `spawn_blocking` (pola yang sudah dipakai dengan benar di `get_recorded_clips`, `trim_clip`, dll.).

---

### B8 — `update_settings` menerapkan patch sebagian lalu gagal menyimpan · **Confirmed** · P2

**Lokasi:** `commands.rs:782-942`

Fungsi memutasi `s` (in-memory) secara berurutan, dan beberapa langkah bisa gagal **setelah** mutasi sebelumnya:

- `hotkeys::rebind` (baris 811, 815) sudah mengubah registrasi OS, lalu bila `create_dir_all(&v)` (842) atau `autolaunch().enable()` (875) gagal → `return Err` **sebelum** `s.save()` (940).
- Hasil: settings in-memory berbeda dari `settings.json`, hotkey OS sudah berubah tetapi tidak persisten → setelah restart, hotkey kembali lama sementara pengguna melihat nilai baru di UI.

**Perbaikan:** validasi seluruh patch lebih dulu (fail fast), atau kloning `Settings`, mutasi klon, `save()` klon, baru `*s = klon` (commit-on-success).

---

### B9 — Snapshot PNG menimpa file bernama sama secara diam-diam · **Confirmed** · P3

**Lokasi:** `commands.rs:697-710`. `stem` hanya disanitasi karakter terlarang; `dir.join(format!("{stem}.png"))` ditulis tanpa cek eksistensi. Dua snapshot dari klip yang sama → snapshot pertama hilang.

---

### B10 — Klaim privasi bertentangan dengan pemeriksaan updater saat startup · **Confirmed** · P2

**Lokasi:** `README.md:51` ("no background updater"), `tauri.conf.json:60` ("no background updater"), `lib.rs:43-44` ("nothing runs in the background"), vs `App.tsx:280-293`:

```ts
if (clipflow.isTauri()) {
  const update = await check();   // request HTTPS ke github.com, setiap launch
```

**Dampak:** Bukan celah keamanan (manifest ditandatangani, hanya metadata), tetapi:
- Pengguna yang memilih ClipFlow **karena** klaim privasi akan mendapati aplikasi menghubungi internet tanpa persetujuan.
- Bertentangan dengan komentar arsitektur di `lib.rs`. Dokumentasi yang tidak akurat lebih berbahaya daripada fitur yang tidak ada.

**Perbaikan:** jadikan pemeriksaan startup **opt-in** (default off) di Settings, atau perbaiki klaim di README/`tauri.conf.json` menjadi "updater memeriksa metadata rilis bertanda tangan saat startup; tidak ada telemetri".

---

### B11 — Permukaan IPC mati (dead code terdaftar) · **Confirmed** · P2

| Item | Kondisi |
| :--- | :--- |
| `set_hud_visible` | Ada di `commands.rs:1019-1072`, **tidak** ada di `invoke_handler` (`lib.rs:197-247`) → tidak bisa dipanggil, bahkan lewat `invoke` manual |
| `read_clip_as_data_url` | Terdaftar (`lib.rs:222`), **0** pemanggil frontend |
| `get_system_report` | Terdaftar (`lib.rs:244`), **0** pemanggil frontend |
| `get_output_dir` | Terdaftar (`lib.rs:227`), **0** pemanggil frontend |
| `show_main_window` | Terdaftar (`lib.rs:242`), **0** pemanggil frontend |
| `set_toggle_hotkey` | Terdaftar (`lib.rs:240`), **0** pemanggil frontend |
| `export_clip_gif` + `media/gif.rs` | Terdaftar (`lib.rs:207`), `bridge.ts:604-621` ada, **0** pemanggil UI; 825 baris + 16 test + crate `gif`/`color_quant` tetap dikompilasi |
| `simulate_device_loss` | `bridge.ts:714-720` ada, tidak ada tombol UI |
| `settings.hud_enabled`, `settings.hud_position` | Masih di struct + `SettingsPatch`, HUD sudah dihapus |
| `EngineStats.audio_drift_ms` | Field ada, **tidak pernah ditulis** (selalu 0.0), tidak dipakai UI |
| `MonitorInfo.refresh_hz` | Selalu `0` di Windows (`recorder.rs:2571`), tidak dipakai UI |
| `once_cell`, `crossbeam-channel` | Di `Cargo.toml:44-45`, **0** penggunaan di source |
| Feature `windows` tak terpakai | `Win32_UI_HiDpi`, `Win32_Storage_Packaging_Appx`, `Win32_Graphics_Direct3D_Fxc`, `Win32_Media_KernelStreaming`, `Win32_System_Variant`, `Win32_UI_Shell_PropertiesSystem` — 0 referensi |
| `@tauri-apps/plugin-notification` (JS), `plugin-fs` (JS) | Tidak diimpor frontend; capability `fs:*` tetap diberikan |
| Capability window `"trimmer"` | Tidak ada window dengan label itu di `tauri.conf.json` |

**Dampak:** Beban kognitif (pembaca berikutnya mengira fitur ini hidup), waktu kompilasi, ukuran binary, dan permukaan serangan (capability `fs:allow-remove` untuk plugin yang tidak dipakai).

---

### B12 — Inkonsistensi kecil yang membingungkan · **Confirmed** · P3

| Temuan | Lokasi |
| :--- | :--- |
| Deck menawarkan durasi `15/30/60/120`, Settings `15/30/60/120/300`, engine menerima `5–600`, README menulis `15–120` | `BufferStatusCard.tsx:19`, `SettingsPanel.tsx:32`, `settings.rs:254`, `README.md:40` |
| `App.tsx:435` memanggil `setBufferSeconds` lagi padahal `update_settings` sudah melakukannya (`commands.rs:819-822`) → 2 IPC per perubahan buffer | `App.tsx:430-446` |
| `ECO_FPS` dideklarasikan dan ditampilkan di toast, tetapi tidak pernah diterapkan ke engine | `powerPolicy.ts:19`, `App.tsx:746` |
| Toast privacy terbalik: `gate ? "Privacy mode paused" : "Privacy mode active"` | `App.tsx:633-639` |
| `CHANGELOG.md` mengandung mojibake (`???` menggantikan emoji) yang **tersimpan** di repo, bukan artefak tampilan | `CHANGELOG.md` (baris 9-10 dst.) |
| `Cargo.toml:7` repository menunjuk `github.com/clipflow/clipflow`, sedangkan updater ke `drexjgobgt/ClipFlow-Dev` | `Cargo.toml:7` vs `tauri.conf.json:69` |

---

### B13 — Aksesibilitas: gallery tidak bisa dioperasikan keyboard · **Confirmed** · P2

- Kartu klip adalah `<article onClick={...}>` **tanpa** `role="button"`, `tabIndex`, atau `onKeyDown` (`GalleryGrid.tsx:139-147`). Grep: **0** kemunculan `tabIndex`/`onKeyDown`/`role=` di file itu.
- Toast tidak memiliki `aria-live`/`role="status"` (`App.tsx:1920-1937`); grep: **0** kemunculan di seluruh `src/**/*.tsx`.
- Tidak ada focus trap atau `role="dialog"`/`aria-modal` pada `ClipTrimmerModal`, modal konfirmasi, dan onboarding.
- Label tombol ikon di gallery hanya `title` (tidak dibaca screen reader secara andal) — sebagian sudah punya teks, sebagian hanya SVG.
- Satu hal yang **sudah baik**: `:focus-visible` global didefinisikan (`index.css:112-115`) dan toggle memakai `role="switch"` + `aria-checked` (`ui.tsx:27-31`).

**Dampak:** Pengguna yang mengandalkan keyboard/screen reader tidak dapat membuka klip sama sekali. Untuk aplikasi desktop Windows, ini gap yang wajar diperbaiki dan murah.

---

### B14 — Tidak ada error boundary · **Confirmed** · P2

Grep: **0** `ErrorBoundary`/`componentDidCatch` di `src/**/*.tsx`. Satu exception saat render (mis. `stats` berbentuk tak terduga dari IPC, atau `VENDOR_LABEL[undefined]`) akan me-*unmount* seluruh tree → layar putih, tanpa jalan pulih selain menutup paksa proses. Untuk aplikasi yang berjalan di tray saat gaming, ini berarti kehilangan buffer.

---

### B15 — Ring buffer: `force_key` dapat hilang saat encoder jenuh · **Potential** · P3

**Lokasi:** `recorder.rs:1671-1686`, `recorder.rs:2309-2316`

```rust
pub fn submit(...) -> RResult<()> {
    if self.async_mode {
        self.pump_events(true)?;
        if self.pending_input == 0 { return Ok(()); }   // frame DI-DROP, tapi Ok
```

Pemanggil:
```rust
if let Err(e) = encoder.submit(...) { dropped += 1 } else { force_key = false; }
```

Jika frame pertama setelah device reset (atau setelah gate privacy dibuka) di-drop karena `pending_input == 0`, `force_key` direset ke `false` padahal IDR belum pernah dikirim. Generasi baru bisa dimulai tanpa keyframe → klip diawali artifak sampai keyframe periodik berikutnya (≤1 s, karena `MF_MT_MAX_KEYFRAME_SPACING = fps`).

**Perlu:** reproduksi dengan stress GPU. Dampaknya terbatas (≤1 s artifak) tetapi bertentangan dengan komentar "the new generation always begins with an IDR".

---

### B16 — `AcquireNextFrame` timeout memanggil `ReleaseFrame` tanpa frame · **Potential** · P3

`recorder.rs:2263-2267` dan `2348-2350`: pada `DXGI_ERROR_WAIT_TIMEOUT`, tidak ada frame yang diakuisisi, tetapi `ReleaseFrame()` tetap dipanggil (hasilnya diabaikan). Umumnya tidak berbahaya, tetapi menghasilkan error DXGI yang tidak perlu dan dapat mengotori diagnosa jika nanti ditambahkan logging error. Juga: pada timeout pertama sebelum ada frame, `last_texture` = `None` → frame tidak dihitung sebagai `dropped_frames`, sehingga statistik under-report.

---

### B17 — Risiko yang perlu dicatat (bukan bug)

| Risiko | Status | Catatan |
| :--- | :--- | :--- |
| Dua instance ClipFlow | **Confirmed** (tidak ada plugin single-instance) | Instance kedua gagal acquire duplication dengan pesan membingungkan; tidak ada korupsi data |
| Anti-cheat memblokir `AcquireNextFrame` | **Unknown** | Perlu uji pada Valorant/CS2 dengan Vanguard/VAC aktif; desain sudah fail-safe (error + Recovering) |
| `cargo test` di CI menyentuh path Windows nyata | **Confirmed** | `ci.yml` memakai `windows-latest`; test library memakai temp dir ber-PID sehingga aman paralel |
| `flush` saat game fullscreen-exclusive | **Unknown** | Tidak ada pengukuran dampak frame-time saat mux 60 s |

---

## 5. Performance Audit

Prinsip: hanya angka yang benar-benar terukur dari repo. Tidak ada estimasi persentase peningkatan tanpa baseline.

### 5.1 Baseline terukur (bisa diverifikasi ulang)

| Metrik | Nilai | Cara mengukur |
| :--- | :--- | :--- |
| Bundle frontend (single-file) | **421.835 byte** (`dist/index.html`) | `Get-Item dist/index.html` |
| Typecheck | **Lulus, 0 error** | `npm run typecheck` |
| Test frontend | **61 lulus / 5 file, 848 ms** | `npm test` |
| Test Rust | **44 `#[test]`** | grep `#[test]` di `src-tauri/src` |
| Baris kode Rust | 8.249 | `Get-Content .Count` per file di `src-tauri/src` |
| Baris kode frontend | 8.564 | `Get-Content .Count` per file di `src` |
| Heartbeat stats | 1 Hz, hanya saat window visible & tidak minimized | `lib.rs:150-179` |
| Interval poll foreground | 5 s, hanya jika fitur terkait aktif | `App.tsx:546-550, 675` |
| Interval poll ECO | 5 s, hanya jika `adaptiveEco` | `App.tsx:754` |
| Lock ring per frame | 1 acquire/release per paket video (≈60/s) | `recorder.rs:2318-2329` |

### 5.2 Yang sudah dioptimalkan dengan baik (fakta, bukan rekomendasi)

Ini penting dicatat agar tidak "mengoptimalkan" hal yang sudah benar:

1. **Snapshot O(n) pointer, bukan O(bytes) memcpy** — `Arc<[u8]>` + `.cloned()` (`recorder.rs:497-511`). Ini yang membuat flush 60 s bisa < 50 ms.
2. **Eviction GOP-aligned** — mencegah MP4 diawali delta frame (`recorder.rs:422-434`).
3. **Probe cache `(size, mtime)`** — rescan O(files) stat, bukan O(files) MF open (`library.rs:236-280`), dengan atomic save.
4. **Thumbnail lazy + visibility-gated** — tidak ada decode saat deck hidden (`GalleryGrid.tsx:97-98`, `App.tsx:2026-2029`).
5. **Virtualisasi + pagination** — DOM dibatasi viewport (`useVirtualGrid.ts`), windowing math pure dan teruji.
6. **Tidak ada spin-wait** — frame pacing pakai `sleep` penuh + `timeBeginPeriod(1)` (`recorder.rs:2220-2237`).
7. **Prioritas thread diturunkan di Game Mode** — capture `NORMAL`, audio `NORMAL` + poll 10 ms (`recorder.rs:2057-2070`, `audio.rs:528-538`).
8. **Zero-copy encode** — `MFCreateDXGISurfaceBuffer` + `IMFDXGIDeviceManager` (`recorder.rs:1516-1526, 1688-1694`).
9. **Animasi berhenti saat deck idle** — `html[data-deck-idle="true"]` (`index.css:131-133`).
10. **`tauri.conf.json` `beforeDevCommand` + singlefile** — tidak ada asset network request di produksi.

### 5.3 Bottleneck & peluang (berbasis bukti)

| # | Temuan | Bukti | Dampak | Status |
| :-- | :--- | :--- | :--- | :--- |
| P1 | **Lock ring per paket** (bukan per batch) | `recorder.rs:2318-2329` — `ring.lock().push(pkt)` di dalam closure `drain`, dipanggil per AU | 60 lock/unlock per detik; bersaing dengan `stats()` (1 Hz) dan `flush_to_disk`. Biaya absolut kecil, tetapi `parking_lot::Mutex` di hot path capture sebaiknya dihindari | Confirmed |
| P2 | **`stats()` melakukan syscall + lock** | `recorder.rs:689-745`: `ring.lock()`, `process_rss_bytes()` → `GetProcessMemoryInfo`, 8× `RwLock::read` | 1×/detik, dapat diterima. Namun `get_engine_stats` (IPC) juga memanggil ini tanpa throttle | Confirmed |
| P3 | **`simEngine.ts` (576 baris) ikut bundle produksi** | `bridge.ts:10` — `import { simEngine } from "./simEngine"` statis, dipakai di setiap cabang `if (!isTauri())` | Bundle 421 KB memuat seluruh mesin simulasi yang tidak pernah dieksekusi di build native; `viteSingleFile` mencegah code-splitting | Confirmed |
| P4 | **`gif.rs` (825 baris) + crate `gif`/`color_quant` dikompilasi tanpa pemakai** | `lib.rs:207` terdaftar; 0 pemanggil UI | Waktu kompilasi + ukuran binary; 16 unit test yang menjaga kode mati | Confirmed |
| P5 | **Perintah sinkron memblokir main thread** | Lihat B7 | Freeze UI pada operasi batch/COM/DXGI | Confirmed |
| P6 | **Thumbnail tidak persisten** | `thumbCache.ts:6` — `Map` in-memory saja | Setiap launch ulang, setiap thumbnail di-decode ulang (MF open + seek + decode + PNG encode, `library.rs:412-531`). Untuk 200 klip = 200 decode per sesi | Confirmed |
| P7 | **`scan_directory` membaca seluruh direktori di setiap `refreshClips()`** | `App.tsx:224-235` dipanggil setelah setiap trim/split/rename/delete | Dengan probe cache biayanya O(stat), tetapi tetap walk penuh; tidak ada pembaruan inkremental | Confirmed |
| P8 | **Dua IPC per perubahan buffer** | `App.tsx:435` + `commands.rs:821` | Latensi UI ganda, tidak berbahaya | Confirmed |
| P9 | **`profileMap.find` O(n) per poll, `paths.includes` O(n·m) di batch** | `App.tsx:659`, `App.tsx:1162, 1188-1199` | Untuk 200 profil/klip, tidak terasa; untuk 5.000 klip batch-tag, O(n·m) bisa terasa. `selection.selected` sudah `Set` — sebaiknya dipakai konsisten | Confirmed |
| P10 | **Tidak ada pengukuran frame-time in-game** | Tidak ada benchmark/telemetry lokal | Klaim README ("under 50 ms", "80–120 MB") tidak dapat diverifikasi dari repo. Bukan bug, tetapi **baseline hilang** | Unknown |

### 5.4 Yang TIDAK direkomendasikan (meski terdengar "modern")

- **Redis/queue/worker terpisah** — tidak ada server; semua lokal. Menambah proses hanya menambah latensi dan titik gagal.
- **Code-splitting dinamis untuk Tauri** — `viteSingleFile` sengaja dipakai agar tidak ada request file tambahan di WebView. Memecah bundle akan memperlambat startup dari disk.
- **Web Worker untuk thumbnail** — decode sudah di Rust (off-thread). Worker hanya akan menambah hop serialisasi.
- **Database (SQLite) untuk metadata klip** — `clip_meta.json` + `probe_cache.json` sudah cukup untuk ribuan entri; migrasi ke SQLite menambah dependency dan risiko migrasi tanpa manfaat terukur pada skala ini. **Kecuali** jika fitur pencarian full-text/riwayat ditambahkan (lihat Strategic).

---

## 6. Architecture dan Code Quality Audit

### 6.1 Kekuatan

1. **Batas platform yang bersih.** `#[cfg(all(windows, not(feature = "headless-sim")))]` memisahkan `win` dan `sim` dengan dispatch tunggal (`recorder.rs:2487-2516`). Konsekuensinya: seluruh IPC + UI dapat diuji di Linux/macOS CI. Ini keputusan arsitektur yang sangat baik dan jarang dilakukan.
2. **Policy murni yang terpisah dari efek.** `privacyGate.ts`, `powerPolicy.ts`, `selection.ts`, `galleryState.ts`, `useVirtualGrid.computeVisibleRows` semuanya pure dan teruji (61 test). Ini pola yang benar.
3. **Error type eksplisit di Rust.** `RecorderError` dengan `thiserror`, dikonversi ke `String` hanya di batas IPC (`recorder.rs:245-273`).
4. **Fail-safe pada ketidakpastian.** Privacy gate hanya menahan bila foreground **positif** diketahui (`commands.rs:202-207`). Keputusan yang tepat: lebih baik merekam frame ambigu daripada mematikan Alt+C saat game anti-cheat tidak terdeteksi.
5. **Komentar menjelaskan "mengapa", bukan "apa".** Contoh kuat: `recorder.rs:2220-2224` (menghapus spin-wait), `library.rs:272-274` (atomic cache write), `split_clip` (satu task agar MF tidak race).

### 6.2 Masalah struktur

| # | Temuan | Bukti | Dampak |
| :-- | :--- | :--- | :--- |
| A1 | **`App.tsx` monolit 2.138 baris** | 5 layar inline (home/clips/profiles/stats/settings), **34 `useState` + 1 `useReducer` + 13 `useEffect`** (termasuk 2 `setInterval` polling), seluruh handler bisnis | Setiap perubahan kecil menyentuh file terbesar; re-render seluruh tree pada setiap `stats` tick (1 Hz) karena state `stats` ada di root |
| A2 | **`commands.rs` 1.475 baris, 49 handler terdaftar** | Semua domain (capture, library, settings, profil, clipboard, sistem) dalam satu modul | Tidak ada kohesi; sulit menavigasi; `mod clipboard` bersarang di dalamnya |
| A3 | **`recorder.rs` 2.627 baris** | Mencakup: data model, ring buffer, engine facade, D3D11 stack, colour converter, MF encoder, muxer, capture loop, simulasi, enumerasi monitor | Sulit diuji; perubahan muxer berisiko menyentuh capture loop |
| A4 | **Duplikasi sanitasi nama file (3×)** | `commands.rs:153-178` (`game_folder_name`), `commands.rs:538-540` (`rename_clip`), `commands.rs:697-700` (`save_png_snapshot`) — ketiganya memakai daftar karakter terlarang yang sama | Satu perbaikan keamanan harus diubah di tiga tempat; mudah terlewat |
| A5 | **Duplikasi konstruksi `ClipMetadata` (2×)** | `commands.rs:266-282` dan `hotkeys.rs:186-206` (±20 baris identik) | Field baru harus ditambah di dua tempat; rawan drift |
| A6 | **Duplikasi logika privacy gate (2×)** | `commands.rs:212-228` (`privacy_blocked_message`) vs `hotkeys.rs:152-171` (re-implementasi inline) | Aturan bisa berbeda diam-diam |
| A7 | **Duplikasi default settings (2×)** | `settings.rs:134-171` vs `bridge.ts:124-180` (termasuk 3 profil seed) | Nilai default bisa berbeda antara native dan browser preview |
| A8 | **Duplikasi label vendor (2×)** | `recorder.rs:57-65` (`EncoderVendor::label`) vs `types.ts:245-251` (`VENDOR_LABEL`) | Label berbeda untuk enum yang sama |
| A9 | **Mirror tipe manual tanpa codegen** | `types.ts` (240 baris) mencerminkan struct Rust secara manual; komentar `types.ts:1-5` mengakui "keep in sync" | Sudah terlihat drift: `audio_drift_ms` mati, `hud_*` tidak ada di TS. Tidak ada test yang mendeteksi drift |
| A10 | **`bridge.ts` 681 baris dengan 40+ method** | Setiap method punya cabang `if (isTauri())` + implementasi sim | Duplikasi perilaku native vs simulasi tidak teruji kesetaraannya |

### 6.3 Technical debt yang paling menghambat pengembangan berikutnya

Diurutkan berdasarkan "berapa banyak pekerjaan masa depan yang terblokir":

1. **A1 (App.tsx)** — setiap fitur baru di UI akan menambah monolit ini. Ini utang dengan bunga tertinggi.
2. **A9 (mirror tipe manual)** — setiap field baru di `EngineStats`/`Settings`/`ClipMetadata` harus diubah manual di 2 tempat, dan tidak ada gate yang menangkap kesalahan.
3. **A4/A5 (duplikasi sanitasi & metadata)** — akan menjadi bug keamanan/konsistensi saat fitur file-handling ditambah.
4. **B11 (kode mati)** — memperlambat onboarding dan menyembunyikan apa yang benar-benar hidup.
5. **B14 (tanpa error boundary)** — setiap fitur baru menambah permukaan crash total.

### 6.4 Rekomendasi refactor (proporsional, bukan "rewrite")

- **Jangan** memecah `recorder.rs` secara besar-besaran. Risikonya tinggi (kode unsafe + COM + threading) dan manfaatnya tidak sebanding. Cukup ekstrak **`muxer`** (fungsi `mux` + `make_sample`) dan **`ring_buffer`** ke modul terpisah agar bisa diuji tanpa Windows. Itu sudah memberi 80% manfaat.
- **Lakukan** dekomposisi `App.tsx` secara bertahap: pindahkan 5 layar ke `views/`, pindahkan polling ke custom hook (`useForegroundPoll`, `useEcoPolicy`, `useEngineStats`), pindahkan aksi library ke `useLibraryActions`. Ini mekanis dan berisiko rendah.
- **Lakukan** ekstraksi util bersama: `sanitize_filename()`, `build_clip_metadata()`, `is_privacy_blocked()` di Rust; `DEFAULT_SETTINGS` tetap satu sumber (generate dari Rust atau hapus versi TS dan fetch saat boot).

---

## 7. UI/UX Audit

### 7.1 Yang bekerja baik

- **Hierarki jelas**: satu aksi utama (Save) dengan ukuran dan warna dominan; aksi teknis di balik disclosure (`BufferStatusCard.tsx:444-463`, `PipelinePanel.tsx:149-167`).
- **Bahasa manusia, bukan jargon.** "Recording buffer active" / "Ready to record" bukan "DXGI duplication acquired". Untuk audiens gamer non-teknis ini tepat.
- **Empty state informatif** — membedakan "belum ada klip" vs "tidak ada yang cocok dengan filter", masing-masing dengan aksi (`GalleryGrid.tsx:364-412`).
- **Loading state** ada (skeleton `animate-pulse`).
- **Toast + sound + native notification** memberi umpan balik berlapis, dan penting: **tidak mencuri fokus game** (`hotkeys.rs:216-234`).
- **Konsistensi visual** cukup baik setelah tema 1.5.0: satu palet (`#e9ecef`/`#f8f9fa`/`#d3d9e0`), satu aksen biru, radius seragam.
- **`prefers-reduced-motion` tidak ditangani**, tetapi animasi yang ada singkat (140-180 ms) dan satu-satunya animasi berulang dijeda saat idle.

### 7.2 Masalah UX (dengan bukti)

| # | Masalah | Bukti | Dampak pengguna |
| :-- | :--- | :--- | :--- |
| U1 | **State "Saving…" bisa abadi** | B1 | Pengguna mengira aplikasi hang; satu-satunya jalan keluar restart (kehilangan buffer) |
| U2 | **Durasi buffer menjanjikan lebih dari yang diberikan** | B2 | Momen yang ingin diselamatkan hilang; pengguna tidak tahu mengapa |
| U3 | **Trimmer "NO PREVIEW STREAM" tanpa penjelasan** setelah folder dipindah | B4 | Pengguna menyimpulkan klip rusak |
| U4 | **Tray "Save last 30 s" tidak memberi umpan balik** | B3 | Pengguna menekan berulang kali, menciptakan file ganda |
| U5 | **Toast privacy terbalik** | `App.tsx:633-639` — gate `true` (pause) menampilkan judul "Privacy mode paused" | Pesan bertentangan dengan keadaan sebenarnya |
| U6 | **Tidak ada loading state untuk aksi batch** | B7 — main thread beku | UI terlihat hang saat menghapus 200 klip |
| U7 | **Gallery tidak bisa dioperasikan keyboard** | B13 | Blokir aksesibilitas penuh |
| U8 | **Konfirmasi delete tidak konsisten** | Single delete: langsung hapus + toast (`App.tsx:879-891`). Batch: konfirmasi inline (`App.tsx:1728-1756`). Clear all: modal (`App.tsx:1963-1996`). Snapshot/trim/split: langsung | Pengguna tidak bisa memprediksi apakah aksi destruktif akan bertanya |
| U9 | **Onboarding hanya sekali, tidak bisa dibuka ulang** | `App.tsx:151-157, 1999-2012` — `localStorage` flag, tidak ada tombol "Show intro" di Settings | Pengguna yang lupa hotkey harus mencarinya di Settings |
| U10 | **`title` attribute sebagai satu-satunya label** pada tombol ikon gallery | `GalleryGrid.tsx:45-48` | Tooltip native lambat (~1 s), tidak muncul di sentuh, tidak terbaca screen reader secara andal |
| U11 | **Angka teknis bercampur dengan bahasa ramah** | `BufferStatusCard.tsx:250-262` menampilkan `1080×1920 · 60 FPS target · NVIDIA NVENC · 58 FPS live` di area status utama | Sedikit bertentangan dengan niat "plain-language" di file yang sama |
| U12 | **Tidak ada indikator "sedang memuat" pada tombol Apply & Restart Engine** | `SettingsPanel.tsx:367-378` | Pengguna bisa mengklik berkali-kali (dilindungi `busy`, tetapi tidak ada spinner) |

### 7.3 Responsive & desktop

- Layout memakai `sm:`/`xl:` dan grid `minmax(0,1fr)`, dengan `minWidth: 1040` di `tauri.conf.json:20` — jadi breakpoint mobile praktis tidak pernah tercapai di native. Ini **wajar** untuk aplikasi desktop, bukan cacat.
- `overflow-hidden` di `body` + `<main>` scroll sendiri: baik untuk mencegah rubber-band di WebView2.
- Tidak ada dukungan zoom/Dpi scaling khusus; `build.rs:3` menyatakan manifest DPI-aware per-monitor v2 — sudah benar.

### 7.4 Offline / kegagalan jaringan

- Tidak ada state "offline" karena aplikasi tidak bergantung jaringan untuk fungsi inti. Ini **kekuatan**, bukan gap.
- Satu-satunya jalur jaringan (updater) sudah menangani error dengan `catch { /* updater unreachable — ignore */ }` (`App.tsx:290-292`) — benar (tidak mengganggu startup).

---

## 8. Rekomendasi Fitur Baru

Semua rekomendasi di bawah berangkat dari fitur yang **terbukti ada** di kode. Tidak ada asumsi tentang AI, cloud, atau kolaborasi.

---

### 8.1 Quick Wins (manfaat langsung, effort rendah)

#### QW1 — Perbaiki state machine flush + bersihkan file parsial

1. **Masalah pengguna:** Setelah satu kegagalan disk, aplikasi tampak hang permanen dan buffer hilang saat restart (U1).
2. **Relevansi:** Ini bukan fitur, ini integritas produk. Semua fitur lain bergantung pada flush yang dapat diandalkan.
3. **Cara kerja:** Bungkus mux dalam closure; pulihkan `prev_state` di semua jalur; hapus file parsial pada error; emit `EVT_ERROR` yang spesifik ("Disk penuh — klip tidak tersimpan").
4. **Komponen:** `recorder.rs::flush_to_disk` saja. Tidak ada perubahan UI.
5. **Ketergantungan:** Tidak ada.
6. **Kompleksitas:** Rendah.
7. **Dampak:** Menghilangkan kelas kegagalan "aplikasi mati" sepenuhnya.
8. **Risiko:** Rendah. Perubahan terlokalisasi; perilaku sukses tidak berubah.
9. **Kriteria keberhasilan:** Test Rust baru yang mensimulasikan mux gagal → `stats().state` kembali ke state sebelumnya dan file parsial tidak ada.

#### QW2 — Sinkronkan `hard_byte_cap` saat durasi buffer berubah

1. **Masalah:** Pengguna memilih 120/300 s dan mendapat ~96 s (B2/U2).
2. **Relevansi:** Durasi replay adalah janji inti produk.
3. **Cara kerja:** `set_window(seconds, bitrate_kbps)` menghitung ulang cap via `ring_cap_mb`; panggil dari `set_buffer_seconds`, `apply_profile`, dan ECO.
4. **Komponen:** `recorder.rs` (ring + engine), `commands.rs` (pemanggil).
5. **Ketergantungan:** Tidak ada.
6. **Kompleksitas:** Rendah.
7. **Dampak:** Durasi yang dipilih = durasi yang didapat.
8. **Risiko:** Rendah. Bila bitrate berubah tanpa restart, cap dihitung dari bitrate lama — perlu dokumentasikan atau ikut update saat bitrate berubah.
9. **Kriteria keberhasilan:** Unit test: `new(60, 12000)` → `set_window(300, 12000)` → `hard_byte_cap == ring_cap_mb(300, 12000)`; `span_seconds()` mencapai ~300 s pada feed sintetis.

#### QW3 — Satu jalur flush bersama (lock + metadata + event)

1. **Masalah:** Save UI/hotkey/tray tidak konsisten; nama file bisa bentrok; tray save30 tidak memberi umpan balik (B3/B6/U4).
2. **Relevansi:** Tiga entry point ke aksi yang sama harus berperilaku sama.
3. **Cara kerja:** `CaptureEngine::flush_guarded(max_seconds, subfolder)` yang memegang lock internal, menghasilkan nama file unik (cek eksistensi → suffix), dan mengembalikan `ClipWriteResult`. Satu helper `persist_clip_result()` di `commands.rs` membangun metadata + emit event; dipakai oleh UI, hotkey, dan tray.
4. **Komponen:** `recorder.rs`, `commands.rs`, `hotkeys.rs`, `lib.rs` (tray).
5. **Ketergantungan:** QW1.
6. **Kompleksitas:** Rendah-sedang.
7. **Dampak:** Menghilangkan race, kehilangan data, dan "save tak terlihat".
8. **Risiko:** Sedang — menyentuh tiga jalur. Mitigasi: lakukan setelah QW1 stabil, dengan test regresi per jalur.
9. **Kriteria keberhasilan:** 10 save berurutan dari 3 jalur berbeda → 10 file unik; gallery menampilkan semua; setiap save memicu tepat satu toast.

#### QW4 — Error boundary + `aria-live` untuk toast

1. **Masalah:** Satu exception = layar putih; toast tidak terbaca screen reader (B13/B14).
2. **Relevansi:** Aplikasi berjalan di tray saat gaming; crash total berarti kehilangan buffer.
3. **Cara kerja:** `ErrorBoundary` kelas di sekitar `<App/>` dengan fallback "Restart ClipFlow" + tombol "Copy diagnostics"; `aria-live="polite"` + `role="status"` pada container toast.
4. **Komponen:** `main.tsx`, `App.tsx`.
5. **Ketergantungan:** Tidak ada.
6. **Kompleksitas:** Rendah.
7. **Dampak:** Crash parsial tidak mematikan aplikasi; aksesibilitas dasar.
8. **Risiko:** Sangat rendah.
9. **Kriteria keberhasilan:** Melempar error buatan di sebuah view → fallback tampil, tab lain tetap dapat diakses setelah reload; axe/Lighthouse tidak melaporkan pelanggaran `aria-live`.

#### QW5 — Jadikan gallery dapat dioperasikan keyboard

1. **Masalah:** Kartu klip tidak bisa difokus/dibuka dengan keyboard (U7/B13).
2. **Relevansi:** Aplikasi desktop; keyboard navigation adalah ekspektasi dasar.
3. **Cara kerja:** `role="button"`, `tabIndex={0}`, `onKeyDown` (Enter/Space = buka, `x` = pilih, `Delete` = hapus dengan konfirmasi), `aria-selected` saat select mode, `aria-label` deskriptif pada setiap tombol ikon (bukan hanya `title`).
4. **Komponen:** `GalleryGrid.tsx`, `App.tsx` (shortcut handler).
5. **Ketergantungan:** Tidak ada.
6. **Kompleksitas:** Rendah-sedang.
7. **Dampak:** Aksesibilitas penuh + navigasi cepat untuk power user.
8. **Risiko:** Rendah — pastikan handler tidak bertabrakan dengan hotkey global (yang ditangani Rust, bukan DOM).
9. **Kriteria keberhasilan:** Seluruh alur (buka, favorit, hapus, batch) dapat diselesaikan tanpa mouse.

#### QW6 — Persistenkan thumbnail antar sesi

1. **Masalah:** Setiap launch, semua thumbnail di-decode ulang (P6).
2. **Relevansi:** Library tumbuh seiring waktu; biaya decode tumbuh linear.
3. **Cara kerja:** Simpan PNG hasil `extract_thumbnail` ke `%APPDATA%\ClipFlow\thumbs\<hash(path+size+mtime)>.png`; muat dari disk lebih dulu; prunes otomatis seperti `probe_cache` (retain yang masih terlihat). Bisa disatukan dengan `probe_cache.json`.
4. **Komponen:** `library.rs` (cache), `thumbCache.ts` (tetap LRU di memori), `commands.rs` (`get_clip_thumbnail` cek disk dulu).
5. **Ketergantungan:** Tidak ada (pola sudah ada di `ProbeCache`).
6. **Kompleksitas:** Rendah-sedang.
7. **Dampak:** Waktu buka tab Clips turun signifikan pada library besar; decode MF hanya sekali per klip per versi file.
8. **Risiko:** Disk usage tambahan (~20-60 KB/klip). Mitigasi: cap ukuran folder + LRU prune.
9. **Kriteria keberhasilan:** Launch kedua dengan 100 klip → 0 panggilan decode MF (diverifikasi via log counter); folder thumbs < 1% ukuran library.

#### QW7 — Update check jadi opt-in + klaim privasi akurat

**Rekomendasi saya (keputusan #2): opt-in, default `false`, plus badge pasif di Settings.**

1. **Masalah:** Klaim "no background updater" / "never opens an outbound socket" vs `check()` tanpa syarat setiap startup (B10).
2. **Relevansi:** Kepercayaan adalah proposisi nilai utama produk ini. Satu request keluar yang tidak diumumkan merusak seluruh klaim privasi, sekalipun request itu tidak berbahaya.
3. **Cara kerja:**
   - Tambah `settings.check_updates_on_startup: bool` dengan `#[serde(default)]` → **default `false`**. Pengguna lama otomatis berhenti melakukan request keluar setelah update, tanpa migrasi.
   - `App.tsx:280-293` — bungkus `check()` dengan `if (settings.checkUpdatesOnStartup)`.
   - `SettingsPanel.tsx` → Application & Updates — tambah toggle "Check for updates at startup" dengan hint eksplisit: *"Sends one HTTPS request to github.com for the signed release manifest. No telemetry, no identifiers."*
   - Tambah badge pasif (bukan toast) di baris "Check for updates" bila pemeriksaan startup dimatikan: *"Startup check off — click to check manually."* Ini menjaga penemuan update tanpa memaksa jaringan.
   - Perbaiki teks: `README.md:51` ("Zero Telemetry" — tetap benar, tapi hapus/ubah klaim "no background updater" bila toggle dinyalakan), `tauri.conf.json:60` (`longDescription`), dan komentar `lib.rs:43-44`.
   - Alternatif yang ditolak: membiarkan default `true` + disclosure di onboarding. Ditolak karena tetap berarti aplikasi menghubungi internet sebelum pengguna sempat membaca apa pun.
4. **Komponen:** `settings.rs`, `commands.rs` (`SettingsPatch`), `App.tsx`, `SettingsPanel.tsx`, `types.ts`, `README.md`, `tauri.conf.json`.
5. **Ketergantungan:** Tidak ada.
6. **Kompleksitas:** Rendah.
7. **Dampak:** Klaim privasi menjadi benar secara harfiah. Tidak ada request keluar tanpa tindakan pengguna.
8. **Risiko:** Pengguna melewatkan update keamanan. Mitigasi: badge pasif di Settings + toast sekali saat rilis major (hanya bila pengguna membuka Settings, bukan saat startup). Trade-off ini disengaja: produk yang menjual privasi harus mengutamakan privasi di atas kemudahan distribusi update.
9. **Kriteria keberhasilan:** Dengan settings default, **0 request keluar** saat startup (diverifikasi dengan proxy lokal / `netstat`); toggle ON menghasilkan tepat 1 request; README dan `longDescription` tidak lagi memuat klaim yang bertentangan.

#### QW8 — Hapus GIF export & HUD overlay (keputusan: dihapus)

**Keputusan produk: keduanya dihapus, bukan dihidupkan kembali.** Rencana di bawah sudah final dan dapat dieksekusi apa adanya.

1. **Masalah:** ~1.800 baris kode mati + 2 dependency tak terpakai + capability berlebih (B11). GIF export (825 baris, 16 test) dan HUD overlay (≈120 baris + 2 field settings) sama-sama tidak punya jalur hidup, tetapi tetap dikompilasi dan dirawat.
2. **Relevansi:** Mengurangi beban kognitif, waktu kompilasi, dan ukuran binary sebelum menambah fitur. Kode mati yang punya test justru paling menyesatkan: ia terlihat "dijaga" padahal tidak dipakai.
3. **Cara kerja (daftar hapus yang presisi):**

   **A. GIF export — hapus total**
   - Hapus file `src-tauri/src/media/gif.rs` (825 baris).
   - `src-tauri/src/media/mod.rs:4` — hapus `pub mod gif;`.
   - `src-tauri/src/commands.rs:353-417` — hapus `GifExportResult` + `export_clip_gif` (termasuk komentar doc-nya).
   - `src-tauri/src/lib.rs:207` — hapus `commands::export_clip_gif,` dari `invoke_handler`.
   - `src-tauri/Cargo.toml:58-59` — hapus `gif = "0.13"` dan `color_quant = "1.1"` (verifikasi: 0 penggunaan lain di source).
   - `src/lib/bridge.ts:604-621` — hapus method `exportGif`.
   - `src/lib/types.ts:102-115` — hapus interface `GifExportResult`.
   - Efek samping: 16 unit test hilang (memang tidak menguji apa pun yang hidup). Test Rust turun 44 → 28.

   **B. HUD overlay — hapus total**
   - `src-tauri/src/commands.rs:951-1072` — hapus blok mandiri: `set_window_excluded_from_capture` (kedua varian cfg), `force_topmost` (kedua varian cfg), dan `set_hud_visible`. **Terverifikasi tidak ada pemanggil di luar blok ini.**
   - `src-tauri/src/commands.rs:771` — hapus `pub hud_enabled: Option<bool>` dari `SettingsPatch`.
   - `src-tauri/src/commands.rs:891-895` — hapus cabang `if let Some(v) = patch.hud_enabled`.
   - `src-tauri/src/settings.rs:78-81` — hapus field `hud_enabled` + komentar legacy-nya.
   - `src-tauri/src/settings.rs:112-115` — hapus field `hud_position`.
   - `src-tauri/src/settings.rs:159` dan `:168` — hapus dua inisialisasi di `Default`.
   - Catatan migrasi: `settings.json` lama yang masih memuat `hud_enabled`/`hud_position` tetap **parse dengan aman** karena serde mengabaikan field tak dikenal secara default. Tidak perlu migrasi, tidak ada risiko kehilangan settings.

   **C. Perintah tanpa pemanggil — hapus (keputusan: hapus, bukan beri pemanggil)**
   - `read_clip_as_data_url` (`commands.rs:713-737` + `lib.rs:222`): dihapus. Jalur preview memakai `asset:` protocol; B4 akan memperbaiki scope-nya.
   - `get_system_report` (`commands.rs:1324-1343` + `lib.rs:244`) beserta struct `SystemReport`: dihapus.
   - `get_output_dir` (`commands.rs:1264-1267` + `lib.rs:227`): dihapus — `settings.outputDir` sudah tersedia lewat `get_settings`.
   - `show_main_window` (`commands.rs:1300-1308` + `lib.rs:242`): dihapus — tray menangani ini langsung di `lib.rs:303-309`.
   - `set_toggle_hotkey` (`commands.rs:1286-1298` + `lib.rs:240`): dihapus — `update_settings` menangani rebind kedua hotkey.
   - `simulate_device_loss` (`commands.rs:1427-1430` + `lib.rs:246`): **dipertahankan** sebagai jalur diagnosa manual lewat `invoke` (berguna untuk uji B15), tetapi hapus pembungkus `bridge.ts:714-720` yang tidak dipakai UI agar tidak terlihat seperti fitur.

   **D. Dependency, feature, dan capability**
   - `Cargo.toml:44-45` — hapus `once_cell` dan `crossbeam-channel` (0 penggunaan).
   - `Cargo.toml:66-99` — hapus feature `windows` yang 0 referensi: `Win32_System_Variant`, `Win32_System_LibraryLoader`, `Win32_Security`, `Win32_UI_HiDpi`, `Win32_Graphics_Gdi`, `Win32_Graphics_Direct3D_Fxc`, `Win32_Media_Audio_Endpoints`, `Win32_Media_KernelStreaming`, `Win32_Storage_FileSystem`, `Win32_Storage_Packaging_Appx`. **Peringatan:** `Win32_Graphics_Gdi` dan `Win32_UI_WindowsAndMessaging` harus diverifikasi ulang setelah HUD dihapus — `WindowsAndMessaging` masih dipakai `foreground.rs:24,44` sehingga **wajib dipertahankan**.
   - `capabilities/default.json:5` — hapus `"trimmer"` dari daftar `windows` (tidak ada window berlabel itu).
   - `capabilities/default.json:35-46` — hapus tiga entri `fs:*` (plugin fs tidak diimpor frontend sama sekali; semua I/O file lewat perintah Rust).
   - `src-tauri/Cargo.toml:31` — pertimbangkan hapus `tauri-plugin-fs` bila `fs:*` capability dihapus dan tidak ada pemakaian lain.
4. **Komponen:** `Cargo.toml`, `media/mod.rs`, hapus `media/gif.rs`, `commands.rs`, `settings.rs`, `lib.rs`, `capabilities/default.json`, `types.ts`, `bridge.ts`.
5. **Ketergantungan:** Tidak ada. **Tidak lagi menunggu konfirmasi** — keputusan sudah diambil.
6. **Kompleksitas:** Rendah (mekanis), menyentuh banyak file tetapi setiap perubahan adalah penghapusan.
7. **Dampak:** Binary lebih kecil, waktu kompilasi turun, permukaan serangan menyempit (`fs:*` hilang), dan yang terpenting: kode yang tersisa benar-benar kode yang hidup.
8. **Risiko:** Rendah. Risiko utama hanyalah menghapus sesuatu yang masih dipakai — dimitigasi dengan `cargo build --release` + `cargo test` + `tsc` setelah setiap langkah, dan dengan fakta bahwa semuanya sudah diverifikasi 0 pemanggil.
9. **Kriteria keberhasilan:**
   - `cargo build --release` dan `cargo test` hijau; `npm run typecheck` + `npm test` hijau.
   - Tidak ada peringatan `dead_code` baru.
   - `cargo tree` tidak lagi memuat `gif` dan `color_quant`.
   - `settings.json` lama (dengan `hud_enabled`/`hud_position`) tetap termuat tanpa error — uji dengan file fixture.
   - Baseline baru dicatat: ukuran `dist/index.html` (< 421.835 byte) dan ukuran binary release.

---

### 8.2 High Impact

#### HI1 — Simpan "last N detik" langsung dari deck + hotkey kedua

1. **Masalah:** Saat ini deck hanya menyimpan seluruh buffer. Jika buffer 120 s tapi pengguna hanya butuh 20 s terakhir, ia harus save 120 s lalu trim — dua langkah, dua file, dan 100 s footage terbuang.
2. **Relevansi:** Mesin **sudah mendukung** `max_seconds` (`save_instant_replay(max_seconds)` → `ring.snapshot(Some(s))`). Fitur ini hanya perlu UI + satu hotkey. Biaya implementasi sangat rendah untuk nilai tinggi.
3. **Cara kerja:** Deck mendapat pemilih durasi simpan ("Simpan 15/30/60 s terakhir") berdampingan dengan tombol Save; Settings mendapat hotkey ketiga (`hotkey_save_short` + durasi). Tray sudah punya "Save last 30 s" — jadikan konsisten dengan jalur baru.
4. **Komponen:** Frontend (`BufferStatusCard`, `SettingsPanel`), Rust (`settings.rs` + `SettingsPatch` + `hotkeys.rs` untuk hotkey ketiga).
5. **Ketergantungan:** QW3 (satu jalur flush).
6. **Kompleksitas:** Rendah.
7. **Dampak:** Alur "simpan momen spesifik" menjadi satu klik, bukan tiga.
8. **Risiko:** Kebingungan antara "buffer duration" dan "save duration". Mitigasi: label eksplisit ("Buffer 120 s · Simpan 30 s terakhir").
9. **Kriteria keberhasilan:** Klip yang dihasilkan berdurasi ≤ N+1 s (satu GOP); ≥90% sesi uji menggunakan tombol ini alih-alih Save penuh (diukur dari `triggered_by` lokal, tanpa telemetri).

#### HI2 — ~~Track audio terpisah (game / mic) dengan remux saat export~~ → **DITOLAK (keputusan produk)**

**Status: tidak dikerjakan.** Pemilik produk memutuskan audio **tetap di-mix menjadi satu track AAC** (perilaku saat ini di `audio.rs` + `recorder.rs:1968-1998`).

**Alasan keputusan ini dipertahankan:**
- Satu track menjamin kompatibilitas penuh: VLC, Windows Media Player, Discord, Slack, Teams, editor video, dan player bawaan Windows semuanya memutar track pertama tanpa konfigurasi.
- Jalur audio saat ini sudah menangani kasus sulit dengan benar: timestamp QPC tunggal untuk A/V, silence injection, deteksi device-loss, dan retry 1 detik (`audio.rs:566-607`). Menambah encoder kedua menggandakan permukaan kegagalan tepat di hot path yang sudah rapuh.
- Mix balance **sudah bisa diatur live** sebelum rekaman (`gameVolume`/`micVolume`, permille gain). Yang hilang hanyalah koreksi *setelah* rekaman — kebutuhan yang belum terbukti dari data pengguna mana pun di repo ini.

**Konsekuensi yang harus diterima (dicatat sebagai batasan produk, bukan bug):**
- Pengguna tidak dapat memisahkan atau mematikan mic setelah klip tersimpan. Jika ini menjadi keluhan berulang, jalur termurah adalah **remux audio-only** pada export (video tetap stream-copy) — bukan dua track saat capture.
- F11 di §3.1 tetap berstatus "Tidak ada" secara sengaja.

**Yang tetap direkomendasikan sebagai pengganti (biaya jauh lebih rendah):** ST2 (kalibrasi drift A/V) — karena masalah audio yang paling sering dikeluhkan pada capture WASAPI adalah *sinkronisasi*, bukan *pemisahan track*.

#### HI3 — Guard ruang disk + kegagalan simpan yang dapat dipulihkan

1. **Masalah:** Tidak ada pemeriksaan ruang disk sebelum flush. Pada disk penuh, pengguna mendapat error (dan saat ini state macet — B1) setelah momen berharga hilang.
2. **Relevansi:** Rekaman game berukuran besar; disk penuh adalah skenario nyata pada laptop gaming.
3. **Cara kerja:** Sebelum mux, estimasi kebutuhan (`ring_bytes` sebagai batas atas) dan bandingkan dengan `GetDiskFreeSpaceExW`. Jika kurang: tampilkan toast actionable ("Sisa 1,2 GB — klip 60 s butuh ~140 MB. Kosongkan disk atau pilih folder lain."), tawarkan "Simpan 15 s terakhir" sebagai fallback, dan **jangan** masuk state Flushing.
4. **Komponen:** `recorder.rs` (pre-check), `commands.rs`, `App.tsx` (dialog fallback), `power.rs` (pola syscall sudah ada).
5. **Ketergantungan:** QW1.
6. **Kompleksitas:** Sedang.
7. **Dampak:** Mencegah kehilangan momen yang tidak dapat diulang; memberi jalan keluar.
8. **Risiko:** Estimasi bisa salah (VBV overshoot). Mitigasi: gunakan `hard_byte_cap` sebagai estimasi konservatif + margin 10%.
9. **Kriteria keberhasilan:** Simulasi disk penuh (folder dengan kuota) → tidak ada state macet, tidak ada file parsial, pengguna melihat opsi fallback yang berfungsi.

#### HI4 — Dekomposisi `App.tsx` + hook khusus

1. **Masalah:** 2.138 baris, 5 layar, 34 `useState` + 1 `useReducer`, 13 `useEffect` di satu komponen (A1). Setiap `stats` tick (1 Hz) me-render ulang seluruh tree.
2. **Relevansi:** Semua fitur berikutnya akan menambah file ini. Utang dengan bunga tertinggi.
3. **Cara kerja:** Ekstrak `views/HomeView`, `ClipsView`, `ProfilesView`, `StatsView`, `SettingsView`; ekstrak hook `useEngineStats` (subscribe + throttle), `useForegroundPoll`, `useEcoPolicy`, `useLibraryActions`, `useGalleryFilters`. Pindahkan `stats` ke context/selector agar hanya komponen yang memakainya yang re-render.
4. **Komponen:** `src/App.tsx`, folder `src/views/`, `src/hooks/`.
5. **Ketergantungan:** Tidak ada; dapat dikerjakan bertahap per tab.
6. **Kompleksitas:** Sedang (mekanis, berisiko rendah jika per-tab).
7. **Dampak:** Kecepatan pengembangan naik; re-render turun; testability naik (hook bisa diuji tanpa DOM).
8. **Risiko:** Regresi perilaku diam-diam (mis. urutan effect). Mitigasi: satu PR per tab, tanpa perubahan visual, verifikasi manual checklist per tab.
9. **Kriteria keberhasilan:** `App.tsx` < 300 baris; tidak ada file > 600 baris di `src/`; jumlah re-render HomeView per detik = 1 (diukur dengan React Profiler).

#### HI5 — Perbaiki kebenaran tipe Rust ↔ TypeScript

1. **Masalah:** Mirror manual 240 baris tanpa gate (A9). Sudah ada drift (`audio_drift_ms` mati, `hud_*` hilang).
2. **Relevansi:** Setiap perubahan backend berpotensi menghasilkan bug runtime yang tidak terdeteksi `tsc`.
3. **Cara kerja:** Pilih satu: (a) `ts-rs` atau `typeshare` untuk generate `types.ts` dari struct Rust, dijalankan di CI (`cargo test` gagal jika output berbeda); atau (b) test Rust yang mem-`serde_json::to_value` setiap payload dan membandingkan dengan snapshot JSON, plus test TS yang mem-parse snapshot itu.
4. **Komponen:** `Cargo.toml` (dev-dependency), `src/lib/types.ts` (generated), CI.
5. **Ketergantungan:** Keputusan menambah dev-dependency (justifikasi: mencegah bug kelas ini, bukan gaya).
6. **Kompleksitas:** Sedang.
7. **Dampak:** Drift menjadi mustahil; field mati seperti `audio_drift_ms` akan terlihat.
8. **Risiko:** Menambah langkah build. Mitigasi: generate on-demand + CI check, bukan build step wajib.
9. **Kriteria keberhasilan:** Menambah field di `EngineStats` tanpa update `types.ts` → CI merah.

#### HI6 — Test untuk logika paling kritis yang belum teruji

1. **Masalah:** `RollingRingBuffer::prune/snapshot` — inti produk — **0 unit test**. Yang teruji hanya `is_integrated_gpu` (5 test). `mux` tidak teruji. Tidak ada test IPC end-to-end.
2. **Relevansi:** B2, B5, B15 semuanya berada di kode yang tidak teruji. Test di sini akan mencegah regresi kelas P1.
3. **Cara kerja:** Tambah unit test murni (tanpa Windows) untuk: eviction GOP-aligned; `snapshot(Some(n))` memilih keyframe yang benar; `span_seconds`; prune audio; `set_window` mengubah cap; `force_key` tidak hilang saat submit di-drop. Plus satu integration test `headless-sim` yang menjalankan `start → push sintetis → flush → probe hasil`.
4. **Komponen:** `recorder.rs` (`#[cfg(test)]`), `tests/` baru.
5. **Ketergantungan:** QW2 (agar test cap bermakna).
6. **Kompleksitas:** Sedang.
7. **Dampak:** Menutup blind spot terbesar. Fitur `headless-sim` sudah ada dan dirancang untuk ini — manfaatkan.
8. **Risiko:** Rendah.
9. **Kriteria keberhasilan:** ≥15 test baru untuk ring/snapshot; setiap bug B1/B2/B5 memiliki test regresi yang gagal sebelum perbaikan dan lulus sesudahnya.

---

### 8.3 Strategic Features

#### ST1 — Bookmark saat bermain (marker ringan tanpa menyimpan file)

1. **Masalah:** Pengguna sering ingin menandai momen ("boss kill") tetapi belum tahu apakah layak disimpan; menyimpan semua klip memenuhi disk.
2. **Relevansi:** Ring buffer menyimpan timestamp; bookmark hanya perlu mencatat offset relatif dan menandai GOP agar tidak di-prune sebelum diputuskan.
3. **Cara kerja:** Hotkey ketiga menandai `now - k*s` di ring; deck menampilkan daftar marker sesi; pengguna memilih marker → flush segmen itu saja. Marker kedaluwarsa bersama buffer.
4. **Komponen:** `recorder.rs` (marker list + proteksi eviction), `hotkeys.rs`, `commands.rs`, `App.tsx`, `settings.rs`.
5. **Ketergantungan:** HI1 (save N detik), QW3.
6. **Kompleksitas:** Sedang-tinggi (proteksi eviction harus hati-hati agar tidak melanggar batas memori).
7. **Dampak:** Alur kerja kreator yang benar-benar baru; ClipFlow menjadi alat *seleksi*, bukan hanya perekam.
8. **Risiko:** Marker terlindungi bisa membuat ring melebihi `hard_byte_cap`. Mitigasi: batas keras jumlah marker (mis. 10) dan total byte terlindungi (mis. 25% cap).
9. **Kriteria keberhasilan:** 10 marker dalam buffer 120 s → semua dapat disimpan individual; memori tidak melebihi cap + margin; tidak ada marker yang hilang diam-diam (toast bila terpaksa dibuang).

#### ST2 — Sinkronisasi audio-video yang dapat dikalibrasi (dan field `audio_drift_ms` yang sudah disiapkan)

1. **Masalah:** `EngineStats.audio_drift_ms` ada tetapi selalu 0 — menandakan niat yang belum selesai. Drift A/V halus (10-40 ms) adalah keluhan umum pada capture WASAPI, terutama dengan mic Bluetooth.
2. **Relevansi:** Klaim README "monotonic timestamp synchronization" benar secara desain, tetapi tidak ada cara mengukur atau mengoreksi residu.
3. **Cara kerja:** (a) hitung drift nyata di thread audio (bandingkan PTS AAC kumulatif vs `clock.now_hns()`), tulis ke field; (b) tampilkan di diagnostics; (c) sediakan slider offset ±200 ms di Settings (per device), diterapkan sebagai offset PTS di muxer.
4. **Komponen:** `audio.rs`, `recorder.rs`, `settings.rs`, `SettingsPanel.tsx`, `types.ts`.
5. **Ketergantungan:** HI5 (agar field benar-benar tersinkron).
6. **Kompleksitas:** Sedang.
7. **Dampak:** Menghilangkan kelas keluhan "audio telat"; memberi alat diagnosa yang selama ini tidak ada.
8. **Risiko:** Offset yang salah bisa memperburuk. Mitigasi: default 0, hanya manual, dengan preview 10 s.
9. **Kriteria keberhasilan:** `audio_drift_ms` non-nol pada mesin dengan mic Bluetooth; setelah kalibrasi, selisih klip vs sumber < 20 ms (diukur dengan tes clap/sync pattern).

#### ST3 — Manajemen penyimpanan cerdas (kuota + tiering)

1. **Masalah:** Satu-satunya kontrol adalah "hapus klip lebih tua dari N hari" (`auto_cleanup_days`). Pengguna dengan SSD 512 GB akan kehabisan ruang, dan cleanup berbasis waktu menghapus klip favorit.
2. **Relevansi:** Library, favorit, dan tag sudah ada — cukup tambahkan kebijakan.
3. **Cara kerja:** Kuota total (mis. 50 GB) + aturan eviction: (1) jangan pernah hapus favorit, (2) urutkan berdasarkan skor (umur × ukuran ÷ favorit ÷ tag), (3) tampilkan pratinjau "akan menghapus 12 klip (3,4 GB)" sebelum eksekusi, (4) jalankan saat startup atau saat kuota terlampaui.
4. **Komponen:** `library.rs`/`commands.rs` (kebijakan), `settings.rs`, `SettingsPanel.tsx`, `StatsPanel.tsx` (visualisasi kuota).
5. **Ketergantungan:** Data favorit/tag (sudah ada).
6. **Kompleksitas:** Sedang.
7. **Dampak:** Mencegah kegagalan simpan karena disk penuh (melengkapi HI3) tanpa mengorbankan klip terbaik.
8. **Risiko:** Penghapusan otomatis yang salah = kehilangan data. Mitigasi: dry-run default, konfirmasi eksplisit, dan opsi pindahkan ke folder arsip alih-alih hapus.
9. **Kriteria keberhasilan:** Kuota tercapai → tidak ada favorit terhapus dalam 100 iterasi simulasi; pengguna melihat pratinjau sebelum eksekusi.

#### ST4 — Integrasi "kirim ke" yang sadar batas platform

1. **Masalah:** Saat ini hanya copy file ke clipboard (`copy_clip_to_clipboard`). Discord membatasi 10 MB (25 MB Nitro), Twitter/X 512 MB tapi ada batas durasi, dan pengguna harus mengompres manual.
2. **Relevansi:** Distribusi klip adalah tujuan akhir dari seluruh alur. Tanpa langkah ini, pengguna keluar dari ClipFlow.
3. **Cara kerja:** Preset ekspor ("Discord 10 MB", "Discord Nitro 25 MB", "X 512 MB") yang menghitung bitrate target dari durasi, lalu re-encode video (satu-satunya jalur yang butuh re-encode — harus jelas berbeda dari trim lossless). Tombol "Copy for Discord" menjalankan preset lalu menaruh hasilnya di clipboard.
4. **Komponen:** `library.rs` (re-encode via MF transcode), `commands.rs`, `ClipTrimmerModal.tsx`, `types.ts`.
5. **Ketergantungan:** MF transcode path (belum ada; saat ini semua stream-copy).
6. **Kompleksitas:** Tinggi.
7. **Dampak:** Menutup loop "rekam → edit → bagikan" tanpa aplikasi lain.
8. **Risiko:** Re-encode bisa lambat (bukan lagi < 50 ms) dan menghasilkan kualitas lebih rendah. Mitigasi: progres + estimasi waktu, dan selalu pertahankan file asli.
9. **Kriteria keberhasilan:** Ekspor 30 s 1080p60 menghasilkan file < 10 MB yang dapat diunggah ke Discord; waktu proses < 3× durasi klip pada GPU hardware.

---

### 8.4 Optional / Not Recommended (belum layak)

| Ide | Alasan tidak direkomendasikan sekarang |
| :--- | :--- |
| **Cloud upload / share link** | Bertentangan langsung dengan proposisi nilai "zero telemetry, no cloud". Akan menuntut akun, biaya server, kebijakan privasi, dan kepatuhan. Tidak ada bukti permintaan pengguna di repo. |
| **AI auto-highlight / deteksi kill** | Tidak ada model, dataset, atau infrastruktur; akan menambah dependency besar dan latensi GPU yang justru merusak fokus produk (frame-time game). Klaim pemasaran tanpa bukti. |
| **Multi-monitor capture simultan** | DXGI duplication per-output memang memungkinkan, tetapi menggandakan beban encoder. Belum ada bukti kebutuhan; monitor tunggal adalah default yang benar. |
| **Plugin/scripting API** | Menambah permukaan serangan dan beban dukungan untuk basis pengguna yang belum besar. Tunda sampai ada permintaan konkret. |
| **Migrasi ke SQLite** | `clip_meta.json` + `probe_cache.json` cukup untuk ribuan entri. Migrasi menambah dependency + risiko korupsi tanpa manfaat terukur (lihat §5.4). |
| **Streaming langsung (Twitch/YouTube)** | Domain produk berbeda (broadcast vs replay). Menambah protokol jaringan, autentikasi OAuth, dan beban bandwidth yang bertentangan dengan "zero-bloat". |
| **Mobile/companion app** | `Cargo.toml` sudah menyiapkan `mobile_entry_point`, tetapi seluruh engine bergantung pada DXGI/WASAPI/Media Foundation. Tidak ada jalur realistis. |
| **Editor timeline multi-klip** | Kompleksitas sangat tinggi (butuh re-encode, transisi, project file). Concat sederhana (F29) adalah versi 20% usaha / 70% manfaat — kerjakan itu dulu jika dibutuhkan. |
| **Dark mode** | Tema 1.5.0 sengaja "low-glare off-white" dengan alasan yang didokumentasikan (mata lelah sesi panjang). Menambah tema = dua palet untuk dirawat. Tunda sampai ada permintaan. |
| **Telemetri penggunaan anonim** | Bertentangan dengan janji produk. Jika ingin data, gunakan wawancara pengguna manual. |

---

## 9. Prioritization Matrix

Kolom **Dampak**: nilai bagi pengguna/stabilitas. **Effort**: perkiraan kasar (Rendah < 1 hari, Sedang 1-3 hari, Tinggi > 3 hari). **Risiko**: risiko implementasi.

| ID | Rekomendasi | Kategori | Dampak | Effort | Risiko | Prioritas |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| QW1 | Perbaiki state machine flush + bersihkan file parsial (B1) | Perbaikan | Tinggi | Rendah | Rendah | **P0** |
| QW2 | Sinkronkan `hard_byte_cap` saat durasi berubah (B2) | Perbaikan | Tinggi | Rendah | Rendah | **P0** |
| QW3 | Satu jalur flush bersama: lock + metadata + event (B3, B6, U4) | Perbaikan | Tinggi | Sedang | Sedang | **P1** |
| B4 | Scope asset dinamis untuk output folder kustom (B4) | Perbaikan | Sedang | Sedang | Sedang | **P1** |
| B7 | Ubah perintah blocking menjadi `async` + `spawn_blocking` | Perbaikan | Sedang | Rendah | Rendah | **P1** |
| B8 | `update_settings` commit-on-success (B8) | Perbaikan | Sedang | Rendah | Rendah | **P1** |
| F45 | Tambahkan plugin single-instance | Perbaikan | Sedang | Rendah | Rendah | **P1** |
| B5 | Hentikan akumulasi audio saat privacy gate (B5) | Perbaikan | Sedang | Rendah | Rendah | **P1** |
| HI6 | Test untuk ring buffer `prune`/`snapshot` + regresi B1/B2/B5 | Testing | Tinggi | Sedang | Rendah | **P1** |
| QW4 | Error boundary + `aria-live` toast (B13, B14) | UX | Sedang | Rendah | Rendah | **P2** |
| QW5 | Gallery dapat dioperasikan keyboard (B13) | UX/A11y | Sedang | Rendah-sedang | Rendah | **P2** |
| QW6 | Thumbnail persisten antar sesi (P6) | Performance | Sedang | Rendah-sedang | Rendah | **P2** |
| QW7 | Klaim privasi akurat / update-check opt-in (B10) | Kepercayaan | Sedang | Rendah | Rendah | **P2** |
| QW8 | Hapus kode & dependency mati (B11) | Code quality | Sedang | Rendah | Rendah-sedang | **P2** |
| HI1 | Simpan "last N detik" dari deck + hotkey kedua | Fitur | Tinggi | Rendah | Rendah | **P2** |
| HI3 | Guard ruang disk + fallback simpan | Fitur/stabilitas | Tinggi | Sedang | Sedang | **P2** |
| HI4 | Dekomposisi `App.tsx` + hook khusus (A1) | Architecture | Tinggi | Sedang | Sedang | **P2** |
| HI5 | Kebenaran tipe Rust ↔ TS (A9) | Architecture | Sedang | Sedang | Sedang | **P2** |
| B9 | Snapshot PNG tidak menimpa file | Perbaikan | Rendah | Rendah | Rendah | **P3** |
| B12 | Konsistensi preset durasi, toast privacy, `ECO_FPS`, CHANGELOG | Perbaikan | Rendah | Rendah | Rendah | **P3** |
| B15 | Pastikan `force_key` tidak hilang saat encoder jenuh | Perbaikan | Rendah | Rendah | Rendah | **P3** |
| B16 | Hindari `ReleaseFrame` tanpa frame | Perbaikan | Rendah | Rendah | Rendah | **P3** |
| ST2 | Kalibrasi drift A/V + aktifkan `audio_drift_ms` | Fitur | Sedang | Sedang | Sedang | **P3** |
| ST3 | Kuota penyimpanan + eviction sadar favorit | Fitur | Sedang | Sedang | Sedang | **P3** |
| ST1 | Bookmark saat bermain | Fitur | Tinggi | Sedang-tinggi | Sedang-tinggi | **P3** |
| HI2 | ~~Track audio terpisah + remux~~ — **DITOLAK** (§0) | — | — | — | — | **Tidak dikerjakan** |
| ST4 | Preset ekspor sadar batas platform | Fitur | Sedang | Tinggi | Sedang | **P3** |

### Alasan prioritas

- **P0 hanya dua item.** Keduanya adalah kegagalan yang (a) dapat terjadi pada pengguna normal, (b) merusak janji inti produk, dan (c) diperbaiki dengan perubahan terlokalisasi berisiko rendah. Tidak ada alasan menunda.
- **P1 adalah "produk tidak boleh berbohong atau membeku".** Ini mencakup race save, UI beku, preview rusak, settings tidak konsisten, dan blind spot pengujian pada kode yang baru saja diperbaiki. Semua P1 harus selesai sebelum fitur baru.
- **P2 adalah nilai tinggi setelah fondasi stabil.** Termasuk satu fitur (HI1) yang sengaja diletakkan di P2 meskipun dampaknya tinggi, karena ia bergantung pada QW3.
- **P3** adalah perbaikan kecil, fitur yang butuh fondasi tambahan, atau pekerjaan berisiko tinggi yang harus menunggu data pengguna.
- **HI2 ditolak** (§0): audio tetap satu track mix. Baris ini dipertahankan di tabel agar keputusan tercatat dan tidak muncul kembali sebagai "ide baru" di iterasi berikutnya.
- **Tidak ada item P0 untuk keamanan** karena audit tidak menemukan kerentanan yang dapat dieksploitasi: tidak ada server, tidak ada input jaringan, CSP ketat, scope filesystem sempit, secret dikelola dengan benar. Satu-satunya isu "keamanan" adalah capability berlebih untuk plugin yang tidak dipakai (QW8, yang kini mencakup penghapusan `fs:*`).

---

## 10. Implementation Roadmap

### Tahap 1 — Stabilization (P0 + P1)

**Tujuan:** Tidak ada lagi kehilangan data, tidak ada state macet, build & alur utama terbukti.

1. **QW1** — Perbaiki `flush_to_disk`: pulihkan state di semua jalur, bersihkan file parsial. Tambah test yang memaksa mux gagal.
2. **QW2** — `set_window(seconds, bitrate)` menghitung ulang cap. Test: durasi yang diminta = durasi yang didapat.
3. **QW3** — Satukan jalur flush (lock internal, nama file unik, metadata + event bersama) untuk UI/hotkey/tray.
4. **B5** — Hentikan audio masuk ring saat privacy gate aktif.
5. **B4** — Scope asset dinamis (atau ganti ke custom protocol ber-scope) saat `output_dir` berubah.
6. **B7** — Ubah 8 perintah blocking menjadi `async` + `spawn_blocking`.
7. **B8** — `update_settings` commit-on-success.
8. **F45** — Tambah `tauri-plugin-single-instance`.
9. **HI6 (subset)** — Test regresi untuk B1, B2, B5 + unit test ring buffer.

**Gerbang keluar Tahap 1:**
- `npm run typecheck` + `npm test` + `cargo test` hijau.
- Test regresi untuk setiap bug P0/P1 ada dan gagal sebelum perbaikan.
- Uji manual: simpan saat disk penuh; ubah folder lalu buka trimmer; hapus 200 klip; jalankan dua instance; ubah buffer 60→300 s dan verifikasi `buffered_seconds` mendekati 300.

### Tahap 2 — Optimization

**Tujuan:** Mengurangi technical debt yang menghambat, meningkatkan observability dan testability.

1. **QW8** — Hapus kode mati (`gif.rs`, HUD, perintah tanpa pemanggil), dependency & feature tak terpakai, capability berlebih.
2. **HI5** — Generate/validasi `types.ts` dari struct Rust di CI.
3. **QW6** — Thumbnail persisten (reuse pola `ProbeCache`).
4. **HI4** — Dekomposisi `App.tsx` per tab (satu PR per view, tanpa perubahan visual).
5. **B7 lanjutan** — Pastikan setiap perintah punya loading state di UI.
6. **Observability** — Log terstruktur untuk flush (durasi, ukuran, hasil), device reset, dan audio recovery; expose `last_error` yang sudah ada ke halaman Diagnostics (saat ini hanya tersembunyi di disclosure).
7. **Lint gate** — Tambah `cargo clippy -D warnings`, `cargo fmt --check`, dan ESLint ke CI (saat ini tidak ada; lihat §11).
8. **HI6 (sisa)** — Integration test `headless-sim`: `start → flush → probe`.

**Gerbang keluar Tahap 2:**
- Tidak ada file > 600 baris di `src/`.
- `cargo clippy` bersih; CI menolak warning baru.
- Ukuran `dist/index.html` dan binary release tercatat sebagai baseline baru (tanpa klaim persentase).
- Launch kedua dengan 100 klip: 0 decode MF.

### Tahap 3 — Feature Development

**Tujuan:** Fitur bernilai tertinggi, terintegrasi dengan arsitektur yang ada.

1. **HI1** — Simpan "last N detik" + hotkey kedua (paling murah, nilai tinggi).
2. **HI3** — Guard ruang disk + fallback.
3. **QW4, QW5, QW7** — Aksesibilitas, error boundary, kejujuran privasi (bisa paralel, risiko rendah).
4. **ST3** — Kuota penyimpanan + eviction sadar favorit.
5. **ST2** — Kalibrasi drift A/V.
6. **ST1** — Bookmark (jika data pengguna mendukung).
7. **ST4** — Hanya jika ada bukti permintaan; butuh jalur re-encode yang belum ada. **HI2 (audio terpisah) sudah ditolak** dan tidak ada di roadmap.

Setiap fitur wajib menyertakan: validasi input, error handling yang fail-safe, test unit untuk logika murni, dan update dokumentasi.

### Tahap 4 — Validation

1. **Bandingkan sebelum/sesudah** dengan metrik yang sama: waktu buka tab Clips (100 & 1.000 klip), jumlah decode MF per sesi, jumlah request IPC per interaksi, `dist` size, binary size, jumlah test.
2. **Uji ketahanan:** disk penuh, cabut monitor, ganti resolusi saat merekam, device audio dicabut, dua instance, privasi mode berjam-jam (memantau RSS).
3. **Uji frame-time in-game** (baseline yang saat ini tidak ada): rekam 10 menit di judul target dengan Game Mode on/off, catat 1% low. Ini mengisi gap P10.
4. **Dokumentasikan** hasil di `docs/` dan perbarui `CHANGELOG.md` (sekaligus perbaiki mojibake yang ada).

---

## 11. Testing dan Acceptance Criteria

### 11.1 Kondisi pengujian saat ini (terukur)

| Aspek | Kondisi | Bukti |
| :--- | :--- | :--- |
| Test frontend | **61 test / 5 file, semua lulus, 848 ms** | `npm test` |
| Test Rust | **44 `#[test]`** | grep |
| Cakupan modul teruji (Rust) | `clipmeta` (7), `gif` (16, untuk kode mati), `library` (9), `commands` (4, hanya `split_at_seconds`), `settings` (2), `audio` (1), `recorder` (5, hanya `is_integrated_gpu`) | grep `#[test]` per modul |
| **Tidak teruji** | `RollingRingBuffer::prune/snapshot`, `flush_to_disk`, `mux`, `trim` (Windows), seluruh `hotkeys.rs`, `foreground.rs`, `power.rs`, `lib.rs`, semua handler IPC | analisis |
| Typecheck | Lulus | `npm run typecheck` |
| Lint | **Tidak ada** ESLint/Prettier/rustfmt/clippy config | tidak ada file konfigurasi |
| E2E / integrasi | **Tidak ada** | — |
| CI | `tsc` + `vitest` + `vite build` + `cargo test` di `windows-latest` | `ci.yml` |

**Penilaian:** Distribusi test tidak sejalan dengan distribusi risiko. 16 test menjaga `gif.rs` yang tidak dipakai, sementara 0 test menjaga logika ring buffer yang menentukan apakah klip bisa diselamatkan. Ini bukan soal angka coverage, tetapi soal **di mana kegagalan paling mahal**.

### 11.2 Test yang direkomendasikan (berbasis risiko)

| Prioritas | Test | Lokasi | Alasan |
| :--- | :--- | :--- | :--- |
| P1 | Eviction GOP-aligned: buffer tidak pernah diawali delta frame | `recorder.rs` `#[cfg(test)]` | Menentukan validitas MP4; B1/B2 bergantung padanya |
| P1 | `snapshot(Some(n))` memilih keyframe ≥ lower bound; `None` mengembalikan semua | `recorder.rs` | Inti "save last N s" (HI1) |
| P1 | `set_window` memperbarui `hard_byte_cap` | `recorder.rs` | Regresi B2 |
| P1 | `flush_to_disk` gagal → state pulih, tidak ada file parsial | `recorder.rs` (butuh seam/injeksi) | Regresi B1 |
| P1 | Audio tidak menumpuk saat gate aktif | `recorder.rs` | Regresi B5 |
| P1 | `force_key` tidak direset saat submit di-drop | `recorder.rs` | Regresi B15 |
| P2 | Nama file unik untuk 2 save dalam detik yang sama | `recorder.rs` | Regresi B6 |
| P2 | `update_settings` gagal di tengah → settings tidak berubah | `commands.rs` | Regresi B8 |
| P2 | `sanitize_filename` (setelah diekstrak) menolak `..`, `:`, NUL, path absolut | util baru | Keamanan file-handling |
| P2 | Integration `headless-sim`: `start → 5 s feed → flush → probe` menghasilkan durasi & audio yang benar | `tests/` | Satu-satunya test end-to-end yang mungkin tanpa Windows |
| P3 | Snapshot JSON `EngineStats`/`Settings`/`ClipMetadata` cocok dengan `types.ts` | CI | Regresi A9 |
| P3 | `selection` reducer: shift-range melintasi halaman | sudah ada, tambah kasus | Batch delete lintas halaman |

### 11.3 Acceptance criteria per perbaikan

**QW1 (flush):**
- GIVEN disk penuh / mux gagal, WHEN Alt+C ditekan, THEN `stats().state` kembali ke `Buffering`, tidak ada file `.mp4` parsial di folder, dan `EVT_ERROR` terkirim dengan pesan spesifik.
- GIVEN save berhasil, WHEN selesai, THEN perilaku identik dengan sekarang (tidak ada regresi).

**QW2 (cap buffer):**
- GIVEN buffer 60 s aktif pada 12 Mbps, WHEN pengguna memilih 300 s, THEN `buffered_seconds` mencapai ≥ 290 s setelah 300 s capture, dan `ring_bytes` tidak melebihi `ring_cap_mb(300, 12000)`.

**QW3 (jalur flush):**
- GIVEN dua save bersamaan dari UI dan hotkey, WHEN keduanya selesai, THEN ada 2 file dengan nama berbeda dan 2 event `EVT_CLIP_SAVED`.
- GIVEN tray "Save last 30 s", WHEN selesai, THEN gallery menampilkan klip baru tanpa Rescan manual.

**B4 (scope asset):**
- GIVEN `output_dir` diubah ke `D:\Clips`, WHEN trimmer dibuka, THEN video preview diputar (bukan "NO PREVIEW STREAM").

**B7 (perintah async):**
- GIVEN 200 klip terpilih, WHEN Delete dijalankan, THEN UI tetap responsif (spinner terlihat, tidak ada frame drop > 100 ms).

**QW5 (a11y):**
- GIVEN hanya keyboard, WHEN Tab masuk ke gallery, THEN fokus terlihat pada kartu pertama; Enter membuka trimmer; `x` memilih; Escape membersihkan seleksi.

**QW8 (kode mati):**
- GIVEN build release, THEN tidak ada peringatan `dead_code`; `dist/index.html` lebih kecil dari baseline 421.835 byte (catat angka baru); `cargo tree` tidak lagi memuat `gif`/`color_quant`.

---

## 12. File atau Modul yang Diperkirakan Terdampak

| Perubahan | File | Perkiraan skala |
| :--- | :--- | :--- |
| QW1, QW2, B5, B6, B15, B16 | `src-tauri/src/media/recorder.rs` | ±120 baris |
| QW3 | `recorder.rs`, `commands.rs`, `hotkeys.rs`, `lib.rs` | ±200 baris |
| B4 | `tauri.conf.json`, `lib.rs` (setup), `commands.rs` (`update_settings`) | ±40 baris |
| B7 | `commands.rs` (8 fungsi) | ±80 baris |
| B8 | `commands.rs` (`update_settings`) | ±40 baris |
| F45 | `Cargo.toml`, `lib.rs` | ±10 baris |
| HI5 | `Cargo.toml` (dev-dep), `src/lib/types.ts`, `.github/workflows/ci.yml` | ±60 baris |
| HI4 | `src/App.tsx` (dipecah), `src/views/*` (baru), `src/hooks/*` (baru) | ±1.800 baris dipindah, 0 diubah |
| QW4 | `src/main.tsx`, `src/App.tsx` | ±80 baris |
| QW5 | `src/components/GalleryGrid.tsx`, `src/App.tsx` | ±120 baris |
| QW6 | `src-tauri/src/media/library.rs`, `commands.rs`, `src/lib/thumbCache.ts` | ±120 baris |
| QW7 | `settings.rs`, `commands.rs`, `App.tsx`, `SettingsPanel.tsx`, `README.md`, `tauri.conf.json` | ±50 baris |
| QW8 | `Cargo.toml`, `media/mod.rs`, **hapus `media/gif.rs`**, `commands.rs`, `settings.rs`, `lib.rs`, `capabilities/default.json`, `types.ts`, `bridge.ts` | **−1.900 baris** (825 gif + ~120 HUD + ~120 perintah mati) |
| HI1 | `settings.rs`, `hotkeys.rs`, `commands.rs`, `BufferStatusCard.tsx`, `SettingsPanel.tsx`, `types.ts` | ±250 baris |
| HI3 | `recorder.rs`, `commands.rs`, `App.tsx`, `power.rs` | ±150 baris |
| HI6 | `recorder.rs` (`#[cfg(test)]`), `tests/` (baru) | ±400 baris test |
| ST3 | `library.rs`, `commands.rs`, `settings.rs`, `SettingsPanel.tsx`, `StatsPanel.tsx` | ±300 baris |

> **Tidak lagi ada baris untuk HI2** — audio tidak dipisah (keputusan §0).

---

## 13. Risiko Implementasi dan Mitigasi

| Risiko | Probabilitas | Dampak | Mitigasi |
| :--- | :--- | :--- | :--- |
| Perbaikan flush (QW1) mengubah perilaku sukses secara tak sengaja | Rendah | Tinggi (kehilangan klip) | Test regresi "happy path" identik bit-per-bit; uji manual 20 save sebelum merge |
| Mengubah `hard_byte_cap` menaikkan penggunaan RAM pengguna | Sedang | Sedang (mesin 8 GB) | Cap tetap `clamp(24, 1536)` MB; dokumentasikan rumus di Settings ("Estimated memory ceiling" sudah ada dan akan menjadi akurat) |
| Menyatukan jalur flush (QW3) menimbulkan deadlock | Rendah | Tinggi (engine beku) | Gunakan `try_lock` dengan timeout + pesan "Save in progress", bukan blocking lock; test dengan 10 save paralel |
| Scope asset dinamis melebarkan izin filesystem | Sedang | Sedang (keamanan) | Izinkan **hanya** direktori `output_dir` aktif (bukan seluruh drive), dicabut saat folder berubah |
| Menghapus `gif.rs`/HUD padahal akan dipakai lagi | **Sangat rendah** | Rendah (kerja ulang) | **Sudah diputuskan dihapus** (§0). Kode tetap ada di git history; pemulihan = `git revert`, bukan penulisan ulang |
| Dekomposisi `App.tsx` menimbulkan regresi perilaku | Sedang | Sedang | Satu PR per view, tanpa perubahan visual; checklist manual per tab; tidak mengubah hook logic sekaligus |
| `tauri-plugin-single-instance` mengubah perilaku startup | Rendah | Sedang | Plugin resmi; uji: instance kedua memfokuskan window pertama, buffer tidak terhenti |
| Menghapus `fs:*` capability ternyata memutus jalur yang dipakai | Rendah | Sedang | Verifikasi: 0 impor `plugin-fs` di frontend; semua I/O lewat perintah Rust. Uji setiap aksi file (save/trim/split/rename/delete/snapshot) setelah perubahan |
| Re-encode (ST4) memperlambat alur simpan | Tinggi | Rendah (jalur terpisah) | Jangan pernah di jalur Alt+C; hanya aksi eksplisit dengan progres |
| Menambah dev-dependency `ts-rs` (HI5) | Rendah | Rendah | Dev-only, tidak masuk binary; alternatif tanpa dependency: snapshot JSON |
| Migrasi settings saat menambah field baru | Sedang | Sedang | Semua field baru wajib `#[serde(default)]` (pola sudah dipakai konsisten — pertahankan) |
| Menghapus `hud_enabled`/`hud_position` merusak `settings.json` lama | **Sangat rendah** | Rendah | Serde mengabaikan field tak dikenal secara default; uji dengan fixture `settings.json` lama |

---

## 14. Pertanyaan Terbuka dan Asumsi yang Belum Terverifikasi

### 14.1 Keputusan yang sudah diambil (tidak lagi terbuka)

Semua pertanyaan pada draf pertama sudah dijawab. Lihat §0 untuk tabel ringkas.

1. **GIF export & HUD overlay → DIHAPUS.** Tidak dikembalikan. QW8 memuat daftar hapus per-baris.
2. **Update check saat startup → opt-in, default `false`.** Klaim privasi di README/`tauri.conf.json` diperbaiki agar akurat.
3. **Track audio → tetap satu track mix.** Tidak dipisah. HI2 ditolak; penggantinya ST2 (kalibrasi drift).
4. **Target minimum hardware → 8 GB RAM (minimum), 4 GB best-effort.** Lihat §19.1 untuk aturan batas buffer dan peringatan UI.
5. **Mesin uji GPU → wajib** sebelum menyentuh `recorder.rs`. Lihat §19.2.
6. **Baseline frame-time in-game → wajib** diukur sebagai gerbang keluar Tahap 1. Lihat §19.3.

### 14.2 Asumsi yang dipakai dalam laporan ini (belum diverifikasi runtime)

1. **Perilaku Tauri:** Perintah non-`async` berjalan di main thread. Sumber: dokumentasi resmi Tauri v2 (dikutip di B7). Tidak diuji langsung di mesin ini.
2. **B5 (akumulasi audio):** Disimpulkan dari pembacaan `prune()` + absennya pemeriksaan gate di thread audio. **Belum diukur** berapa MB yang benar-benar terakumulasi; perlu uji: aktifkan privacy mode 2 jam, pantau `ring_bytes` dan RSS.
3. **B15 (`force_key` hilang):** Bergantung pada apakah `pending_input` benar-benar mencapai 0 pada frame pertama setelah reset. Perlu stress test GPU.
4. **B4 (preview rusak):** Disimpulkan dari scope statis + `convertFileSrc` tanpa validasi. Perlu uji pada build native dengan `output_dir` di drive lain.
5. **Angka "≈96 s" pada B2:** Dihitung dari `ring_cap_mb(60, 12000)` = 141 MB dan bitrate nominal 12 Mbps. Bitrate CBR aktual bisa berbeda (VBV overshoot), jadi angka nyata bisa sedikit lebih tinggi/rendah. **Arah masalahnya pasti; angkanya perkiraan.**
6. **Klaim "under 50 ms" dan "80-120 MB":** Tidak diverifikasi. Tidak ada benchmark di repo. Diperlakukan sebagai klaim pemasaran, bukan fakta terukur.

### 14.3 Pemeriksaan tambahan yang diperlukan

1. **Baseline frame-time in-game** pada 3 judul target (mis. Valorant, CS2, satu AAA) dengan Game Mode on/off, mengukur 1% low dan average FPS. Tanpa ini, tidak ada klaim performa yang dapat dipertanggungjawabkan.
2. **Uji ketahanan anti-cheat:** apakah `AcquireNextFrame` dan `CreateToolhelp32Snapshot` tetap berfungsi dengan Vanguard/VAC/EAC aktif.
3. **Uji kebocoran memori** 8 jam sesi terus-menerus (RSS, `ring_bytes`, jumlah handle) — terutama dengan privacy mode dan ECO aktif.
4. **Uji kompatibilitas encoder** pada NVENC (H.264 + HEVC), AMF, QSV, dan iGPU Intel/AMD. Kode punya fallback software (`recorder.rs:1478-1492`), tetapi tidak ada test yang memverifikasi jalur HEVC.
5. **Uji dua instance** setelah plugin single-instance ditambahkan, termasuk perilaku saat instance pertama sedang flush.
6. **Uji update flow end-to-end** dari versi lama ke versi baru, termasuk verifikasi signature dan perilaku jika manifest tidak dapat dijangkau.

---

## 15. Lima Perbaikan Paling Penting

1. **Perbaiki state machine `flush_to_disk`** (B1) — satu kegagalan I/O saat ini membuat aplikasi tampak mati permanen dan memaksa restart yang menghapus buffer. Perubahan kecil, dampak menyeluruh.
2. **Sinkronkan `hard_byte_cap` saat durasi buffer berubah** (B2) — pengguna memilih 120/300 detik dan mendapat ~96 detik. Ini pelanggaran janji inti produk yang tidak terlihat sampai momen penting hilang.
3. **Satukan jalur save (lock + nama unik + metadata + event)** (B3, B6) — menghilangkan race UI/hotkey, kehilangan file akibat nama bentrok, dan tray save yang tidak memberi umpan balik.
4. **Perbaiki scope `asset:` agar mengikuti `output_dir`** (B4) — fitur yang sudah ada (preview di trimmer) rusak total setelah pengguna memindahkan folder simpan, dengan gejala yang menyesatkan.
5. **Pindahkan perintah blocking ke `async` + `spawn_blocking`** (B7) — 8 handler saat ini membekukan seluruh WebView pada operasi batch, COM, dan DXGI.

## 16. Lima Fitur Paling Layak Dikembangkan

1. **Simpan "last N detik" dari deck + hotkey kedua (HI1)** — mesin sudah mendukung `max_seconds`; ini murni pekerjaan UI + satu hotkey, dengan nilai harian tertinggi.
2. **Guard ruang disk + fallback simpan yang dapat dipulihkan (HI3)** — mengubah kegagalan fatal menjadi pilihan yang dapat ditindaklanjuti; melindungi momen yang tidak bisa diulang.
3. **Thumbnail persisten antar sesi (QW6)** — memakai pola `ProbeCache` yang sudah terbukti; menghilangkan decode ulang seluruh library setiap launch.
4. **Kuota penyimpanan dengan eviction sadar favorit (ST3)** — melengkapi guard disk dengan kebijakan jangka panjang, memakai data favorit/tag yang sudah ada.
5. **Kalibrasi drift A/V + aktifkan `audio_drift_ms` (ST2)** — field-nya sudah ada di `EngineStats` tetapi selalu 0. Ini menggantikan posisi HI2 (audio terpisah, ditolak §0): masalah audio yang paling sering dikeluhkan pada capture WASAPI adalah *sinkronisasi*, bukan *pemisahan track*, dan biayanya jauh lebih rendah.

## 17. Tiga Risiko Teknis Terbesar

1. **Kehilangan data yang tidak terlihat.** Tiga jalur berbeda (state macet B1, cap buffer B2, nama file bentrok B6) dapat menghilangkan klip tanpa pesan kesalahan. Pengguna tidak akan tahu sampai terlambat, dan kepercayaan pada alat replay sangat rapuh terhadap satu kejadian seperti ini.
2. **Kode kritis tanpa pengujian.** `RollingRingBuffer::prune/snapshot` dan `flush_to_disk` — dua fungsi yang menentukan apakah klip dapat diselamatkan — tidak memiliki satu pun unit test, sementara kode mati (`gif.rs`) punya 16. Setiap perubahan pada `recorder.rs` saat ini adalah perubahan tanpa jaring pengaman. Setelah QW8 (hapus gif), jumlah test turun 44 → 28 — itulah ukuran sebenarnya dari jaring pengaman yang ada.
3. **Beban pemeliharaan UI monolit + mirror tipe manual.** `App.tsx` 2.138 baris dan `types.ts` yang dicerminkan manual tanpa gate berarti setiap fitur baru memperlambat pengembangan berikutnya dan menambah peluang bug runtime yang tidak tertangkap `tsc`. Ini bukan risiko hari ini, tetapi menjadi penghambat utama dalam 2-3 iterasi ke depan.

## 18. Urutan Implementasi yang Paling Masuk Akal

```
Tahap 1 — Stabilization  (jangan menambah fitur apa pun di sini)
  1. QW1  flush state + file parsial        ← mulai di sini, paling berisiko & paling murah
  2. QW2  hard_byte_cap
  3. HI6a test regresi B1/B2/B5 + unit test ring buffer   ← kunci perbaikan di atas
  4. QW3  satu jalur flush
  5. B5   audio saat privacy gate
  6. B4   scope asset dinamis
  7. B7   perintah async
  8. B8   update_settings commit-on-success
  9. F45  single-instance
  ── gerbang: semua test hijau + checklist manual lulus

Tahap 2 — Optimization  (kurangi hambatan sebelum menambah beban)
 10. QW8  hapus kode mati + dependency/capability berlebih
 11. HI5  kebenaran tipe Rust ↔ TS
 12. QW6  thumbnail persisten
 13. HI4  dekomposisi App.tsx (satu PR per view)
 14. B7+  loading state untuk operasi berat
 15. Observability + lint gate (clippy/fmt/eslint) di CI
 16. HI6b integration test headless-sim
  ── gerbang: tidak ada file > 600 baris; baseline ukuran tercatat

Tahap 3 — Feature Development  (nilai tertinggi lebih dulu)
 17. HI1  save last N detik + hotkey kedua
 18. HI3  guard disk + fallback
 19. QW4/QW5/QW7  a11y, error boundary, kejujuran privasi
 20. ST3  kuota + eviction sadar favorit
 21. ST2  kalibrasi drift A/V
 22. ST1  bookmark (jika data pengguna mendukung)
 23. ST4  preset ekspor (hanya jika ada permintaan konkret)
     ── HI2 (audio terpisah) TIDAK ADA di roadmap: ditolak (§0)

Tahap 4 — Validation
 24. Ukur sebelum/sesudah dengan metrik yang sama
 25. Uji ketahanan (disk penuh, cabut monitor, device audio, 8 jam)
 26. Baseline frame-time in-game (gerbang P10)
 27. Dokumentasikan + perbaiki mojibake CHANGELOG
```

**Mengapa urutan ini:** QW1 dan QW2 dikerjakan lebih dulu karena keduanya (a) dapat merusak pengguna hari ini, (b) berisiko rendah, dan (c) menghasilkan test yang menjadi jaring pengaman untuk semua pekerjaan berikutnya. QW3 menunggu sampai QW1 stabil karena ia menyentuh tiga jalur sekaligus. Pemangkasan kode mati (QW8) sengaja **sebelum** dekomposisi UI (HI4) agar file yang dipecah tidak membawa kode mati bersamanya. Fitur baru (HI1) sengaja setelah semua itu karena ia bergantung pada QW3 dan akan jauh lebih mudah dibangun di atas `App.tsx` yang sudah dipecah.

## 19. Rekomendasi untuk Enam Keputusan (menggantikan pertanyaan terbuka)

### 19.1 Target minimum hardware — rekomendasi: 8 GB RAM minimum, 4 GB best-effort

**Alasan:** `ring_cap_mb` sudah membatasi diri di `clamp(24, 1536)` MB (`recorder.rs:593-598`). Pada 4 GB RAM, buffer 600 s @ 25 Mbps dapat memakan 1.536 MB — sepertiga sampai setengah RAM total, sebelum WebView2 (~150-250 MB) dan Windows sendiri. Itu bukan "minimum yang didukung", itu "minimum yang kebetulan tidak crash".

**Aturan yang direkomendasikan (implementasi: QW2 + HI3):**

| RAM total | Buffer maksimum yang diizinkan UI | Perilaku |
| :--- | :--- | :--- |
| ≥ 16 GB | 600 s (semua preset) | Tanpa peringatan |
| 8–15 GB | 300 s | Preset 600 s dinonaktifkan dengan tooltip |
| < 8 GB | 120 s | Peringatan saat startup + ECO disarankan otomatis aktif |

- README diubah dari "Minimum 4 GB" menjadi "**8 GB direkomendasikan**, 4 GB didukung dengan buffer terbatas".
- Settings menampilkan estimasi memori yang sudah ada (`SettingsPanel.tsx:337` — `projectedRam`) dan menandainya merah bila melebihi 25% RAM total.
- Ini bukan pembatasan buatan: ini membuat janji "80–120 MB" di README menjadi benar untuk konfigurasi default, bukan hanya untuk 60 s @ 12 Mbps.

### 19.2 Mesin uji GPU — rekomendasi: wajib sebelum menyentuh `recorder.rs`

**Alasan:** `recorder.rs` berisi ~1.000 baris `unsafe` yang menyentuh D3D11, DXGI, dan Media Foundation. `headless-sim` **tidak menjalankan satu baris pun** dari kode itu (`#[cfg(all(windows, not(feature = "headless-sim")))]`). Artinya saat ini tidak ada satu pun test otomatis yang menyentuh jalur produksi capture.

**Matriks uji minimum sebelum QW1/QW2 di-merge:**

| Jalur | Hardware | Yang diverifikasi |
| :--- | :--- | :--- |
| NVENC | NVIDIA GTX 10xx atau lebih baru | H.264 + HEVC, submit/drain, keyframe |
| AMF | AMD RX 5000 atau lebih baru | idem |
| QSV | Intel iGPU (Iris Xe / UHD) | idem + cap 720p/30 Game Mode |
| Fallback | VM tanpa hardware encoder | Jalur software MF H.264 (`recorder.rs:1478-1492`) |

Jika hardware tidak tersedia: **tunda** perubahan `recorder.rs` dan kerjakan QW4-QW8 + HI4/HI5 lebih dulu (semuanya tidak menyentuh kode capture). Ini lebih aman daripada mengubah kode unsafe tanpa kemampuan memverifikasinya.

### 19.3 Baseline frame-time in-game — rekomendasi: wajib sebagai gerbang Tahap 1

**Alasan:** README mengklaim "keep CPU and memory overhead low" dan "under 50 ms", tetapi tidak ada satu pun pengukuran di repo. Tanpa baseline, klaim "Game Mode melindungi frame rate" tidak dapat dibuktikan maupun dibantah.

**Protokol minimum (satu kali, ~2 jam):**
1. Pilih 2 judul: satu kompetitif (Valorant/CS2), satu AAA.
2. Untuk setiap judul, 10 menit gameplay identik dalam 3 kondisi: (a) ClipFlow tidak jalan, (b) armed dengan Game Mode ON, (c) armed dengan Game Mode OFF.
3. Catat: average FPS, **1% low**, 0.1% low, dan `stats.encode_ms_avg` / `stats.gpu_submit_ms_avg` dari diagnostics.
4. Simpan hasilnya di `docs/perf-baseline.md` (bukan di laporan ini, agar dapat diperbarui).

**Gerbang:** jika 1% low turun > 5% pada Game Mode ON, itu bug performa yang harus diperbaiki sebelum fitur baru. Jika turun < 2%, klaim README dapat dipertahankan dengan angka.

### 19.4 Yang **tidak** diperlukan

Tidak ada kredensial, akses produksi, data pengguna, atau secret apa pun. Aplikasi ini sepenuhnya lokal dan audit tidak menemukan kebutuhan untuk menyentuh data nyata. Ketiadaan `.env` dan tidak adanya backend berarti tidak ada permukaan data yang perlu dilindungi di luar file klip pengguna sendiri.

---

### Lampiran A — Bukti perintah yang dijalankan

| Perintah | Hasil |
| :--- | :--- |
| `npm run typecheck` | Lulus, tanpa output error |
| `npm test` | `Test Files 5 passed (5)`, `Tests 61 passed (61)`, 848 ms |
| `Get-Item dist/index.html` | 421.835 byte |
| `git log --oneline -20` | HEAD `9e9a527`; riwayat 1.4.0 → 1.5.0 terlihat |
| `git status --porcelain` | Bersih (sebelum audit); setelah audit hanya `docs/CLIPFLOW_AUDIT_REPORT.md` |
| grep `#[test]` di `src-tauri/src` | 44 kecocokan (gif 16, library 9, clipmeta 7, recorder 5, commands 4, settings 2, audio 1) |
| grep `set_hud_visible` di `lib.rs` | 0 kecocokan (tidak terdaftar) |
| grep `force_topmost`/`set_window_excluded` | Hanya di dalam blok `commands.rs:951-1072` (mandiri, aman dihapus) |
| grep `single-instance` di `Cargo.lock` | 0 kecocokan |
| grep `once_cell`/`crossbeam` di source Rust | 0 kecocokan |

| grep `plugin-fs` di frontend | 0 kecocokan |
| grep `tabIndex`/`role=` di `GalleryGrid.tsx` | 0 kecocokan |
| grep `ErrorBoundary` di `src/**/*.tsx` | 0 kecocokan |
| grep `aria-live`/`role="status"` di `src/**/*.tsx` | 0 kecocokan |
| Pencarian `.env*` (non-node_modules) | Tidak ada |

### Lampiran B — Yang tidak dilakukan (sesuai batasan audit)

- Tidak ada source code, konfigurasi, dependency, atau migrasi yang diubah.
- Tidak ada commit, push, atau deploy.
- Tidak ada akses ke layanan produksi atau data pengguna.
- Tidak ada penetration testing destruktif; analisis keamanan terbatas pada pembacaan kode dan konfigurasi.
- Tidak ada nilai secret, token, atau kunci privat yang ditampilkan. Kunci publik updater disebut sebagai fakta konfigurasi (memang publik), tanpa mereproduksi nilainya.
- Tidak ada klaim persentase peningkatan performa; semua angka bersumber dari pengukuran yang tercantum di Lampiran A atau hitungan aritmetika yang ditampilkan rumusnya.

---

## 20. Catatan Implementasi (setelah audit)

Audit ini berujung pada eksekusi. Bagian ini mencatat **apa yang benar-benar dikerjakan**, **apa yang terbukti**, dan **apa yang ternyata salah dalam audit awal** — karena laporan yang tidak mengoreksi dirinya sendiri tidak layak dipercaya.

### 20.1 Yang sudah diimplementasikan

| ID | Perubahan | Status |
| :--- | :--- | :--- |
| B1 | `flush_to_disk` memulihkan state di **semua** jalur + menghapus MP4 parsial | Selesai |
| B2 | `set_window(seconds, bitrate)` menghitung ulang `hard_byte_cap` | Selesai |
| B3 | Lock flush pindah ke `CaptureEngine`; berlaku untuk deck, hotkey, tray, auto-save | Selesai |
| B5 | Thread audio menghormati privacy gate; `prune()` membatasi audio secara independen | Selesai |
| B6 | Nama file unik (`_2`, `_3`) saat tabrakan | Selesai |
| B7 | `delete_clip`, `delete_clips`, `delete_all_clips`, `rename_clip`, `save_png_snapshot`, `get_monitors`, `get_audio_input_devices` → `async` + `spawn_blocking` | Selesai |
| B8 | `update_settings` commit-on-success (clone → save → apply → commit) | Selesai |
| B9 | Snapshot PNG tidak menimpa file | Selesai |
| B10 | Update check **opt-in, default off**; klaim README & bundle diperbaiki | Selesai |
| B11 | GIF (825 baris + 2 crate), HUD, 6 perintah mati, 2 dependency, 10 feature, `fs:*` capability dihapus | Selesai |
| B12 | IPC ganda dihapus; toast privacy diperbaiki; teks `ECO_FPS` jujur | Selesai |
| B13 | Gallery keyboard-accessible (`role`, `tabIndex`, Enter/Space/X), `aria-label` pada tombol ikon | Selesai |
| B14 | `ErrorBoundary` + toast `role="status" aria-live="polite"` | Selesai |
| B4 | Scope `asset:` diperluas runtime saat `output_dir` berubah | Selesai |
| F45 | `tauri-plugin-single-instance` 2.4.5 | Selesai |
| A4/A5 | `sanitize_file_stem` + `clip_from_write`/`publish_saved_clip` bersama | Selesai |
| HI6 | 15 test ring buffer (eviction, snapshot, generation, cap, audio) | Selesai |

### 20.2 Verifikasi yang dijalankan

| Pemeriksaan | Hasil |
| :--- | :--- |
| `cargo check` | **0 error, 0 warning** (sebelumnya 2 warning `dead_code`) |
| `cargo test` | **43 lulus** (59 sebelum penghapusan GIF; 16 test GIF memang ikut terhapus) |
| `npm run typecheck` | Lulus |
| `npm test` | **61 lulus** |
| `npm run build` | Sukses, `dist/index.html` **424,41 kB** |
| `cargo build --release` | Sukses (8m43s), binary **8,77 MB** |
| `cargo tree` | `gif` & `color_quant` hilang |
| JSON config | `tauri.conf.json` + `capabilities/default.json` valid |

### 20.3 Test regresi dibuktikan menangkap bug

Bukan sekadar "test lulus" — bug dikembalikan sementara untuk memastikan test benar-benar gagal:

- **B2 (cap buffer):** mengembalikan `set_window` tanpa update cap → **3 test gagal** (`set_window_updates_the_byte_cap_with_the_window`, `set_window_shrinks_…`, `a_300s_window_actually_holds_300s_of_packets`). Dipulihkan → lulus.
- **B5 (kebocoran audio):** mengembalikan `audio_cutoff` ke `i64::MIN` dan menghapus batas byte → test gagal dengan pesan **`audio accumulated unbounded: 18000 packets for a 30 s window`** — persis memprediksi akumulasi yang dihitung di §4 (≈86 MB/jam).

### 20.4 Koreksi terhadap audit awal

Tiga hal dalam draf pertama ternyata tidak akurat dan sudah diperbaiki:

1. **B12 — toast privacy.** Audit menyebut judul toast "terbalik". Setelah membaca ulang: `gate = true` berarti *paused*, dan judul "Privacy mode paused" memang benar. Yang salah hanya cabang `false` yang menampilkan "Privacy mode active" padahal capture justru *resumed*. Diperbaiki menjadi "Privacy mode off". **Temuan awal terlalu luas; hanya separuhnya benar.**
2. **`Win32_Graphics_Gdi` bukan feature mati.** Audit mencantumkannya sebagai tak terpakai berdasarkan grep `Graphics::Gdi` (0 hasil). Ternyata `IDXGIOutput::GetDesc` mengembalikan `DXGI_OUTPUT_DESC` yang memuat `RECT` dari feature itu. Menghapusnya **menggagalkan build** (`no method named GetDesc`). Feature sudah dipulihkan dan dicatat di sini. **Pelajaran: grep nama modul tidak cukup untuk membuktikan feature tidak dipakai — hanya compiler yang bisa.**
3. **B5 — test awal lulus secara vakum.** Versi pertama test audio memeriksa `snapshot()`, yang memfilter berdasarkan generation video terbaru; dengan video kosong hasilnya selalu kosong, sehingga assertion kebocoran lolos tanpa menguji apa pun. Test ditulis ulang memakai `audio_packets()` (akses langsung ke queue) dan baru kemudian terbukti menangkap bug. **Ini contoh kenapa "test hijau" bukan bukti sampai test-nya dilihat gagal.**

### 20.5 Yang **belum** dikerjakan (dan alasannya)

| Item | Alasan belum |
| :--- | :--- |
| **HI1** (save last N detik) | Butuh UI + hotkey ketiga; fondasi (QW3) baru selesai. Siap dikerjakan berikutnya. |
| **HI3** (guard ruang disk) | Butuh `GetDiskFreeSpaceExW` + dialog fallback; sebaiknya setelah ada uji disk-penuh nyata. |
| **HI4** (dekomposisi `App.tsx`) | Mekanis tapi besar; sebaiknya satu PR per view, bukan dicampur dengan perbaikan perilaku. |
| **HI5** (tipe Rust↔TS) | Menambah dev-dependency; perlu keputusan tim. |
| **QW6** (thumbnail persisten) | Belum; pola `ProbeCache` siap dipakai. |
| **ST1–ST4** | Fitur strategis; menunggu data pengguna. |
| **§19.2 / §19.3** (uji GPU + baseline in-game) | **Tidak bisa dilakukan di lingkungan ini** — tidak ada akses ke GPU NVIDIA/AMD/Intel maupun judul game. Perubahan `recorder.rs` diverifikasi lewat kompilasi + 15 test logika murni, **bukan** lewat uji capture nyata. |

> **Peringatan jujur:** semua perbaikan pada `recorder.rs` sudah dikompilasi untuk target Windows dan logikanya teruji, tetapi **belum pernah menjalankan DXGI/D3D11/Media Foundation sungguhan**. Jalur capture nyata (device lost, mux ke disk, encoder HEVC) tetap memerlukan verifikasi manual di mesin dengan GPU sebelum rilis. Ini bukan formalitas — lihat §19.2.

