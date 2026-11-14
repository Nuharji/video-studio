//! Export: the timeline becomes one FFmpeg run. Every clip is its own input (cut with -ss / -t), scaled into the frame
//! (letterboxed like in the preview), faded and made transparent where asked, and moved to its place on the timeline;
//! the video tracks are laid over a black picture from the bottom track up, the sound of all clips is mixed. Titles come
//! from the window as finished pictures (PNG, the same drawing as the preview), so FFmpeg needs no fonts.
//!
//! Encoders are the operating system's (the FFmpeg build is LGPL-only): H.264 with VideoToolbox on macOS and Media
//! Foundation on Windows (MP4 with AAC sound), VP8 + Opus (WebM) on Linux. Sound alone: WAV everywhere, M4A (AAC) on
//! macOS and Windows.

use crate::media;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, State};

fn one() -> f64 { 1.0 }

#[derive(Deserialize, Debug, Clone)]
pub struct Project {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// In the order of the window: the first video track lies on top.
    pub tracks: Vec<Track>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Track {
    /// "video" or "audio".
    pub kind: String,
    /// Video tracks: the picture is left out.
    #[serde(default)]
    pub hidden: bool,
    /// The sound is left out.
    #[serde(default)]
    pub muted: bool,
    pub clips: Vec<Clip>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Clip {
    /// "video", "image", "audio" or "text".
    pub kind: String,
    #[serde(default)]
    pub path: String,
    /// Place on the timeline, in seconds.
    pub start: f64,
    /// Where in the source the clip begins.
    #[serde(rename = "in", default)]
    pub inp: f64,
    pub dur: f64,
    #[serde(default = "one")]
    pub volume: f64,
    #[serde(default = "one")]
    pub opacity: f64,
    #[serde(rename = "fadeIn", default)]
    pub fade_in: f64,
    #[serde(rename = "fadeOut", default)]
    pub fade_out: f64,
    #[serde(default)]
    pub muted: bool,
    /// Titles: the picture of the title over the whole frame, as a PNG data URL.
    #[serde(default)]
    pub png: Option<String>,
}

/// What the file becomes.
#[derive(Deserialize, Debug, Clone)]
pub struct Output {
    /// "mp4", "webm", "m4a" or "wav".
    pub format: String,
    /// "low", "medium" or "high".
    #[serde(default)]
    pub quality: String,
}

/// The formats this computer can export to (the first is the default).
pub fn formats() -> Vec<&'static str> {
    if cfg!(any(target_os = "macos", target_os = "windows")) { vec!["mp4", "m4a", "wav"] } else { vec!["webm", "wav"] }
}

const fn is_visual(kind: &str) -> bool {
    matches!(kind.as_bytes(), b"video" | b"image" | b"text")
}

/// The length of the film: the end of the last clip that is seen or heard.
pub fn total(p: &Project) -> f64 {
    p.tracks.iter().filter(|t| !(t.hidden && t.muted) && !(t.kind == "audio" && t.muted))
        .flat_map(|t| t.clips.iter()).map(|c| c.start + c.dur).fold(0.0, f64::max)
}

/// Seconds for FFmpeg: at most 3 decimals, never "1e-7".
fn s(v: f64) -> String {
    let r = format!("{:.3}", v.max(0.0));
    let r = r.trim_end_matches('0').trim_end_matches('.');
    if r.is_empty() { "0".into() } else { r.to_string() }
}

/// Bit rate of the video: about 8 Mbit/s for Full HD at 30 frames, more or less by the number of pixels and the quality.
pub fn video_kbps(w: u32, h: u32, fps: f64, quality: &str) -> u32 {
    let px = (w.max(1) as f64) * (h.max(1) as f64) / (1920.0 * 1080.0);
    let q = match quality { "low" => 0.5, "high" => 2.0, _ => 1.0 };
    (px * 8000.0 * q * (fps / 30.0).clamp(0.5, 2.0).sqrt()) as u32
}

/// One input of the FFmpeg run: the clip, its file and whether its sound is used.
#[derive(Debug, Clone)]
pub struct Input {
    pub clip: Clip,
    pub file: String,
    /// The clip goes into the picture (on a visible video track).
    pub picture: bool,
    /// Its sound goes into the mix.
    pub sound: bool,
}

/// Which clips become inputs: pictures bottom track first (each track by time), then sounds. `has_audio` tells whether a
/// video file brings sound; `text_file` gives the file a title picture was written to.
pub fn inputs(p: &Project, has_audio: &dyn Fn(&str) -> bool, text_file: &mut dyn FnMut(&Clip) -> Result<String, String>) -> Result<Vec<Input>, String> {
    let mut out = Vec::new();
    let video = p.tracks.iter().rev().filter(|t| t.kind == "video");
    for t in video.chain(p.tracks.iter().filter(|t| t.kind == "audio")) {
        let mut clips: Vec<&Clip> = t.clips.iter().filter(|c| c.dur > 0.0).collect();
        clips.sort_by(|a, b| a.start.total_cmp(&b.start));
        for c in clips {
            if t.kind == "video" && is_visual(&c.kind) {
                let picture = !t.hidden;
                let sound = c.kind == "video" && !t.muted && !c.muted && c.volume > 0.0 && has_audio(&c.path);
                if !picture && !sound { continue; }
                let file = if c.kind == "text" { text_file(c)? } else { c.path.clone() };
                out.push(Input { clip: c.clone(), file, picture, sound });
            } else if t.kind == "audio" && c.kind == "audio" && !t.muted && !c.muted && c.volume > 0.0 {
                out.push(Input { clip: c.clone(), file: c.path.clone(), picture: false, sound: true });
            }
        }
    }
    Ok(out)
}

/// The whole FFmpeg command line (without the program) for a project, its inputs and the output file.
pub fn args(p: &Project, inputs: &[Input], out: &Output, file: &str) -> Result<Vec<String>, String> {
    let total = total(p);
    if total <= 0.0 { return Err("empty".into()); }
    let (w, h) = (p.width.max(16) / 2 * 2, p.height.max(16) / 2 * 2);
    let fps = if p.fps > 0.0 { p.fps } else { 30.0 };
    let audio_only = matches!(out.format.as_str(), "wav" | "m4a");
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y"].map(String::from).to_vec();
    let mut graph: Vec<String> = Vec::new();
    let (mut layer, mut sounds) = (Vec::new(), Vec::new());
    for (k, i) in inputs.iter().enumerate() {
        let c = &i.clip;
        if matches!(c.kind.as_str(), "image" | "text") {
            a.extend(["-loop".into(), "1".into(), "-framerate".into(), s(fps), "-t".into(), s(c.dur)]);
        } else {
            if c.inp > 0.0 { a.extend(["-ss".into(), s(c.inp)]); }
            a.extend(["-t".into(), s(c.dur)]);
        }
        a.extend(["-i".into(), i.file.clone()]);
        if i.picture && !audio_only {
            let mut f = format!("[{k}:v]setpts=PTS-STARTPTS,fps={},scale={w}:{h}:force_original_aspect_ratio=decrease,format=yuva420p,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1", s(fps));
            if c.fade_in > 0.0 { f += &format!(",fade=t=in:st=0:d={}:alpha=1", s(c.fade_in)); }
            if c.fade_out > 0.0 { f += &format!(",fade=t=out:st={}:d={}:alpha=1", s(c.dur - c.fade_out), s(c.fade_out)); }
            if c.opacity < 1.0 { f += &format!(",colorchannelmixer=aa={}", s(c.opacity.max(0.0))); }
            f += &format!(",setpts=PTS+{}/TB[v{k}]", s(c.start));
            graph.push(f);
            layer.push(k);
        }
        if i.sound {
            let mut f = format!("[{k}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume={}", s(c.volume));
            if c.fade_in > 0.0 { f += &format!(",afade=t=in:st=0:d={}", s(c.fade_in)); }
            if c.fade_out > 0.0 { f += &format!(",afade=t=out:st={}:d={}", s(c.dur - c.fade_out), s(c.fade_out)); }
            f += &format!(",adelay={}:all=1[a{k}]", (c.start * 1000.0).round() as u64);
            graph.push(f);
            sounds.push(k);
        }
    }
    // The picture: black, with every layer laid over it.
    if !audio_only {
        let last_pix = if cfg!(target_os = "windows") { "nv12" } else { "yuv420p" };
        graph.push(format!("color=c=black:s={w}x{h}:r={}:d={},format=yuva420p[base]", s(fps), s(total)));
        let mut below = "base".to_string();
        for (n, k) in layer.iter().enumerate() {
            let name = format!("o{n}");
            graph.push(format!("[{below}][v{k}]overlay=eof_action=pass:format=auto[{name}]"));
            below = name;
        }
        graph.push(format!("[{below}]format={last_pix}[vout]"));
    }
    // The sound: silence as long as the film, with every clip mixed in.
    graph.push(format!("anullsrc=r=48000:cl=stereo,atrim=duration={}[abase]", s(total)));
    let mix: String = std::iter::once("[abase]".to_string()).chain(sounds.iter().map(|k| format!("[a{k}]"))).collect();
    graph.push(format!("{mix}amix=inputs={}:normalize=0:duration=first[aout]", sounds.len() + 1));
    a.extend(["-filter_complex".into(), graph.join(";")]);
    if !audio_only { a.extend(["-map".into(), "[vout]".into()]); }
    a.extend(["-map".into(), "[aout]".into()]);
    let kbps = format!("{}k", video_kbps(w, h, fps, &out.quality));
    match out.format.as_str() {
        "wav" => a.extend(["-c:a", "pcm_s16le", "-f", "wav"].map(String::from)),
        "m4a" => a.extend(["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", "-f", "mp4"].map(String::from)),
        "webm" => {
            a.extend(["-c:v", "libvpx", "-deadline", "good", "-cpu-used", "4", "-b:v"].map(String::from));
            a.extend([kbps, "-c:a".into(), "libopus".into(), "-b:a".into(), "192k".into(), "-f".into(), "webm".into()]);
        }
        "mp4" => {
            let enc: &[&str] = if cfg!(target_os = "windows") { &["-c:v", "h264_mf"] } else { &["-c:v", "h264_videotoolbox", "-allow_sw", "1"] };
            a.extend(enc.iter().map(|x| x.to_string()));
            a.extend(["-b:v".into(), kbps, "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(), "-movflags".into(), "+faststart".into(), "-f".into(), "mp4".into()]);
        }
        f => return Err(format!("unknown format {f}")),
    }
    a.extend(["-t".into(), s(total), "-progress".into(), "pipe:1".into(), "-nostats".into(), file.to_string()]);
    Ok(a)
}

/// Writes a title's picture (PNG data URL) to a file in `dir`.
fn write_png(dir: &Path, n: usize, data: &str) -> Result<String, String> {
    let b64 = data.split_once("base64,").map(|x| x.1).unwrap_or(data);
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"\x89PNG") { return Err("title picture is not a PNG".into()); }
    let f = dir.join(format!("title-{n}.png"));
    std::fs::write(&f, bytes).map_err(|e| e.to_string())?;
    Ok(f.to_string_lossy().into_owned())
}

/// Running exports by the window's id, so they can be stopped.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<u64, (Child, bool)>>);

#[derive(Serialize, Clone)]
struct Progress {
    id: u64,
    ratio: f64,
}

/// The formats this computer exports to, and whether FFmpeg is there at all.
#[tauri::command]
pub fn export_formats() -> serde_json::Value {
    serde_json::json!({"available": media::ffmpeg_path().is_some(), "formats": formats()})
}

/// Exports the project into `file`. Progress arrives as "export-progress" events; Err("cancelled") after export_cancel.
#[tauri::command]
pub async fn export_run(app: AppHandle, jobs: State<'_, Jobs>, id: u64, project: Project, output: Output, file: String) -> Result<String, String> {
    let ffmpeg = media::ffmpeg_path().ok_or("unavailable")?;
    let dir = std::env::temp_dir().join(format!("video-studio-export-{}-{id}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let result = run(&app, &jobs, id, &ffmpeg, &dir, &project, &output, &file).await;
    let _ = std::fs::remove_dir_all(&dir);
    if result.is_err() && Path::new(&file).is_file() {
        // A half-written file is no use to anyone.
        let _ = std::fs::remove_file(&file);
    }
    result.map(|_| file)
}

#[allow(clippy::too_many_arguments)]
async fn run(app: &AppHandle, jobs: &State<'_, Jobs>, id: u64, ffmpeg: &Path, dir: &Path, project: &Project, output: &Output, file: &str) -> Result<(), String> {
    // Which video files bring sound (asked once per file).
    let mut sound: HashMap<String, bool> = HashMap::new();
    for c in project.tracks.iter().flat_map(|t| t.clips.iter()).filter(|c| c.kind == "video") {
        if !sound.contains_key(&c.path) {
            let has = media::probe(ffmpeg, Path::new(&c.path)).map(|p| p.audio).map_err(|e| format!("{}: {e}", c.path))?;
            sound.insert(c.path.clone(), has);
        }
    }
    for c in project.tracks.iter().flat_map(|t| t.clips.iter()).filter(|c| c.kind != "text") {
        if !Path::new(&c.path).is_file() { return Err(format!("missing:{}", c.path)); }
    }
    let mut n = 0;
    let list = inputs(project, &|p| sound.get(p).copied().unwrap_or(false), &mut |c| {
        n += 1;
        write_png(dir, n, c.png.as_deref().ok_or("title without picture")?)
    })?;
    let args = args(project, &list, output, file)?;
    let total = total(project);
    let log = dir.join("ffmpeg.log");
    let mut child = media::command(ffmpeg).args(&args).stdin(Stdio::null()).stdout(Stdio::piped())
        .stderr(std::fs::File::create(&log).map(Stdio::from).unwrap_or(Stdio::null())).spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("no output")?;
    jobs.0.lock().unwrap().insert(id, (child, false));
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
                let _ = app2.emit("export-progress", Progress { id, ratio: (us / 1e6 / total).clamp(0.0, 1.0) });
            }
        }
    }).await.map_err(|e| e.to_string())?;
    let (mut child, cancelled) = jobs.0.lock().unwrap().remove(&id).ok_or("lost")?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if cancelled { return Err("cancelled".into()); }
    if !status.success() {
        let text = std::fs::read_to_string(&log).unwrap_or_default();
        let tail: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        return Err(tail[tail.len().saturating_sub(3)..].join("\n"));
    }
    let _ = app.emit("export-progress", Progress { id, ratio: 1.0 });
    Ok(())
}

#[tauri::command]
pub fn export_cancel(jobs: State<Jobs>, id: u64) {
    if let Some((child, cancelled)) = jobs.0.lock().unwrap().get_mut(&id) {
        *cancelled = true;
        let _ = child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn project(v: serde_json::Value) -> Project { serde_json::from_value(v).unwrap() }

    fn sample() -> Project {
        project(json!({"width": 1920, "height": 1080, "fps": 30, "tracks": [
            {"kind": "video", "clips": [{"kind": "text", "start": 1, "dur": 2, "png": "x", "fadeIn": 0.5}]},
            {"kind": "video", "clips": [
                {"kind": "video", "path": "/m/b.mp4", "start": 3, "in": 0, "dur": 3, "opacity": 0.5},
                {"kind": "video", "path": "/m/a.mp4", "start": 0, "in": 1, "dur": 3, "fadeOut": 0.5}]},
            {"kind": "audio", "clips": [{"kind": "audio", "path": "/m/c.wav", "start": 2, "dur": 3, "volume": 0.5}]}
        ]}))
    }

    #[test]
    fn length_and_order() {
        let p = sample();
        assert_eq!(total(&p), 6.0);
        let list = inputs(&p, &|f| f.ends_with("a.mp4"), &mut |_| Ok("/tmp/title-1.png".into())).unwrap();
        let files: Vec<&str> = list.iter().map(|i| i.file.as_str()).collect();
        // Bottom track first, by time; the title (top track) after it; the sound track last.
        assert_eq!(files, ["/m/a.mp4", "/m/b.mp4", "/tmp/title-1.png", "/m/c.wav"]);
        assert_eq!(list.iter().map(|i| (i.picture, i.sound)).collect::<Vec<_>>(), [(true, true), (true, false), (true, false), (false, true)]);
    }

    #[test]
    fn command_line() {
        let p = sample();
        let list = inputs(&p, &|f| f.ends_with("a.mp4"), &mut |_| Ok("/tmp/t.png".into())).unwrap();
        let a = args(&p, &list, &Output { format: "mp4".into(), quality: "medium".into() }, "/out/film.mp4").unwrap();
        let line = a.join(" ");
        assert!(line.starts_with("-hide_banner -nostdin -y -ss 1 -t 3 -i /m/a.mp4 -t 3 -i /m/b.mp4 -loop 1 -framerate 30 -t 2 -i /tmp/t.png -t 3 -i /m/c.wav"), "{line}");
        let g = &a[a.iter().position(|x| x == "-filter_complex").unwrap() + 1];
        assert!(g.contains("[0:v]setpts=PTS-STARTPTS,fps=30,scale=1920:1080:force_original_aspect_ratio=decrease"));
        assert!(g.contains("fade=t=out:st=2.5:d=0.5:alpha=1,setpts=PTS+0/TB[v0]"));
        assert!(g.contains("colorchannelmixer=aa=0.5,setpts=PTS+3/TB[v1]"));
        assert!(g.contains("fade=t=in:st=0:d=0.5:alpha=1,setpts=PTS+1/TB[v2]"));
        assert!(g.contains("[base][v0]overlay=eof_action=pass:format=auto[o0];[o0][v1]overlay"));
        assert!(g.contains("[o2]format="));
        assert!(g.contains("[0:a]asetpts") && !g.contains("[1:a]"), "b.mp4 has no sound");
        assert!(g.contains("volume=0.5,adelay=2000:all=1[a3]"));
        assert!(g.contains("[abase][a0][a3]amix=inputs=3:normalize=0:duration=first[aout]"));
        assert!(line.ends_with("-t 6 -progress pipe:1 -nostats /out/film.mp4"));
        assert!(line.contains("-b:v 8000k"));
    }

    #[test]
    fn hidden_muted_and_sound_only() {
        let mut p = sample();
        p.tracks[1].hidden = true;   // the main video track: no picture, but still its sound
        p.tracks[2].muted = true;
        let list = inputs(&p, &|_| true, &mut |_| Ok("/t.png".into())).unwrap();
        assert_eq!(list.iter().map(|i| (i.file.as_str(), i.picture, i.sound)).collect::<Vec<_>>(),
            [("/m/a.mp4", false, true), ("/m/b.mp4", false, true), ("/t.png", true, false)]);
        let a = args(&p, &list, &Output { format: "wav".into(), quality: String::new() }, "/o.wav").unwrap();
        let g = &a[a.iter().position(|x| x == "-filter_complex").unwrap() + 1];
        assert!(!g.contains("[vout]") && !a.contains(&"[vout]".to_string()), "no picture in a sound file");
        assert!(a.join(" ").contains("-c:a pcm_s16le -f wav"));
    }

    #[test]
    fn empty_and_numbers() {
        let p = project(json!({"width": 1280, "height": 720, "fps": 25, "tracks": [{"kind": "video", "clips": []}]}));
        assert_eq!(args(&p, &[], &Output { format: "mp4".into(), quality: String::new() }, "/o.mp4").unwrap_err(), "empty");
        assert_eq!(s(1.0), "1");
        assert_eq!(s(2.5), "2.5");
        assert_eq!(s(0.1 + 0.2), "0.3");
        assert_eq!(s(-1.0), "0");
        assert_eq!(video_kbps(1920, 1080, 30.0, "medium"), 8000);
        assert_eq!(video_kbps(1920, 1080, 30.0, "high"), 16000);
        assert!(video_kbps(3840, 2160, 60.0, "medium") > 40000);
    }

    #[test]
    fn title_pictures() {
        let d = std::env::temp_dir().join(format!("video-png-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest");
        let f = write_png(&d, 1, &format!("data:image/png;base64,{png}")).unwrap();
        assert!(std::fs::read(&f).unwrap().starts_with(b"\x89PNG"));
        assert!(write_png(&d, 2, "data:image/png;base64,aGFsbG8=").is_err());
        std::fs::remove_dir_all(&d).ok();
    }

    /// A real export with the bundled FFmpeg (only when STUDIO_FFMPEG points to it): two videos, one without sound, a
    /// picture, a title and a sound file become a film of the right length with picture and sound.
    #[test]
    fn real_export_with_ffmpeg() {
        let Some(ff) = std::env::var("STUDIO_FFMPEG").ok().map(PathBuf::from).filter(|p| p.is_file()) else { return };
        let d = std::env::temp_dir().join(format!("video-export-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let make = |graph: &str, maps: &[&str], out: &str| {
            let mut c = media::command(&ff);
            c.args(["-hide_banner", "-loglevel", "error", "-y", "-filter_complex", graph]);
            for m in maps { c.args(["-map", m]); }
            // The LGPL build has no x264: the system's encoder, as in the export.
            if out.ends_with(".mp4") { c.args(if cfg!(windows) { ["-c:v", "h264_mf", "-c:a", "aac"] } else { ["-c:v", "h264_videotoolbox", "-c:a", "aac"] }); }
            if out.ends_with(".webm") { c.args(["-c:v", "libvpx", "-c:a", "libopus"]); }
            assert!(c.arg(d.join(out)).status().unwrap().success(), "{out}");
        };
        let enc = if cfg!(target_os = "linux") { "webm" } else { "mp4" };
        make("testsrc2=s=640x360:r=30:d=4[v];sine=f=440:d=4[a]", &["[v]", "[a]"], &format!("a.{enc}"));
        make("mandelbrot=s=320x240:r=25,trim=duration=3,format=yuv420p[v]", &["[v]"], &format!("b.{enc}"));
        make("sine=f=880:d=3[a]", &["[a]"], "c.wav");
        make("color=c=red:s=200x100,trim=end_frame=1[v]", &["[v]"], "d.png");
        let f = |n: &str| d.join(n).to_string_lossy().into_owned();
        let png = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(std::fs::read(d.join("d.png")).unwrap()));
        let p = project(json!({"width": 640, "height": 360, "fps": 25, "tracks": [
            {"kind": "video", "clips": [{"kind": "text", "start": 0.5, "dur": 1, "png": png}, {"kind": "image", "path": f("d.png"), "start": 2, "dur": 1, "opacity": 0.5}]},
            {"kind": "video", "clips": [{"kind": "video", "path": f(&format!("a.{enc}")), "start": 0, "in": 1, "dur": 2, "fadeIn": 0.5},
                {"kind": "video", "path": f(&format!("b.{enc}")), "start": 2, "dur": 2.5}]},
            {"kind": "audio", "clips": [{"kind": "audio", "path": f("c.wav"), "start": 1, "dur": 2, "volume": 0.7}]}]}));
        let sound: HashMap<String, bool> = p.tracks.iter().flat_map(|t| t.clips.iter()).filter(|c| c.kind == "video")
            .map(|c| (c.path.clone(), media::probe(&ff, Path::new(&c.path)).unwrap().audio)).collect();
        assert_eq!(sound.values().filter(|v| **v).count(), 1, "only a.* has sound");
        let list = inputs(&p, &|x| sound[x], &mut |c| write_png(&d, 9, c.png.as_deref().unwrap())).unwrap();
        for (fmt, ext) in [(enc, enc), ("wav", "wav")] {
            let out = f(&format!("film.{ext}"));
            let a = args(&p, &list, &Output { format: fmt.into(), quality: "low".into() }, &out).unwrap();
            let r = media::command(&ff).args(&a).output().unwrap();
            assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
            let got = media::probe(&ff, Path::new(&out)).unwrap();
            assert!((got.duration - 4.5).abs() < 0.15, "{fmt}: length {}", got.duration);
            assert!(got.audio, "{fmt}: sound");
            assert_eq!(got.video, if fmt == "wav" { None } else { Some((640, 360)) }, "{fmt}: picture");
        }
        std::fs::remove_dir_all(&d).ok();
    }
}
