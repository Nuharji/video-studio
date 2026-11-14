//! What Video Studio offers over MCP (mcp.rs): looking at media files and projects. It only reads; cutting and exporting
//! stay with the window (titles are drawn there).

use crate::{mcp, media};
use serde_json::{json, Value};
use std::path::Path;

pub fn run() { mcp::serve("video-studio", env!("CARGO_PKG_VERSION"), &tools(), &call) }

fn tools() -> Vec<Value> {
    let path = json!({"type": "string", "description": "Full path of the file"});
    vec![
        mcp::tool("list_folder", "The videos, sound files and pictures in a folder that Video Studio can use, with kind and size.", json!({"folder": {"type": "string", "description": "Full path of the folder"}}), &["folder"]),
        mcp::tool("media_info", "Length, picture size and whether there is sound, for a video, sound file or picture.", json!({"path": path}), &["path"]),
        mcp::tool("read_project", "What is in a Video Studio project (.vstudio): frame size, length, tracks with their clips (place, length, file or title text) and missing files.", json!({"path": path}), &["path"]),
    ]
}

/// A short description of a project: tracks with their clips, the length and the files that are missing.
pub fn summary(text: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("not a Video Studio project: {e}"))?;
    let media: Vec<&Value> = v.get("media").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
    let path_of = |id: &str| media.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(id)).and_then(|m| m.get("path")).and_then(Value::as_str).unwrap_or("");
    let num = |c: &Value, k: &str| c.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let mut length: f64 = 0.0;
    let tracks: Vec<Value> = v.get("tracks").and_then(Value::as_array).into_iter().flatten().map(|t| {
        let clips: Vec<Value> = t.get("clips").and_then(Value::as_array).into_iter().flatten().map(|c| {
            let (start, dur) = (num(c, "start"), num(c, "dur"));
            length = length.max(start + dur);
            let kind = c.get("kind").and_then(Value::as_str).unwrap_or("");
            let what = if kind == "text" { json!({"text": c.get("text").cloned().unwrap_or(Value::Null)}) }
                else { json!({"file": path_of(c.get("media").and_then(Value::as_str).unwrap_or(""))}) };
            let mut o = json!({"kind": kind, "start": start, "duration": dur, "in": num(c, "in")});
            if let (Some(o), Some(w)) = (o.as_object_mut(), what.as_object()) { o.extend(w.clone()); }
            o
        }).collect();
        json!({"name": t.get("name").cloned().unwrap_or(Value::Null), "kind": t.get("kind").cloned().unwrap_or(Value::Null), "clips": clips})
    }).collect();
    let missing: Vec<&str> = media.iter().filter_map(|m| m.get("path").and_then(Value::as_str)).filter(|p| !Path::new(p).is_file()).collect();
    Ok(json!({"name": v.get("name").cloned().unwrap_or(Value::Null), "width": v.get("width").cloned().unwrap_or(Value::Null),
        "height": v.get("height").cloned().unwrap_or(Value::Null), "fps": v.get("fps").cloned().unwrap_or(Value::Null),
        "length": (length * 1000.0).round() / 1000.0, "tracks": tracks, "missing": missing}))
}

/// The file has to exist: the reading functions return an empty result for a missing file.
fn file(args: &Value) -> Result<std::path::PathBuf, String> {
    let p = mcp::path(args, "path")?;
    if p.is_file() { Ok(p) } else { Err(format!("{}: not found", p.display())) }
}

fn call(name: &str, args: &Value) -> Result<Value, String> {
    let to_json = |v: Result<Value, serde_json::Error>| v.map_err(|e| e.to_string());
    match name {
        "list_folder" => {
            let d = mcp::path(args, "folder")?;
            if !d.is_dir() { return Err(format!("{}: not a folder", d.display())); }
            to_json(serde_json::to_value(media::folder(&d)))
        }
        "media_info" => {
            let p = file(args)?;
            let i = media::info(&p).ok_or_else(|| format!("{}: not a video, sound file or picture Video Studio takes", p.display()))?;
            to_json(serde_json::to_value(i))
        }
        "read_project" => {
            let p = file(args)?;
            if !mcp::has_ext(&p, &[media::PROJECT]) { return Err(format!("{}: not a .vstudio project", p.display())); }
            summary(&std::fs::read_to_string(&p).map_err(|e| e.to_string())?)
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn folders_files_and_projects() {
        let d = std::env::temp_dir().join(format!("video-mcp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("film.mp4"), b"x").unwrap();
        fs::write(d.join("notizen.txt"), b"x").unwrap();
        let film = d.join("film.mp4").to_string_lossy().into_owned();
        let project = json!({"app": "video-studio", "name": "Urlaub", "width": 1920, "height": 1080, "fps": 30,
            "media": [{"id": "m1", "path": film}, {"id": "m2", "path": d.join("weg.wav")}],
            "tracks": [{"name": "V1", "kind": "video", "clips": [{"kind": "video", "media": "m1", "start": 0, "in": 2, "dur": 4.5},
                {"kind": "text", "text": "Ende", "start": 4.5, "dur": 2}]}, {"name": "A1", "kind": "audio", "clips": []}]});
        fs::write(d.join("urlaub.vstudio"), project.to_string()).unwrap();
        let list = call("list_folder", &json!({"folder": d})).unwrap();
        assert!(list.as_array().unwrap().iter().any(|e| e["kind"] == "video"));
        assert!(!list.to_string().contains("notizen.txt"), "only what the app takes");
        let s = call("read_project", &json!({"path": d.join("urlaub.vstudio")})).unwrap();
        assert_eq!(s["length"], 6.5);
        assert_eq!(s["tracks"][0]["clips"][0]["file"], film.as_str());
        assert_eq!(s["tracks"][0]["clips"][1]["text"], "Ende");
        assert!(s["missing"].to_string().contains("weg.wav"));
        assert!(call("read_project", &json!({"path": d.join("film.mp4")})).is_err());
        assert!(call("media_info", &json!({"path": d.join("notizen.txt")})).is_err());
        assert!(call("list_folder", &json!({"folder": "relativ"})).is_err());
        let _ = fs::remove_dir_all(d);
    }
}
