/* Video Studio: the plain logic of a project — tracks, clips, placing, trimming, splitting, snapping, undo — without a
   window, so it can be tested on its own (jsc). app.js draws it and preview.js plays it.

   A project: {app, version, name, width, height, fps, media: [{id, path, name, kind, duration, width, height, hasAudio}],
   tracks: [{id, kind: 'video'|'audio', name, hidden, muted, clips: [clip]}]} — the first video track lies on top.
   A clip: {id, kind: 'video'|'image'|'audio'|'text', media (id, not for titles), start, in, dur, volume, opacity,
   fadeIn, fadeOut, muted, and for titles text, size, color, pos ('top'|'center'|'bottom'), box, bold}. Times in seconds. */
(function (root) {
  'use strict';
  const EPS = 1e-6;
  const round = v => Math.round(v * 1000) / 1000;
  let counter = 0;
  const uid = p => p + Date.now().toString(36) + (++counter).toString(36);

  const RESOLUTIONS = [[1920, 1080], [1280, 720], [3840, 2160], [1080, 1920], [1080, 1080]];
  const FPS = [24, 25, 30, 50, 60];
  const IMAGE_DUR = 5, TITLE_DUR = 4, MIN_DUR = 0.1;

  function create(name = '') {
    return {app: 'video-studio', version: 1, name, width: 1920, height: 1080, fps: 30, media: [],
      tracks: [track('video', 'V2'), track('video', 'V1'), track('audio', 'A1'), track('audio', 'A2')]};
  }
  function track(kind, name) { return {id: uid('t'), kind, name, hidden: false, muted: false, clips: []}; }

  /* Reads a project file and fills in what older or hand-written files leave out. */
  function load(text) {
    const p = typeof text === 'string' ? JSON.parse(text) : text;
    if (!p || typeof p !== 'object' || !Array.isArray(p.tracks)) throw new Error('not a Video Studio project');
    const base = create(p.name || '');
    const out = {...base, ...p, media: Array.isArray(p.media) ? p.media : []};
    out.width = Math.max(16, Math.round(+out.width || 1920)); out.height = Math.max(16, Math.round(+out.height || 1080));
    out.fps = +out.fps > 0 ? +out.fps : 30;
    out.tracks = p.tracks.map(t => ({id: t.id || uid('t'), kind: t.kind === 'audio' ? 'audio' : 'video', name: t.name || '', hidden: !!t.hidden, muted: !!t.muted,
      clips: (Array.isArray(t.clips) ? t.clips : []).map(normClip).filter(c => c.dur > 0)}));
    return out;
  }
  function normClip(c) {
    const n = {volume: 1, opacity: 1, fadeIn: 0, fadeOut: 0, muted: false, in: 0, ...c};
    n.id = n.id || uid('c');
    for (const k of ['start', 'in', 'dur', 'volume', 'opacity', 'fadeIn', 'fadeOut']) n[k] = Math.max(0, +n[k] || 0);
    if (c.volume == null) n.volume = 1;
    if (c.opacity == null) n.opacity = 1;
    if (n.kind === 'text') Object.assign(n, {text: '', size: 8, color: '#ffffff', pos: 'bottom', box: false, bold: true, ...c, id: n.id});
    return n;
  }
  const save = p => JSON.stringify(p, null, 1);

  const mediaOf = (p, id) => p.media.find(m => m.id === id) || null;
  const end = c => c.start + c.dur;
  const total = p => p.tracks.reduce((m, t) => Math.max(m, ...t.clips.map(end)), 0);
  const findClip = (p, id) => { for (const t of p.tracks) { const c = t.clips.find(x => x.id === id); if (c) return {track: t, clip: c}; } return null; };
  /* Which clip kinds a track takes. */
  const fits = (t, kind) => t.kind === 'audio' ? kind === 'audio' : kind !== 'audio';
  /* How far a clip can reach into its source: videos and sound only as long as the file, pictures and titles any length. */
  const maxLen = (p, c) => (c.kind === 'video' || c.kind === 'audio') ? ((mediaOf(p, c.media) || {}).duration || Infinity) : Infinity;

  /* Adds a medium (from Rust's import) to the project once; returns its entry. */
  function addMedia(p, info) {
    const old = p.media.find(m => m.path === info.path);
    if (old) { for (const k of ['duration', 'width', 'height']) if (!old[k] && info[k]) old[k] = info[k]; return old; }
    const m = {id: uid('m'), path: info.path, name: info.name, kind: info.kind, duration: info.duration || 0, width: info.width || 0, height: info.height || 0, hasAudio: info.hasAudio !== false};
    p.media.push(m);
    return m;
  }

  /* ---- Free places on a track ---- */
  const overlaps = (t, start, dur, skip) => t.clips.some(c => c.id !== skip && start < end(c) - EPS && start + dur > c.start + EPS);
  /* The free place nearest to `want` for a clip of length `dur` (never before 0). */
  function freeStart(t, want, dur, skip) {
    want = Math.max(0, want);
    if (!overlaps(t, want, dur, skip)) return round(want);
    const cands = [];
    for (const c of t.clips) if (c.id !== skip) cands.push(end(c), c.start - dur);
    let best = null;
    for (const s of cands) {
      if (s < -EPS || overlaps(t, s, dur, skip)) continue;
      if (best === null || Math.abs(s - want) < Math.abs(best - want)) best = Math.max(0, s);
    }
    return round(best ?? total({tracks: [t]}));
  }
  /* The first track of the right kind with room at `start` (from the bottom video track / top audio track), or null. */
  function trackWithRoom(p, kind, start, dur) {
    const list = p.tracks.filter(t => fits(t, kind));
    const order = kind === 'audio' ? list : [...list].reverse();
    return order.find(t => !overlaps(t, start, dur)) || null;
  }

  /* Puts a medium on the timeline. Without a track: the first one with room at `start`, else a new one. */
  function place(p, m, start, trackId, imageDur = IMAGE_DUR) {
    const kind = m.kind;
    const dur = kind === 'image' ? imageDur : (m.duration || IMAGE_DUR);
    let t = trackId ? p.tracks.find(x => x.id === trackId && fits(x, kind)) : null;
    if (!t) t = trackWithRoom(p, kind, start, dur) || addTrack(p, kind === 'audio' ? 'audio' : 'video');
    const c = normClip({kind, media: m.id, start: 0, in: 0, dur: round(dur)});
    c.start = freeStart(t, start, c.dur);
    t.clips.push(c); sortTrack(t);
    return c;
  }
  function addTitle(p, start, text, trackId, dur = TITLE_DUR) {
    let t = trackId ? p.tracks.find(x => x.id === trackId && x.kind === 'video') : null;
    if (!t) t = p.tracks.find(x => x.kind === 'video' && !overlaps(x, start, dur)) || addTrack(p, 'video');
    const c = normClip({kind: 'text', text, start: 0, dur, fadeIn: .3, fadeOut: .3});
    c.start = freeStart(t, start, c.dur);
    t.clips.push(c); sortTrack(t);
    return c;
  }
  const sortTrack = t => t.clips.sort((a, b) => a.start - b.start);
  /* A new track: video tracks go on top, audio tracks at the bottom; named V3, A3 … */
  function addTrack(p, kind) {
    const n = p.tracks.filter(t => t.kind === kind).length + 1, t = track(kind, (kind === 'audio' ? 'A' : 'V') + n);
    if (kind === 'audio') p.tracks.push(t); else p.tracks.unshift(t);
    return t;
  }
  /* Removes an empty track (there is always one of each kind). */
  function removeTrack(p, id) {
    const t = p.tracks.find(x => x.id === id);
    if (!t || t.clips.length || p.tracks.filter(x => x.kind === t.kind).length < 2) return false;
    p.tracks.splice(p.tracks.indexOf(t), 1);
    return true;
  }

  /* ---- Editing ---- */
  /* Moves a clip to `start` on track `trackId` (same kind); it lands on the nearest free place. */
  function move(p, id, start, trackId) {
    const f = findClip(p, id); if (!f) return false;
    const t = (trackId && p.tracks.find(x => x.id === trackId && fits(x, f.clip.kind))) || f.track;
    const s = freeStart(t, start, f.clip.dur, id);
    if (t !== f.track) { f.track.clips.splice(f.track.clips.indexOf(f.clip), 1); t.clips.push(f.clip); }
    f.clip.start = s; sortTrack(t);
    return true;
  }
  /* Trims the left edge to `at` (timeline time): start and in move together; or the right edge: only the length. Never into
     a neighbour, never past the source, never shorter than MIN_DUR. */
  function trim(p, id, edge, at) {
    const f = findClip(p, id); if (!f) return false;
    const c = f.clip, others = f.track.clips.filter(x => x.id !== id);
    if (edge === 'left') {
      const prevEnd = Math.max(0, ...others.filter(x => end(x) <= c.start + EPS).map(end));
      const stretch = (c.kind === 'video' || c.kind === 'audio') ? c.in : Infinity;
      const s = Math.min(Math.max(at, prevEnd, c.start - stretch), end(c) - MIN_DUR);
      const d = s - c.start;
      if (c.kind === 'video' || c.kind === 'audio') c.in = round(Math.max(0, c.in + d));
      c.start = round(s); c.dur = round(c.dur - d);
    } else {
      const nextStart = Math.min(Infinity, ...others.filter(x => x.start >= end(c) - EPS).map(x => x.start));
      const e = Math.max(c.start + MIN_DUR, Math.min(at, nextStart, c.start + maxLen(p, c) - c.in));
      c.dur = round(e - c.start);
    }
    c.fadeIn = Math.min(c.fadeIn, c.dur); c.fadeOut = Math.min(c.fadeOut, c.dur);
    return true;
  }
  /* Cuts a clip in two at timeline time `at`; returns the new right part. */
  function split(p, id, at) {
    const f = findClip(p, id); if (!f) return null;
    const c = f.clip;
    if (at <= c.start + MIN_DUR - EPS || at >= end(c) - MIN_DUR + EPS) return null;
    const left = round(at - c.start);
    const r = {...c, id: uid('c'), start: round(at), dur: round(c.dur - left), fadeIn: 0};
    if (c.kind === 'video' || c.kind === 'audio') r.in = round(c.in + left);
    c.dur = left; c.fadeOut = 0;
    f.track.clips.push(r); sortTrack(f.track);
    return r;
  }
  /* Cuts every clip under the playhead (of the given tracks, or all that aren't locked away). */
  function splitAt(p, at, ids) {
    const out = [];
    for (const t of p.tracks) for (const c of [...t.clips]) {
      if (ids && !ids.includes(c.id)) continue;
      const r = c.start < at && end(c) > at ? split(p, c.id, at) : null;
      if (r) out.push(r);
    }
    return out;
  }
  function remove(p, ids) {
    let n = 0;
    for (const t of p.tracks) { const before = t.clips.length; t.clips = t.clips.filter(c => !ids.includes(c.id)); n += before - t.clips.length; }
    return n;
  }
  /* Removes clips and closes the gaps they leave on their tracks (what comes after moves left). */
  function rippleRemove(p, ids) {
    for (const t of p.tracks) {
      const gone = t.clips.filter(c => ids.includes(c.id)).sort((a, b) => b.start - a.start);
      for (const g of gone) {
        t.clips.splice(t.clips.indexOf(g), 1);
        for (const c of t.clips) if (c.start >= end(g) - EPS) c.start = round(c.start - g.dur);
      }
    }
  }
  /* Closes an empty stretch on one track at time `at` (the gap the mouse is in). */
  function closeGap(p, trackId, at) {
    const t = p.tracks.find(x => x.id === trackId); if (!t) return 0;
    if (t.clips.some(c => c.start <= at && end(c) > at)) return 0;
    const before = Math.max(0, ...t.clips.filter(c => end(c) <= at + EPS).map(end));
    const after = t.clips.filter(c => c.start >= at - EPS);
    if (!after.length) return 0;
    const gap = Math.min(...after.map(c => c.start)) - before;
    for (const c of after) c.start = round(c.start - gap);
    return round(gap);
  }
  /* Copies of clips for the clipboard, with times relative to the first one. */
  function copy(p, ids) {
    const list = [];
    for (const t of p.tracks) for (const c of t.clips) if (ids.includes(c.id)) list.push({track: p.tracks.indexOf(t), clip: {...c}});
    const first = Math.min(...list.map(x => x.clip.start));
    return list.map(x => ({...x, clip: {...x.clip, start: round(x.clip.start - first)}}));
  }
  /* Puts copied clips at `at`, each on its old track if it is still there (else the first that fits). */
  function paste(p, items, at) {
    const out = [];
    for (const it of items) {
      let t = p.tracks[it.track];
      if (!t || !fits(t, it.clip.kind)) t = p.tracks.find(x => fits(x, it.clip.kind));
      const c = normClip({...it.clip, id: uid('c')});
      c.start = freeStart(t, at + it.clip.start, c.dur);
      t.clips.push(c); sortTrack(t); out.push(c);
    }
    return out;
  }

  /* ---- Time ---- */
  /* Every place a cut or the playhead can snap to. */
  function snapPoints(p, skip = [], extra = []) {
    const pts = [0, ...extra];
    for (const t of p.tracks) for (const c of t.clips) if (!skip.includes(c.id)) pts.push(c.start, end(c));
    return pts;
  }
  /* `t` moved to the nearest point within `tol` seconds, or left alone. */
  function snap(t, points, tol) {
    let best = t, d = tol;
    for (const x of points) { const e = Math.abs(x - t); if (e <= d) { d = e; best = x; } }
    return best;
  }
  /* The previous / next cut from `t` (for ↑ ↓). */
  function cut(p, t, dir) {
    const pts = [...new Set(snapPoints(p).concat(total(p)).map(round))].sort((a, b) => a - b);
    return dir > 0 ? pts.find(x => x > t + 1e-3) ?? null : [...pts].reverse().find(x => x < t - 1e-3) ?? null;
  }
  /* Rounds a time to a whole frame. */
  const frame = (p, t) => Math.max(0, Math.round(t * p.fps) / p.fps);
  /* 1:02:03:12 style (hours only when needed), frames after the last colon. */
  function timecode(t, fps = 30) {
    t = Math.max(0, t || 0);
    const f = Math.floor(t * fps + 1e-6), fr = f % Math.round(fps), s = Math.floor(f / Math.round(fps));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    const two = n => String(n).padStart(2, '0');
    return (h ? h + ':' + two(m) : two(m)) + ':' + two(x) + ':' + two(fr);
  }
  /* Clips that are seen or heard at time `t`: [{track, clip}] — video tracks from the bottom up (drawing order). */
  function at(p, t) {
    const out = [];
    const vids = p.tracks.filter(x => x.kind === 'video').reverse(), auds = p.tracks.filter(x => x.kind === 'audio');
    for (const tr of [...vids, ...auds]) for (const c of tr.clips) if (t >= c.start - EPS && t < end(c) - EPS) out.push({track: tr, clip: c});
    return out;
  }
  /* How strong a clip is at time `t` (0..1) because of its fades. */
  function fadeAt(c, t) {
    const a = t - c.start, b = end(c) - t;
    let f = 1;
    if (c.fadeIn > 0) f = Math.min(f, a / c.fadeIn);
    if (c.fadeOut > 0) f = Math.min(f, b / c.fadeOut);
    return Math.max(0, Math.min(1, f));
  }
  /* Where in the source the clip is at timeline time `t`. */
  const sourceTime = (c, t) => c.in + (t - c.start);

  /* The project as Rust's export wants it: paths instead of media ids. `png(clip)` draws a title. */
  function forExport(p, png) {
    return {width: p.width, height: p.height, fps: p.fps, tracks: p.tracks.map(t => ({kind: t.kind, hidden: t.hidden, muted: t.muted,
      clips: t.clips.map(c => ({kind: c.kind, path: c.kind === 'text' ? '' : (mediaOf(p, c.media) || {}).path || '', start: c.start, in: c.in, dur: c.dur,
        volume: c.volume, opacity: c.opacity, fadeIn: c.fadeIn, fadeOut: c.fadeOut, muted: !!c.muted, ...(c.kind === 'text' ? {png: png(c)} : {})}))}))};
  }
  /* Media files the project uses that are missing (paths from Rust's open_project). */
  const offline = (p, missing) => new Set(p.media.filter(m => missing.includes(m.path)).map(m => m.id));
  /* Points every use of a missing medium to a new file. */
  function relink(p, mediaId, info) {
    const m = mediaOf(p, mediaId); if (!m) return false;
    Object.assign(m, {path: info.path, name: info.name, duration: info.duration || m.duration, width: info.width || m.width, height: info.height || m.height});
    return true;
  }
  /* Media no clip uses any more. */
  const unused = p => p.media.filter(m => !p.tracks.some(t => t.clips.some(c => c.media === m.id)));

  /* ---- Undo ---- */
  function history(limit = 100) {
    const back = [], fwd = [];
    return {
      push(state) { back.push(state); if (back.length > limit) back.shift(); fwd.length = 0; },
      undo(now) { if (!back.length) return null; fwd.push(now); return back.pop(); },
      redo(now) { if (!fwd.length) return null; back.push(now); return fwd.pop(); },
      clear() { back.length = 0; fwd.length = 0; },
      get canUndo() { return back.length > 0; }, get canRedo() { return fwd.length > 0; }
    };
  }

  root.TL = {RESOLUTIONS, FPS, IMAGE_DUR, TITLE_DUR, MIN_DUR, create, load, save, normClip, mediaOf, end, total, findClip, fits, maxLen, addMedia,
    overlaps, freeStart, trackWithRoom, place, addTitle, addTrack, removeTrack, move, trim, split, splitAt, remove, rippleRemove, closeGap,
    copy, paste, snapPoints, snap, cut, frame, timecode, at, fadeAt, sourceTime, forExport, offline, relink, unused, history, uid};
})(typeof window !== 'undefined' ? window : globalThis);
