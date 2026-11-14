//! Media files: which ones Video Studio takes (videos, sound, pictures), what is in them (length, size, sound) and where
//! the bundled FFmpeg is. FFmpeg (`video-ffmpeg`, the same small LGPL-only build as Viewer Studio's) describes a file with
//! `ffmpeg -i`; without it the window reads length and size from the media elements itself.

use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub const VIDEO: [&str; 6] = ["mp4", "m4v", "mov", "webm", "ogv", "mkv"];
pub const AUDIO: [&str; 8] = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aiff"];
pub const IMAGE: [&str; 7] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];
pub const PROJECT: &str = "vstudio";

pub fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// "video", "audio", "image" — or None for files Video Studio doesn't take.
pub fn kind_of(p: &Path) -> Option<&'static str> {
    let e = ext_of(p);
    if VIDEO.contains(&e.as_str()) { Some("video") }
    else if AUDIO.contains(&e.as_str()) { Some("audio") }
    else if IMAGE.contains(&e.as_str()) { Some("image") }
    else { None }
}

/// One imported file. `duration`, `width`, `height` are 0 when unknown (no FFmpeg — the window fills them in).
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Info {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    /// Whether a video brings sound along (true when unknown).
    #[serde(rename = "hasAudio")]
    pub has_audio: bool,
}

pub fn info(path: &Path) -> Option<Info> {
    let kind = kind_of(path)?;
    let meta = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
    let mut i = Info {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        kind: kind.into(),
        size: meta.len(),
        has_audio: kind != "image",
        ..Default::default()
    };
    if kind != "image" {
        if let Some(p) = ffmpeg_path().and_then(|f| probe(&f, path).ok()) {
            i.duration = p.duration;
            if let Some((w, h)) = p.video { i.width = w; i.height = h; }
            i.has_audio = p.audio;
        }
    }
    Some(i)
}

/// The media files of a folder (not its subfolders), sorted by name.
pub fn folder(dir: &Path) -> Vec<Info> {
    let mut list: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path())
        .filter(|p| p.is_file() && kind_of(p).is_some()).collect();
    list.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
    list.iter().filter_map(|p| {
        let kind = kind_of(p)?;
        Some(Info { path: p.to_string_lossy().into_owned(), name: p.file_name()?.to_string_lossy().into_owned(), kind: kind.into(),
            size: std::fs::metadata(p).map(|m| m.len()).unwrap_or(0), has_audio: kind != "image", ..Default::default() })
    }).collect()
}

/// What `ffmpeg -i` says about a file.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Probe {
    pub duration: f64,
    /// Width and height of the first real video stream (cover pictures don't count).
    pub video: Option<(u32, u32)>,
    pub audio: bool,
}

/// Reads the input description FFmpeg prints (stderr of `ffmpeg -i file`).
pub fn parse_probe(text: &str) -> Probe {
    let mut p = Probe::default();
    for line in text.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("Duration: ") {
            let t = rest.split(',').next().unwrap_or("");
            let parts: Vec<f64> = t.split(':').filter_map(|x| x.trim().parse().ok()).collect();
            if parts.len() == 3 { p.duration = parts[0] * 3600.0 + parts[1] * 60.0 + parts[2]; }
        }
        if !line.starts_with("Stream #") { continue; }
        if line.contains(": Audio: ") { p.audio = true; }
        if p.video.is_none() && line.contains(": Video: ") && !line.contains("(attached pic)") {
            p.video = line.split([' ', ',']).find_map(|w| {
                let (a, b) = w.split_once('x')?;
                Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?))
            });
        }
    }
    p
}

/// The bundled FFmpeg: next to the program (`video-ffmpeg`), or for development the one `STUDIO_FFMPEG` points to or a
/// copy in `src-tauri/binaries`.
pub fn ffmpeg_path() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "video-ffmpeg.exe" } else { "video-ffmpeg" };
    if let Ok(p) = std::env::var("STUDIO_FFMPEG") { let p = PathBuf::from(p); if p.is_file() { return Some(p); } }
    if let Some(p) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(exe))).filter(|p| p.is_file()) { return Some(p); }
    #[cfg(debug_assertions)]
    {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        if let Some(p) = std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path())
            .find(|p| p.file_name().is_some_and(|n| { let n = n.to_string_lossy(); n.starts_with("video-ffmpeg") || n.starts_with("viewer-ffmpeg") })) { return Some(p); }
    }
    None
}

pub fn command(ffmpeg: &Path) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut c = Command::new(ffmpeg);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }   // CREATE_NO_WINDOW
    c
}

pub fn probe(ffmpeg: &Path, path: &Path) -> Result<Probe, String> {
    let out = command(ffmpeg).arg("-hide_banner").arg("-nostdin").arg("-i").arg(path).output().map_err(|e| e.to_string())?;
    // "At least one output file must be specified" is the normal end of `ffmpeg -i`; what matters is the description.
    let text = String::from_utf8_lossy(&out.stderr);
    if !text.contains("Input #") { return Err(text.lines().last().unwrap_or("").to_string()); }
    Ok(parse_probe(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(kind_of(Path::new("/a/Film.MP4")), Some("video"));
        assert_eq!(kind_of(Path::new("song.flac")), Some("audio"));
        assert_eq!(kind_of(Path::new("x.jpeg")), Some("image"));
        assert_eq!(kind_of(Path::new("notes.txt")), None);
        assert_eq!(kind_of(Path::new("projekt.vstudio")), None);
    }

    #[test]
    fn reads_ffmpeg_description() {
        let text = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 3126 kb/s\n  \
            Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1280x720, 3047 kb/s, SAR 1:1 DAR 16:9, 30 fps\n  \
            Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)\n";
        assert_eq!(parse_probe(text), Probe { duration: 62.5, video: Some((1280, 720)), audio: true });
        let silent = "  Duration: 00:00:04.00, start: 0.000000\n  Stream #0:0: Video: h264, yuv420p, 640x480, 25 fps\n";
        assert_eq!(parse_probe(silent), Probe { duration: 4.0, video: Some((640, 480)), audio: false });
        let song = "  Duration: 00:03:00.00\n  Stream #0:0: Audio: mp3, 44100 Hz\n  Stream #0:1: Video: mjpeg, yuvj420p, 600x600 (attached pic)\n";
        assert_eq!(parse_probe(song), Probe { duration: 180.0, video: None, audio: true });
    }

    #[test]
    fn folder_lists_only_media() {
        let d = std::env::temp_dir().join(format!("video-media-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        for n in ["b.mp4", "A.wav", "c.png", "readme.txt"] { std::fs::write(d.join(n), b"x").unwrap(); }
        let names: Vec<String> = folder(&d).into_iter().map(|i| i.name).collect();
        assert_eq!(names, ["A.wav", "b.mp4", "c.png"]);
        std::fs::remove_dir_all(&d).ok();
    }
}
