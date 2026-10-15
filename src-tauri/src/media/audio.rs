//! WASAPI loopback + microphone capture, mixed and AAC-encoded into the same
//! rolling ring buffer that holds the video packets.
//!
//! Drift avoidance
//! ---------------
//! WASAPI hands every packet a QPC timestamp taken by the audio engine itself.
//! We convert that stamp with exactly the same [`QpcClock`] epoch the capture
//! thread uses for video, so A/V share one monotonic timeline. No resampling
//! guesswork, no "add 40 ms and hope" - the muxer just writes the stamps.
//!
//! The mic is mixed into the loopback stream in the float domain with a -3 dB
//! pad on both sources to avoid inter-sample clipping. The mix balance is
//! user-controlled: `game_gain`/`mic_gain` carry the permille volumes (0-1000)
//! set in Settings, read fresh on every loop so changes apply live without an
//! engine restart.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

use super::recorder::{
    EncodedPacket, QpcClock, RecorderError, RollingRingBuffer, TrackKind, HNS_PER_SECOND,
};

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
pub const AAC_BYTES_PER_SECOND: u32 = 24_000; // 192 kbit/s stereo

pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    handles: Vec<std::thread::JoinHandle<()>>,
}

impl AudioCapture {
    /// `status` is the engine's shared audio-error slot: the thread writes the
    /// reason it cannot capture (endpoint busy, AAC missing...) so the UI can
    /// show *why* clips come out without audio instead of guessing.
    pub fn start(
        system: bool,
        mic: bool,
        game_gain: Arc<AtomicU32>,
        mic_gain: Arc<AtomicU32>,
        ring: Arc<Mutex<RollingRingBuffer>>,
        generation: Arc<AtomicU32>,
        status: Arc<Mutex<Option<String>>>,
        clock: Arc<QpcClock>,
    ) -> Result<Self, RecorderError> {
        let stop = Arc::new(AtomicBool::new(false));
        let mut handles = Vec::new();

        if system || mic {
            let stop_c = Arc::clone(&stop);
            let gg_c = Arc::clone(&game_gain);
            let mg_c = Arc::clone(&mic_gain);
            let ring_c = Arc::clone(&ring);
            let gen_c = Arc::clone(&generation);
            let status_c = Arc::clone(&status);
            let clock_c = Arc::clone(&clock);
            let h = std::thread::Builder::new()
                .name("clipflow-audio".into())
                .spawn(move || {
                    imp::run(system, mic, gg_c, mg_c, stop_c, ring_c, gen_c, status_c, clock_c);
                })
                .map_err(|e| RecorderError::Other(format!("audio thread: {e}")))?;
            handles.push(h);
        }

        Ok(Self { stop, handles })
    }

    pub fn stop(self) {
        self.stop.store(true, Ordering::Release);
        for h in self.handles {
            let _ = h.join();
        }
    }
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(all(windows, not(feature = "headless-sim")))]
mod imp {
    use super::*;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };

    const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: windows::core::GUID =
        windows::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

    struct Endpoint {
        client: IAudioClient,
        capture: IAudioCaptureClient,
        channels: u32,
        _rate: u32,
        float: bool,
        bits: u32,
    }

    unsafe fn open_endpoint(loopback: bool) -> windows::core::Result<Endpoint> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(
            if loopback { eRender } else { eCapture },
            eConsole,
        )?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let mix = client.GetMixFormat()?;
        let wf = &*mix;

        let mut flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
        if loopback {
            // Loopback streams cannot be event driven on all drivers; poll them.
            flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
        }

        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            flags,
            20_0000, // 20 ms buffer in 100 ns units
            0,
            mix,
            None,
        )?;

        let capture: IAudioCaptureClient = client.GetService()?;
        let channels = wf.nChannels as u32;
        let rate = wf.nSamplesPerSec;
        let bits = wf.wBitsPerSample as u32;

        // Determine sample encoding (mix format is virtually always 32-bit float).
        let float = if wf.wFormatTag == 0xFFFE {
            let ext = mix as *const WAVEFORMATEXTENSIBLE;
            let subformat = unsafe { std::ptr::addr_of!((*ext).SubFormat).read_unaligned() };
            subformat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
        } else {
            wf.wFormatTag == 3
        };

        client.Start()?;
        CoTaskMemFree(Some(mix as *const std::ffi::c_void));

        Ok(Endpoint {
            client,
            capture,
            channels,
            _rate: rate,
            float,
            bits,
        })
    }

    unsafe fn drain_endpoint(ep: &mut Endpoint, out: &mut Vec<f32>, qpc_first: &mut Option<i64>) -> bool {
        loop {
            let packet = match ep.capture.GetNextPacketSize() {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("[clipflow::audio] GetNextPacketSize failed (device may be reset/disconnected): {e}");
                    return false;
                }
            };
            if packet == 0 {
                return true;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            let mut dev_pos = 0u64;
            let mut qpc = 0u64;
            if let Err(e) = ep.capture.GetBuffer(
                &mut data,
                &mut frames,
                &mut flags,
                Some(&mut dev_pos),
                Some(&mut qpc),
            ) {
                log::warn!("[clipflow::audio] GetBuffer failed: {e}");
                return false;
            }
            if qpc_first.is_none() && qpc != 0 {
                *qpc_first = Some(qpc as i64);
            }

            let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
            let n = frames as usize * ep.channels as usize;
            if silent || data.is_null() {
                out.extend(std::iter::repeat(0.0).take(frames as usize * CHANNELS as usize));
            } else if ep.float {
                let src = std::slice::from_raw_parts(data as *const f32, n);
                downmix(src, ep.channels, out);
            } else if ep.bits == 16 {
                let src = std::slice::from_raw_parts(data as *const i16, n);
                let tmp: Vec<f32> = src.iter().map(|s| *s as f32 / 32768.0).collect();
                downmix(&tmp, ep.channels, out);
            } else {
                out.extend(std::iter::repeat(0.0).take(frames as usize * CHANNELS as usize));
            }
            let _ = ep.capture.ReleaseBuffer(frames);
        }
    }

    /// Any channel layout ➜ interleaved stereo.
    fn downmix(src: &[f32], channels: u32, out: &mut Vec<f32>) {
        match channels {
            1 => {
                for s in src {
                    out.push(*s);
                    out.push(*s);
                }
            }
            2 => out.extend_from_slice(src),
            n => {
                let n = n as usize;
                for frame in src.chunks_exact(n) {
                    // L = FL + 0.707*C + 0.707*SL, R = FR + 0.707*C + 0.707*SR
                    let c = frame.get(2).copied().unwrap_or(0.0) * 0.707;
                    let l = frame[0] + c + frame.get(4).copied().unwrap_or(0.0) * 0.707;
                    let r = frame[1] + c + frame.get(5).copied().unwrap_or(0.0) * 0.707;
                    out.push(l.clamp(-1.0, 1.0));
                    out.push(r.clamp(-1.0, 1.0));
                }
            }
        }
    }

    /// Media Foundation AAC encoder MFT wrapper (PCM16 stereo 48 k ➜ AAC-LC).
    struct AacEncoder {
        transform: IMFTransform,
    }

    impl AacEncoder {
        unsafe fn new() -> windows::core::Result<Self> {
            let transform: IMFTransform = CoCreateInstance(
                &AACMFTEncoder,
                None,
                windows::Win32::System::Com::CLSCTX_INPROC_SERVER,
            )?;

            let in_type = MFCreateMediaType()?;
            in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            in_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
            in_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, SAMPLE_RATE)?;
            in_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, CHANNELS)?;
            in_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            in_type.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, CHANNELS * 2)?;
            in_type.SetUINT32(
                &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                SAMPLE_RATE * CHANNELS * 2,
            )?;

            let out_type = MFCreateMediaType()?;
            out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            out_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
            out_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, SAMPLE_RATE)?;
            out_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, CHANNELS)?;
            out_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            out_type.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AAC_BYTES_PER_SECOND)?;
            out_type.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)?;
            out_type.SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)?;

            transform.SetOutputType(0, &out_type, 0)?;
            transform.SetInputType(0, &in_type, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;

            Ok(Self { transform })
        }

        unsafe fn encode(
            &self,
            pcm: &[i16],
            pts_hns: i64,
            mut sink: impl FnMut(Vec<u8>, i64, i64),
        ) -> windows::core::Result<()> {
            let bytes = pcm.len() * 2;
            let buffer = MFCreateMemoryBuffer(bytes as u32)?;
            let mut ptr: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None)?;
            std::ptr::copy_nonoverlapping(pcm.as_ptr() as *const u8, ptr, bytes);
            buffer.Unlock()?;
            buffer.SetCurrentLength(bytes as u32)?;

            let duration = (pcm.len() as i64 / CHANNELS as i64) * HNS_PER_SECOND
                / SAMPLE_RATE as i64;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(pts_hns)?;
            sample.SetSampleDuration(duration)?;
            self.transform.ProcessInput(0, &sample, 0)?;

            loop {
                let mut status = 0u32;
                let info = self.transform.GetOutputStreamInfo(0)?;
                let out_buffer = MFCreateMemoryBuffer(info.cbSize.max(4096))?;
                let out_sample = MFCreateSample()?;
                out_sample.AddBuffer(&out_buffer)?;

                let mut out = [MFT_OUTPUT_DATA_BUFFER {
                    dwStreamID: 0,
                    pSample: std::mem::ManuallyDrop::new(Some(out_sample.clone())),
                    dwStatus: 0,
                    pEvents: std::mem::ManuallyDrop::new(None),
                }];

                match self.transform.ProcessOutput(0, &mut out, &mut status) {
                    Ok(()) => {}
                    Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(()),
                    Err(e) => return Err(e),
                }

                let t = out_sample.GetSampleTime().unwrap_or(pts_hns);
                let d = out_sample.GetSampleDuration().unwrap_or(duration);
                let contiguous = out_sample.ConvertToContiguousBuffer()?;
                let mut p: *mut u8 = std::ptr::null_mut();
                let mut cur = 0u32;
                contiguous.Lock(&mut p, None, Some(&mut cur))?;
                let payload = std::slice::from_raw_parts(p, cur as usize).to_vec();
                let _ = contiguous.Unlock();
                if !payload.is_empty() {
                    sink(payload, t, d);
                }
                let _ = std::mem::ManuallyDrop::take(&mut out[0].pSample);
            }
        }
    }

    /// Opens an endpoint, reporting the failure reason into `status`. Returns
    /// `Ok(Some(ep))` on success, `Ok(None)` when the feature is disabled, and
    /// `Err` when the endpoint could not be opened (the shared `status` slot
    /// already carries the human-readable reason).
    unsafe fn open_reported(
        loopback: bool,
        status: &Mutex<Option<String>>,
    ) -> Result<Option<Endpoint>, ()> {
        match open_endpoint(loopback) {
            Ok(ep) => Ok(Some(ep)),
            Err(e) => {
                let msg = if loopback {
                    format!("system audio loopback unavailable: {e}")
                } else {
                    format!("microphone unavailable: {e}")
                };
                *status.lock() = Some(msg.clone());
                log::warn!("[clipflow::audio] {msg}");
                Err(())
            }
        }
    }

    pub(super) fn run(
        system: bool,
        mic: bool,
        game_gain: Arc<AtomicU32>,
        mic_gain: Arc<AtomicU32>,
        stop: Arc<AtomicBool>,
        ring: Arc<Mutex<RollingRingBuffer>>,
        generation: Arc<AtomicU32>,
        status: Arc<Mutex<Option<String>>>,
        clock: Arc<QpcClock>,
    ) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            if MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).is_err() {
                *status.lock() = Some("Media Foundation failed to start".into());
                CoUninitialize();
                return;
            }

            let mut loopback: Option<Endpoint> = None;
            let mut microphone: Option<Endpoint> = None;
            let mut encoder: Option<AacEncoder> = None;
            let mut last_attempt = std::time::Instant::now();

            // AAC-LC frames are 1024 samples per channel; feed the MFT in exact multiples.
            const FRAME_SAMPLES: usize = 1024 * CHANNELS as usize;
            let frame_duration_hns: i64 = (1024 * HNS_PER_SECOND) / SAMPLE_RATE as i64;

            let mut sys_pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 8);
            let mut mic_pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 8);
            let mut mixed_pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 8);
            let mut pcm = Vec::<i16>::with_capacity(FRAME_SAMPLES);
            let mut qpc_first: Option<i64> = None;

            // Audio PTS matches clock time directly.
            let mut next_pts = clock.now_hns();

            while !stop.load(Ordering::Acquire) {
                // (Re)open endpoints every second if closed or invalidated.
                if last_attempt.elapsed() >= std::time::Duration::from_secs(1) {
                    last_attempt = std::time::Instant::now();
                    if system && loopback.is_none() {
                        match open_reported(true, &status) {
                            Ok(Some(ep)) => loopback = Some(ep),
                            Ok(None) => {}
                            Err(()) => {}
                        }
                    }
                    if mic && microphone.is_none() {
                        match open_reported(false, &status) {
                            Ok(Some(ep)) => microphone = Some(ep),
                            Ok(None) => {}
                            Err(()) => {}
                        }
                    }
                    if encoder.is_none() && (loopback.is_some() || microphone.is_some()) {
                        match AacEncoder::new() {
                            Ok(e) => {
                                encoder = Some(e);
                                *status.lock() = None;
                            }
                            Err(e) => {
                                *status.lock() =
                                    Some(format!("AAC encoder unavailable: {e}"));
                                log::warn!("[clipflow::audio] AAC MFT: {e}");
                            }
                        }
                    }
                }

                if loopback.is_none() && microphone.is_none() {
                    // Nothing captured yet (device busy). Keep next_pts tracking live wall-clock
                    // so when devices arrive, audio does not start at t=0.
                    next_pts = clock.now_hns();
                    std::thread::sleep(std::time::Duration::from_millis(8));
                    continue;
                }

                let sys_start_idx = sys_pending.len();
                if let Some(ep) = loopback.as_mut() {
                    if !drain_endpoint(ep, &mut sys_pending, &mut qpc_first) {
                        loopback = None;
                    }
                }
                let mic_start_idx = mic_pending.len();
                if let Some(ep) = microphone.as_mut() {
                    if !drain_endpoint(ep, &mut mic_pending, &mut qpc_first) {
                        microphone = None;
                    }
                }

                // Apply live volume gains to newly drained samples
                let gg = game_gain.load(Ordering::Acquire) as f32 * 0.001;
                let mg = mic_gain.load(Ordering::Acquire) as f32 * 0.001;
                if gg != 1.0 && sys_pending.len() > sys_start_idx {
                    for s in sys_pending.iter_mut().skip(sys_start_idx) {
                        *s = (*s * gg).clamp(-1.0, 1.0);
                    }
                }
                if mg != 1.0 && mic_pending.len() > mic_start_idx {
                    for s in mic_pending.iter_mut().skip(mic_start_idx) {
                        *s = (*s * mg).clamp(-1.0, 1.0);
                    }
                }

                // Mix available samples into mixed_pending.
                // - If both are enabled, mix them together with -3dB headroom.
                // - If one source has samples but the other is silent/empty, pad the silent one
                //   with silence so neither the game audio nor the mic is EVER starved or dropped!
                if system && mic {
                    let common = sys_pending.len().min(mic_pending.len());
                    for i in 0..common {
                        mixed_pending.push((sys_pending[i] * 0.707 + mic_pending[i] * 0.707).clamp(-1.0, 1.0));
                    }
                    sys_pending.drain(..common);
                    mic_pending.drain(..common);

                    // If mic has excess samples (e.g. game is quiet / loopback gave 0 packets):
                    // Mix mic over silence so the mic is never dropped!
                    if sys_pending.is_empty() && mic_pending.len() >= FRAME_SAMPLES {
                        let take = (mic_pending.len() / FRAME_SAMPLES) * FRAME_SAMPLES;
                        for s in mic_pending.drain(..take) {
                            mixed_pending.push((s * 0.707).clamp(-1.0, 1.0));
                        }
                    }
                    // If system has excess samples (e.g. user is not speaking into mic):
                    if mic_pending.is_empty() && sys_pending.len() >= FRAME_SAMPLES {
                        let take = (sys_pending.len() / FRAME_SAMPLES) * FRAME_SAMPLES;
                        for s in sys_pending.drain(..take) {
                            mixed_pending.push((s * 0.707).clamp(-1.0, 1.0));
                        }
                    }
                } else if system {
                    mixed_pending.append(&mut sys_pending);
                } else if mic {
                    mixed_pending.append(&mut mic_pending);
                }

                let now_hns = clock.now_hns();

                // If elapsed time has outpaced audio samples (e.g. the game is silent so
                // loopback produced 0 packets, and nobody is speaking into the mic):
                // Inject silence so audio PTS NEVER freezes and stays in sync with video!
                if now_hns > next_pts + frame_duration_hns && mixed_pending.len() < FRAME_SAMPLES {
                    // Detect massive sleep/wake jump (> 2 seconds behind):
                    if now_hns - next_pts > HNS_PER_SECOND * 2 {
                        next_pts = now_hns;
                        mixed_pending.clear();
                    } else {
                        while now_hns > next_pts + frame_duration_hns && mixed_pending.len() < FRAME_SAMPLES * 4 {
                            mixed_pending.extend(std::iter::repeat(0.0f32).take(FRAME_SAMPLES));
                        }
                    }
                }

                // Cap the queues so runaway buffers cannot grow indefinitely
                if sys_pending.len() > FRAME_SAMPLES * 16 {
                    sys_pending.drain(..sys_pending.len() - FRAME_SAMPLES * 16);
                }
                if mic_pending.len() > FRAME_SAMPLES * 16 {
                    mic_pending.drain(..mic_pending.len() - FRAME_SAMPLES * 16);
                }
                if mixed_pending.len() > FRAME_SAMPLES * 32 {
                    mixed_pending.drain(..mixed_pending.len() - FRAME_SAMPLES * 32);
                }

                let Some(enc) = encoder.as_ref() else {
                    std::thread::sleep(std::time::Duration::from_millis(8));
                    continue;
                };

                while mixed_pending.len() >= FRAME_SAMPLES {
                    pcm.clear();
                    pcm.extend(
                        mixed_pending
                            .drain(..FRAME_SAMPLES)
                            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16),
                    );

                    let pts = next_pts;
                    next_pts += frame_duration_hns;

                    let gen = generation.load(Ordering::Acquire);
                    let ring_ref = &ring;
                    let _ = enc.encode(&pcm, pts, |payload, t, d| {
                        ring_ref.lock().push(EncodedPacket {
                            track: TrackKind::Audio,
                            data: Arc::from(payload.into_boxed_slice()),
                            pts_hns: t,
                            duration_hns: d,
                            keyframe: true,
                            generation: gen,
                        });
                    });
                }

                std::thread::sleep(std::time::Duration::from_millis(8));
            }

            if let Some(ep) = loopback.as_ref() {
                let _ = ep.client.Stop();
            }
            if let Some(ep) = microphone.as_ref() {
                let _ = ep.client.Stop();
            }
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

// ---------------------------------------------------------------------------
// Non-Windows stub
// ---------------------------------------------------------------------------

#[cfg(any(not(windows), feature = "headless-sim"))]
mod imp {
    use super::*;

    pub(super) fn run(
        _system: bool,
        _mic: bool,
        _game_gain: Arc<AtomicU32>,
        _mic_gain: Arc<AtomicU32>,
        stop: Arc<AtomicBool>,
        ring: Arc<Mutex<RollingRingBuffer>>,
        generation: Arc<AtomicU32>,
        _status: Arc<Mutex<Option<String>>>,
        _clock: Arc<QpcClock>,
    ) {
        // 21.3 ms AAC frames of silence keep the muxer path exercised.
        let frame_hns = 1024 * HNS_PER_SECOND / SAMPLE_RATE as i64;
        let mut pts = 0i64;
        while !stop.load(Ordering::Acquire) {
            ring.lock().push(EncodedPacket {
                track: TrackKind::Audio,
                data: Arc::from(vec![0u8; 384].into_boxed_slice()),
                pts_hns: pts,
                duration_hns: frame_hns,
                keyframe: true,
                generation: generation.load(Ordering::Acquire),
            });
            pts += frame_hns;
            std::thread::sleep(std::time::Duration::from_millis(21));
        }
    }
}
