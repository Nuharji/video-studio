# Changelog

## 0.1.0 — 2026-11-14
**First version** — Video Studio, the video editor of the Studio family (Pre-Alpha).
- Projects (`.vstudio`) with frame size and frame rate; the last project comes back at start.
- Import videos, sound and pictures; timeline with several video and audio tracks: move, trim, split (also with the razor),
  delete and close the gap, copy / paste, snapping, zoom, hide / mute tracks, undo / redo.
- Titles; opacity, volume and fades per clip; preview with frame by frame and jumping between cuts.
- Export as MP4 (macOS, Windows) or WebM (Linux), or sound only (M4A / WAV), with the bundled LGPL FFmpeg.
- MCP server (`--mcp`): list_folder, media_info, read_project.
- All Studio themes and layouts, German / English, customizable shortcuts.
