# Video Studio (Rust / Tauri)

> **Status: Pre-Alpha** — early version (0.x): it works, but things may still change or break. Version 1.0 will be the first stable one.

Cut videos — the video editor of the Studio family. Works offline, no account.
The native shell is Rust ([Tauri 2](https://tauri.app)); the UI is plain HTML/JS in `ui/`, with the same chrome
and controls as the other Studio apps.

## Features
- **Projects** (`.vstudio`, plain JSON): new, open, save, recent list, the last project (also unsaved) comes back at start;
  frame size (Full HD, HD, 4K, upright for phones, square) and frame rate (24–60)
- **Media** — import videos, sound and pictures (dialog, drag & drop, "Open with"); missing files are marked and can be found again
- **Timeline** with several video and audio tracks (the top video track lies on top): place, move, trim at the edges,
  split at the playhead or with the razor tool, delete and close the gap, copy / paste / duplicate, snapping to cuts
  (Alt switches it off), zoom at the mouse, hide or mute tracks, undo / redo
- **Titles** — text with size, color, position, bold and a dark box behind it
- **Picture and sound per clip** — opacity, volume, mute, fade in / fade out
- **Preview** with frame by frame, ±1 s, jump to the previous / next cut, full screen
- **Export** — MP4 (H.264 + AAC) on macOS and Windows, WebM (VP8 + Opus) on Linux, or sound only (M4A / WAV); three qualities,
  progress and cancel
- Media, project and properties in the side panel; all Studio themes and layouts, settings dialog, customizable shortcuts,
  auto-hide bars, German / English; theme, layout and language shared with the other Studio apps

The app can only read the folders of media you import or that an opened project uses (the asset protocol starts with an
empty scope).

## FFmpeg
Exporting goes through a small LGPL-only FFmpeg that ships next to the program (`video-ffmpeg`) — the same build as
Viewer Studio's (`ffmpeg-<version>-<n>` releases of [viewer-studio](https://github.com/Nuharji/viewer-studio), built unchanged
from the official sources without GPL or non-free parts, not linked into the app). It uses the operating system's encoders
(VideoToolbox on macOS, Media Foundation on Windows). For a local build put a binary named `video-ffmpeg-<target triple>`
into `src-tauri/binaries/`, or let `STUDIO_FFMPEG` point to one; without it you can still cut, but not export.

## MCP
Video Studio is also an MCP server, so Claude (Desktop or Code), ChatGPT and other MCP clients can use what it can do:
started with `--mcp`, the program opens no window and speaks MCP on stdin / stdout until the client closes it.

- `list_folder` — The videos, sound files and pictures in a folder that Video Studio can use, with kind and size.
- `media_info` — Length, picture size and whether there is sound.
- `read_project` — What is in a project (.vstudio): frame size, length, tracks with their clips and missing files.

It only reads. Claude Code: `claude mcp add video-studio -- "/Applications/Video Studio.app/Contents/MacOS/video-studio" --mcp`.

## Layout
```
ui/                 index.html, app.js — the editor; timeline.js — the plain project logic (tracks, clips, undo);
                    preview.js — playing the timeline; native.js, autohide.js, shortcuts.js, shared.js, layouts.css (the same in every Studio app)
src-tauri/src/      main.rs — importing, dialogs, projects; media.rs — media kinds, FFmpeg description; export.rs — the export;
                    mcp.rs, mcp_tools.rs — MCP server; shared.rs — theme / layout / language shared by the Studio apps
src-tauri/i18n/     en.json, de.json — all texts
```

## Build
Install Rust and Node, then `npx @tauri-apps/cli@2 icon app-icon.png` once and `npx @tauri-apps/cli@2 dev`.
Release builds for Windows / macOS / Linux come from GitHub Actions when you push a tag like `v0.1.0`.

## Licenses
Exporting uses [FFmpeg](https://ffmpeg.org) (LGPL 2.1, built without GPL parts; licence text and source link ship with the app).
