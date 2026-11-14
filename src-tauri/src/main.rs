// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appicon;
mod export;
mod mcp;
mod mcp_tools;
mod media;
mod shared;

use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

/// Paths requested before the UI was ready (command-line args, macOS "Open with").
struct Pending {
    ready: bool,
    paths: Vec<PathBuf>,
}

/// Lets the WebView load the files of one folder (not its subfolders) through the asset protocol — only folders of
/// media that were imported or that an opened project uses.
fn allow(app: &AppHandle, file: &Path) {
    if let Some(dir) = file.parent() { let _ = app.asset_protocol_scope().allow_directory(dir, false); }
}

/// The app's texts in English and German (i18n/*.json, built into the program).
#[tauri::command]
fn texts() -> serde_json::Value {
    let parse = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap_or_default();
    serde_json::json!({"en": parse(include_str!("../i18n/en.json")), "de": parse(include_str!("../i18n/de.json"))})
}

fn infos(app: &AppHandle, paths: &[PathBuf]) -> Vec<media::Info> {
    paths.iter().filter_map(|p| { let i = media::info(p)?; allow(app, p); Some(i) }).collect()
}

/// The import dialog: videos, sound and pictures (several at once).
#[tauri::command]
async fn pick_media(app: AppHandle, label: String, multiple: Option<bool>) -> Vec<media::Info> {
    let all: Vec<&str> = [&media::VIDEO[..], &media::AUDIO[..], &media::IMAGE[..]].concat();
    let d = shared::file_dialog(&app).add_filter(&label, &all);
    let files: Vec<PathBuf> = if multiple.unwrap_or(true) {
        d.blocking_pick_files().unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect()
    } else {
        d.blocking_pick_file().and_then(|f| f.into_path().ok()).into_iter().collect()
    };
    infos(&app, &files)
}

/// What was dropped on the window or given at start: media to import and projects to open.
#[derive(Serialize, Default, Clone)]
struct Dropped {
    media: Vec<media::Info>,
    projects: Vec<String>,
}

fn sort_paths(app: &AppHandle, paths: Vec<PathBuf>) -> Dropped {
    let mut d = Dropped::default();
    for p in paths {
        if p.is_dir() {
            let list = media::folder(&p);
            for i in &list { allow(app, Path::new(&i.path)); }
            d.media.extend(list.iter().filter_map(|i| media::info(Path::new(&i.path))));
        } else if media::ext_of(&p) == media::PROJECT {
            d.projects.push(p.to_string_lossy().into_owned());
        } else {
            d.media.extend(infos(app, &[p]));
        }
    }
    d
}

#[tauri::command]
fn open_paths(app: AppHandle, paths: Vec<String>) -> Dropped {
    sort_paths(&app, paths.into_iter().map(PathBuf::from).collect())
}

/// An opened project: its file, its text and the media it uses that aren't there any more.
#[derive(Serialize)]
struct Loaded {
    path: String,
    text: String,
    missing: Vec<String>,
}

/// The media paths a project file names (`media[].path`).
fn project_media(text: &str) -> Vec<PathBuf> {
    let v: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
    v.get("media").and_then(|m| m.as_array()).into_iter().flatten()
        .filter_map(|m| m.get("path").and_then(|p| p.as_str())).map(PathBuf::from).collect()
}

#[tauri::command]
fn open_project(app: AppHandle, path: String) -> Result<Loaded, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
    if serde_json::from_str::<serde_json::Value>(&text).is_err() { return Err(format!("{path}: not a Video Studio project")); }
    let mut missing = Vec::new();
    for m in project_media(&text) {
        if m.is_file() { allow(&app, &m); } else { missing.push(m.to_string_lossy().into_owned()); }
    }
    Ok(Loaded { path, text, missing })
}

#[tauri::command]
async fn pick_project(app: AppHandle, label: String) -> Result<Option<Loaded>, String> {
    let Some(f) = shared::file_dialog(&app).add_filter(&label, &[media::PROJECT]).blocking_pick_file() else { return Ok(None) };
    let p = f.into_path().map_err(|e| e.to_string())?;
    open_project(app, p.to_string_lossy().into_owned()).map(Some)
}

/// Saves the project; without a path (new project, "Save as") after a save dialog. Returns the file, None if cancelled.
#[tauri::command]
async fn save_project(app: AppHandle, path: Option<String>, name: String, label: String, content: String) -> Result<Option<String>, String> {
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => {
            let Some(f) = shared::file_dialog(&app).set_file_name(format!("{name}.{}", media::PROJECT)).add_filter(&label, &[media::PROJECT]).blocking_save_file() else { return Ok(None) };
            f.into_path().map_err(|e| e.to_string())?
        }
    };
    // Written next to it first, then moved over: a crash while saving never leaves half a project.
    let tmp = target.with_extension("vstudio.part");
    std::fs::write(&tmp, content).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("{}: {e}", target.display()))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

/// The save dialog for an export.
#[tauri::command]
async fn export_pick(app: AppHandle, name: String, ext: String, label: String) -> Option<String> {
    let f = shared::file_dialog(&app).set_file_name(format!("{name}.{ext}")).add_filter(&label, &[ext.as_str()]).blocking_save_file()?;
    f.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

/// Shows the file in Explorer / Finder.
#[tauri::command]
fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn confirm(app: AppHandle, title: String, message: String, ok_label: String, cancel_label: String) -> bool {
    app.dialog().message(message).title(title).kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok_label, cancel_label)).blocking_show()
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !["https://", "http://", "mailto:"].iter().any(|p| url.starts_with(p)) { return Err(format!("Refusing to open {url}")); }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn initial_files(app: AppHandle, state: State<Mutex<Pending>>) -> Dropped {
    let mut pending = state.lock().unwrap();
    pending.ready = true;
    let paths = std::mem::take(&mut pending.paths);
    sort_paths(&app, paths)
}

#[tauri::command]
fn set_fullscreen(window: WebviewWindow, on: bool) -> Result<(), String> {
    window.set_fullscreen(on).map_err(|e| e.to_string())
}

/// One entry of a native context menu; an entry without `id` is a separator.
#[derive(Deserialize)]
struct MenuEntry {
    id: Option<String>,
    label: Option<String>,
    enabled: Option<bool>,
    checked: Option<bool>,
    accel: Option<String>,
}

/// Shows a native (OS) context menu at the mouse position; the chosen id reaches the UI as a "context-menu" event.
#[tauri::command]
fn context_menu(app: AppHandle, window: tauri::Window, items: Vec<MenuEntry>) -> Result<(), String> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
    let mut menu = MenuBuilder::new(&app);
    for entry in items {
        let Some(id) = entry.id else { menu = menu.separator(); continue };
        let label = entry.label.unwrap_or_default();
        let enabled = entry.enabled.unwrap_or(true);
        if let Some(checked) = entry.checked {
            let item = CheckMenuItemBuilder::with_id(id, label).enabled(enabled).checked(checked).build(&app).map_err(|e| e.to_string())?;
            menu = menu.item(&item);
            continue;
        }
        let plain = || MenuItemBuilder::with_id(id.clone(), label.clone()).enabled(enabled);
        let item = match entry.accel.as_deref() {
            Some(a) => plain().accelerator(a).build(&app).or_else(|_| plain().build(&app)),
            None => plain().build(&app),
        }
        .map_err(|e| e.to_string())?;
        menu = menu.item(&item);
    }
    let menu = menu.build().map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_read(app: AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
}

#[tauri::command]
fn clipboard_write(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

fn main() {
    if mcp::wanted() { return mcp_tools::run(); }
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).filter(|p| p.exists()).collect();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_menu_event(|app, event| {
            let _ = app.emit("context-menu", event.id().as_ref());
        })
        .manage(Mutex::new(Pending { ready: false, paths: args }))
        .manage(export::Jobs::default())
        .invoke_handler(tauri::generate_handler![
            appicon::set_dock_icon,
            shared::shared_get,
            shared::shared_set,
            texts,
            pick_media,
            open_paths,
            open_project,
            pick_project,
            save_project,
            export_pick,
            export::export_formats,
            export::export_run,
            export::export_cancel,
            reveal,
            confirm,
            open_url,
            initial_files,
            set_fullscreen,
            context_menu,
            clipboard_read,
            clipboard_write
        ])
        .build(tauri::generate_context!())
        .expect("error while building Video Studio");

    app.run(|_app, _event| {
        // macOS delivers "Open with" / double-clicked files as an event instead of argv.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            let paths: Vec<PathBuf> = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
            let state = _app.state::<Mutex<Pending>>();
            let mut pending = state.lock().unwrap();
            if pending.ready {
                let _ = _app.emit("open-files", sort_paths(_app, paths));
            } else {
                pending.paths.extend(paths);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texts_parse_and_match() {
        let t = texts();
        let (en, de) = (t["en"].as_object().unwrap(), t["de"].as_object().unwrap());
        assert!(en.len() > 60);
        assert!(en.keys().all(|k| de.contains_key(k)), "every English text has a German one: {:?}", en.keys().find(|k| !de.contains_key(*k)));
        assert!(de.keys().all(|k| en.contains_key(k)), "every German text has an English one: {:?}", de.keys().find(|k| !en.contains_key(*k)));
    }

    #[test]
    fn media_of_a_project() {
        let text = r#"{"app":"video-studio","media":[{"id":"m1","path":"/a/b.mp4"},{"id":"m2"},{"id":"m3","path":"C:\\x\\y.wav"}]}"#;
        assert_eq!(project_media(text), [PathBuf::from("/a/b.mp4"), PathBuf::from("C:\\x\\y.wav")]);
        assert!(project_media("kein json").is_empty());
    }
}
