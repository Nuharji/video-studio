/* Video Studio — cut videos (Studio family). Same chrome as the other apps: menus from MENUS with customizable shortcuts,
   option bar, tool rail, side panel, status bar, settings, shared theme, layout and language. The project logic is in
   timeline.js (TL), the playing in preview.js; Rust (main.rs, media.rs, export.rs) imports files, opens and saves
   projects and exports with the bundled FFmpeg. */
'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const STORE = 'video-studio.v1', SESSION = 'video-studio.session';
const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
const fileUrl = p => window.__TAURI__ ? window.__TAURI__.core.convertFileSrc(p) : p;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const baseName = p => String(p).split(/[\\/]/).pop();

/* ================= Texts ================= */
let I18N = {en: {}, de: {}}, lang = 'en';
function t(key, vars) {
  let s = (I18N[lang] && I18N[lang][key]) ?? I18N.en[key] ?? key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
window.VS_TEXT = k => t(k);
const ARROWS = {ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓'};
const fmtKey = k => {
  let s = String(k).replace(/Arrow(Left|Right|Up|Down)/g, m => ARROWS[m]);
  return lang === 'de' ? s.replace(/Ctrl/g, 'Strg').replace(/Shift/g, 'Umschalt').replace(/Space/g, 'Leertaste').replace(/Delete/g, 'Entf').replace(/Home/g, 'Pos1').replace(/End\b/g, 'Ende') : s;
};
async function loadTexts() {
  if (invoke) { I18N = await invoke('texts'); return; }
  const get = l => fetch(`../src-tauri/i18n/${l}.json`).then(r => r.json()).catch(() => ({}));
  I18N = {en: await get('en'), de: await get('de')};
}
const loc = () => lang === 'de' ? 'de-DE' : 'en-GB';
const num = (v, d = 1) => Number(v).toLocaleString(loc(), {maximumFractionDigits: d});
const fmtSize = b => b < 1048576 ? `${num(b / 1024)} KB` : b < 1073741824 ? `${num(b / 1048576)} MB` : `${num(b / 1073741824, 2)} GB`;
const fmtDur = s => {
  if (!s) return '–';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};

/* ================= Settings and state ================= */
const THEMES = ['dark', 'light', 'github', 'github-dark', 'cli', 'cli-amber', 'cli-cyan', 'cli-magenta', 'cli-white', 'midnight', 'dusk', 'graphite', 'contrast', 'sand', 'rose', 'proton'];
const DEF = {keys: {}, autoHide: false, lang: 'auto', theme: 'dark', dock: true, dockTab: 'media', snap: true, tlHeight: 300, pps: 40,
  volume: 1, quality: 'medium', format: '', imageSec: 5, titleSec: 4, restore: true};
let settings = {...DEF}, recent = [], booted = false;
const effectiveLang = () => settings.lang === 'auto' ? ((navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en') : settings.lang;
function saveState() { try { localStorage.setItem(STORE, JSON.stringify({settings, recent})); } catch (e) {} }

let project = TL.create(), filePath = null, dirty = false, offline = new Set();
let sel = new Set(), tool = 'select', clip = [], selMedia = null;
const hist = TL.history(150);
const HEAD = 132;   // width of the track heads in px

function addRecent(path) {
  recent = [{path, name: baseName(path).replace(/\.vstudio$/i, '')}, ...recent.filter(r => r.path !== path)].slice(0, 10);
  saveState();
}
const clipCount = () => project.tracks.reduce((n, tr) => n + tr.clips.length, 0);
const pristine = () => !filePath && !project.media.length && !clipCount();
const projName = () => project.name || (filePath ? baseName(filePath).replace(/\.vstudio$/i, '') : t('ui.untitled'));

/* The session (project, file, unsaved) is kept so a crash or a closed window loses nothing. */
let sessionT = 0;
function saveSession() {
  clearTimeout(sessionT);
  sessionT = setTimeout(() => { try { localStorage.setItem(SESSION, JSON.stringify({text: TL.save(project), path: filePath, dirty})); } catch (e) {} }, 400);
}

/* ================= Editing ================= */
/* Every change goes through edit(fn): the state before is kept for undo; fn returns false when nothing changed. */
function edit(fn) {
  const before = TL.save(project);
  const r = fn();
  if (r === false || r === null || r === 0) return r;
  if (TL.save(project) === before) return r;
  hist.push(before);
  setDirty(true);
  refresh();
  return r;
}
function setDirty(v) { dirty = v; updateTitle(); updateStatus(); saveSession(); }
function refresh() {
  const ids = new Set(project.tracks.flatMap(tr => tr.clips.map(c => c.id)));
  sel = new Set([...sel].filter(id => ids.has(id)));
  showEditor();
  renderTimeline(); preview.setProject(project, offline);
  renderDock(); updateStatus(); updateTimecode(); syncDisabled(); saveSession();
}
function undo() { const s = hist.undo(TL.save(project)); if (s == null) return; project = TL.load(s); setDirty(true); refresh(); }
function redo() { const s = hist.redo(TL.save(project)); if (s == null) return; project = TL.load(s); setDirty(true); refresh(); }
const selected = () => [...sel].map(id => TL.findClip(project, id)).filter(Boolean);
const single = () => { const s = selected(); return s.length === 1 ? s[0] : null; };

/* ================= Project files ================= */
async function ask(msg, ok) {
  if (!invoke) return confirm(msg);
  return invoke('confirm', {title: 'Video Studio', message: msg, okLabel: ok, cancelLabel: t('ui.cancel')});
}
const mayDiscard = async () => !dirty || pristine() || await ask(t('confirm.discard'), t('confirm.discardOk'));
async function newProject() {
  if (!await mayDiscard()) return;
  preview.pause();
  project = TL.create(); filePath = null; offline = new Set(); sel.clear(); hist.clear(); selMedia = null;
  preview.seek(0); setDirty(false); refresh();
}
async function openProject(path) {
  if (!invoke || !await mayDiscard()) return;
  try {
    const r = path ? await invoke('open_project', {path}) : await invoke('pick_project', {label: t('ui.projectFiles')});
    if (r) loadProject(r);
  } catch (e) { toast(t('toast.openFail', {e})); }
}
function loadProject(r) {
  let p;
  try { p = TL.load(r.text); } catch (e) { return toast(t('toast.notProject', {name: baseName(r.path)})); }
  preview.pause();
  project = p; filePath = r.path; offline = TL.offline(project, r.missing || []); sel.clear(); hist.clear(); selMedia = null;
  addRecent(r.path); preview.seek(0); setDirty(false); refresh();
  if (offline.size) toast(t('toast.missing', {n: offline.size}));
}
async function saveProject(as = false) {
  if (!invoke) return false;
  try {
    const r = await invoke('save_project', {path: as ? null : filePath, name: projName(), label: t('ui.projectFiles'), content: TL.save(project)});
    if (!r) return false;
    filePath = r; addRecent(r); setDirty(false); renderEmpty(); toast(t('toast.saved', {name: baseName(r)}));
    return true;
  } catch (e) { toast(t('toast.saveFail', {e})); return false; }
}

/* ================= Importing ================= */
/* Length and size from the media element, when FFmpeg couldn't tell (development without it). */
function fillMeta(m) {
  if (m.kind === 'image' || m.duration) return Promise.resolve();
  return new Promise(res => {
    const el = document.createElement(m.kind === 'audio' ? 'audio' : 'video');
    const done = () => { clearTimeout(tm); el.removeAttribute('src'); el.load(); res(); };
    const tm = setTimeout(done, 5000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => { if (Number.isFinite(el.duration)) m.duration = Math.round(el.duration * 1000) / 1000; if (el.videoWidth) { m.width = el.videoWidth; m.height = el.videoHeight; } done(); };
    el.onerror = done;
    el.src = fileUrl(m.path);
  });
}
/* Adds files to the project (media panel); `place` also puts them one after the other at the playhead. */
async function addMediaInfos(list, place = false) {
  if (!list.length) return [];
  const added = [];
  for (const info of list) {
    const m = TL.addMedia(project, info);
    offline.delete(m.id);
    await fillMeta(m);
    added.push(m);
  }
  edit(() => {
    let at = preview.time;
    if (place) for (const m of added) { const c = TL.place(project, m, at, null, settings.imageSec); at = TL.end(c); }
    return true;
  });
  // The panel shows the new files even when nothing else changed (they were in the project already).
  renderDock();
  toast(t('toast.imported', {n: added.length}));
  return added;
}
async function importMedia() {
  if (!invoke) return;
  const list = await invoke('pick_media', {label: t('ui.mediaFiles')}).catch(e => { toast(t('toast.fail', {e})); return []; });
  if (list.length) { settings.dockTab = 'media'; settings.dock = true; applySettings(); }
  addMediaInfos(list);
}
async function dropped(d, place) {
  if (d.projects && d.projects.length) return openProject(d.projects[0]);
  if (!d.media || !d.media.length) return toast(t('toast.nothing'));
  addMediaInfos(d.media, place);
}
async function relink(mediaId) {
  if (!invoke) return;
  const list = await invoke('pick_media', {label: t('ui.mediaFiles'), multiple: false}).catch(() => []);
  if (!list.length) return;
  edit(() => TL.relink(project, mediaId, list[0]));
  offline.delete(mediaId); refresh();
}

/* ================= Preview and transport ================= */
const preview = Preview.create({canvas: $('#canvas'), host: $('#els'), url: fileUrl,
  onTime: tm => { updatePlayhead(); updateTimecode(); if (preview.playing) follow(tm); },
  onEnd: () => buildTransport()});
function seek(tm) { preview.seek(TL.frame(project, clamp(tm, 0, Math.max(TL.total(project), 0)))); }
function step(dir, sec) { if (preview.playing) preview.pause(); seek(preview.time + dir * (sec || 1 / project.fps)); buildTransport(); }
function playPause() { preview.toggle(); buildTransport(); }
function buildTransport() {
  const b = (act, icon) => `<button class="ibtn" data-act="${act}" title="${esc(tip(act))}">${ICONS[icon]}</button>`;
  $('#transport').innerHTML = `<span class="tc" id="tcNow"></span><span class="flex"></span>
    ${b('toStart', 'toStart')}${b('prevFrame', 'prevFrame')}${b('playPause', preview.playing ? 'pause' : 'play')}${b('nextFrame', 'nextFrame')}${b('toEnd', 'toEnd')}
    <span class="flex"></span><span style="display:flex;align-items:center;gap:4px" title="${esc(t('ui.volume'))}">${ICONS.speaker}<input type="range" id="vol" min="0" max="1" step="0.05" value="${settings.volume}"></span>
    ${b('fullscreen', 'full')}<span class="tc dim" id="tcLen"></span>`;
  updateTimecode(); syncDisabled();
}
function updateTimecode() {
  const a = $('#tcNow'), b = $('#tcLen');
  if (a) a.textContent = TL.timecode(preview.time, project.fps);
  if (b) b.textContent = TL.timecode(TL.total(project), project.fps);
}
$('#transport').addEventListener('input', e => { if (e.target.id === 'vol') { settings.volume = +e.target.value; preview.setVolume(settings.volume); saveState(); } });
let full = false;
async function setFull(on) {
  full = on; document.body.classList.toggle('full', on);
  if (invoke) await invoke('set_fullscreen', {on}).catch(() => {});
}

/* ================= Timeline ================= */
const tlScroll = $('#tlScroll'), tlInner = $('#tlInner');
const pps = () => settings.pps;
const laneLeft = () => tlInner.getBoundingClientRect().left + HEAD;
const timeAt = x => Math.max(0, (x - laneLeft()) / pps());
const SV = p => `<svg viewBox="0 0 24 24">${p}</svg>`;
function rulerStep() {
  const steps = [1 / project.fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  return steps.find(s => s * pps() >= 80) || 3600;
}
const rulerLabel = (s, stp) => stp < 1 ? TL.timecode(s, project.fps) : fmtDur(s).replace('–', '0:00');
function renderTimeline() {
  // Room after the end of the film for more clips: about half the visible width.
  const view = Math.max(200, tlScroll.clientWidth - HEAD);
  const width = Math.max(view, Math.max(TL.total(project), preview.time) * pps() + view * .6);
  tlInner.style.width = HEAD + width + 'px';
  tlInner.style.setProperty('--tl-head', HEAD + 'px');
  const stp = rulerStep(), minor = stp >= 1 ? stp / 5 : stp / 2;
  let ticks = '';
  for (let s = 0, i = 0; s * pps() <= width; i++, s = i * minor) {
    const big = Math.abs(s / stp - Math.round(s / stp)) < 1e-6;
    ticks += `<i class="${big ? 'big' : ''}" style="left:${(s * pps()).toFixed(1)}px"></i>` + (big ? `<b style="left:${(s * pps()).toFixed(1)}px">${rulerLabel(s, stp)}</b>` : '');
    if (i > 20000) break;
  }
  const btn = (act, icon, title, extra = '') => `<button class="ibtn ${extra}" data-tl="${act}" title="${esc(title)}">${ICONS[icon]}</button>`;
  let h = `<div class="tl-rulerrow"><div class="tl-corner">${btn('addVideoTrack', 'plusV', t('a.addVideoTrack'))}${btn('addAudioTrack', 'plusA', t('a.addAudioTrack'))}</div><div class="tl-ruler" id="ruler">${ticks}</div></div>`;
  for (const tr of project.tracks) {
    h += `<div class="tl-row ${tr.kind}" data-track="${tr.id}"><div class="tl-th"><span class="nm">${esc(tr.name)}</span><span class="flex"></span>` +
      (tr.kind === 'video' ? btn('hide', tr.hidden ? 'eyeOff' : 'eye', t(tr.hidden ? 'ui.showTrack' : 'ui.hideTrack'), tr.hidden ? 'off' : '') : '') +
      btn('mute', tr.muted ? 'muted' : 'speaker', t(tr.muted ? 'ui.unmuteTrack' : 'ui.muteTrack'), tr.muted ? 'off' : '') +
      `</div><div class="tl-lane">${tr.clips.map(clipHtml).join('')}</div></div>`;
  }
  h += `<div class="tl-ph" id="ph"></div><div class="tl-snap" id="snapLine"></div>`;
  if (!clipCount()) h += `<div class="tl-empty">${esc(t('ui.tlEmpty'))}</div>`;
  tlInner.innerHTML = h;
  updatePlayhead();
}
function clipHtml(c) {
  const m = TL.mediaOf(project, c.media), off = m && offline.has(m.id);
  const name = c.kind === 'text' ? (c.text || t('ui.title')).split('\n')[0] : m ? m.name : '?';
  const w = c.dur * pps();
  const fade = (k, d) => d > 0 ? `<i class="fade ${k}" style="width:${Math.min(w, d * pps()).toFixed(1)}px"></i>` : '';
  return `<div class="clip k-${c.kind}${sel.has(c.id) ? ' sel' : ''}${off ? ' offline' : ''}" data-id="${c.id}" style="left:${(c.start * pps()).toFixed(1)}px;width:${w.toFixed(1)}px" title="${esc(name)}">` +
    fade('in', c.fadeIn) + fade('out', c.fadeOut) +
    `<span class="cl-name">${esc(name)}</span>` + (w > 70 ? `<span class="cl-sub">${TL.timecode(c.dur, project.fps)}${c.opacity < 1 ? ' · ' + Math.round(c.opacity * 100) + '%' : ''}</span>` : '') +
    (c.muted ? `<span class="muted-mark">${esc(t('ui.mutedShort'))}</span>` : '') +
    `<i class="edge l"></i><i class="edge r"></i></div>`;
}
function updatePlayhead() {
  const ph = $('#ph'); if (ph) ph.style.left = HEAD + preview.time * pps() + 'px';
  $('#stTc') && ($('#stTc').textContent = TL.timecode(preview.time, project.fps));
}
/* While playing, the timeline scrolls along with the playhead. */
function follow(tm) {
  const x = tm * pps(), view = tlScroll.clientWidth - HEAD;
  if (x < tlScroll.scrollLeft || x > tlScroll.scrollLeft + view - 20) tlScroll.scrollLeft = Math.max(0, x - 40);
  if (x + 200 > parseFloat(tlInner.style.width) - HEAD) renderTimeline();
}
function renderSel() { $$('.clip').forEach(el => el.classList.toggle('sel', sel.has(el.dataset.id))); renderDock(); updateStatus(); syncDisabled(); }
function setZoom(v, anchorX) {
  const old = pps(), nv = clamp(v, 2, 600);
  if (Math.abs(nv - old) < 1e-6) return;
  const x = anchorX ?? (laneLeft() + Math.min(preview.time * old - tlScroll.scrollLeft, tlScroll.clientWidth - HEAD));
  const at = timeAt(x);
  settings.pps = nv; saveState(); renderTimeline();
  tlScroll.scrollLeft = Math.max(0, at * nv - (x - tlScroll.getBoundingClientRect().left - HEAD));
  updateStatus();
}
const zoomStep = dir => setZoom(pps() * (dir > 0 ? 1.4 : 1 / 1.4));
function zoomFit() { const len = TL.total(project) || 30; setZoom((tlScroll.clientWidth - HEAD - 30) / len); tlScroll.scrollLeft = 0; }
tlScroll.addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(pps() * Math.exp(-e.deltaY * 0.004), e.clientX);
}, {passive: false});
let snapTol = () => 8 / pps();
function showSnap(at) { const l = $('#snapLine'); if (!l) return; l.style.display = at == null ? 'none' : 'block'; if (at != null) l.style.left = HEAD + at * pps() + 'px'; }

/* Mouse on the timeline: ruler → playhead; clip → select, move, trim (or cut with the razor); empty lane → playhead. */
tlInner.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const tlb = e.target.closest('[data-tl]');
  if (tlb) return;
  if (e.target.closest('.tl-th,.tl-corner')) return;
  if (e.target.closest('.tl-ruler')) return scrub(e);
  const el = e.target.closest('.clip');
  if (!el) {
    if (!e.shiftKey && sel.size) { sel.clear(); renderSel(); }
    if (e.target.closest('.tl-lane')) scrub(e);
    return;
  }
  const id = el.dataset.id;
  if (tool === 'razor') {
    let at = timeAt(e.clientX);
    if (settings.snap) at = TL.snap(at, [preview.time], snapTol());
    edit(() => !!TL.split(project, id, TL.frame(project, at)));
    return;
  }
  if (e.shiftKey || e.ctrlKey || e.metaKey) { if (sel.has(id)) sel.delete(id); else sel.add(id); }
  else if (!sel.has(id)) sel = new Set([id]);
  renderSel();
  const edge = e.target.closest('.edge');
  drag(e, id, edge ? (edge.classList.contains('l') ? 'left' : 'right') : 'move');
});
function scrub(e) {
  if (preview.playing) { preview.pause(); buildTransport(); }
  const to = x => {
    let at = timeAt(x);
    if (settings.snap && !e.altKey) at = TL.snap(at, TL.snapPoints(project), snapTol());
    seek(at);
  };
  to(e.clientX);
  try { tlInner.setPointerCapture(e.pointerId); } catch (er) {}
  const mv = ev => to(ev.clientX);
  const up = () => { tlInner.removeEventListener('pointermove', mv); tlInner.removeEventListener('pointerup', up); tlInner.removeEventListener('pointercancel', up); };
  tlInner.addEventListener('pointermove', mv); tlInner.addEventListener('pointerup', up); tlInner.addEventListener('pointercancel', up);
}
function drag(e, id, mode) {
  const f = TL.findClip(project, id); if (!f) return;
  const before = TL.save(project), x0 = e.clientX, start0 = f.clip.start;
  let moved = false, trackNow = f.track;
  try { tlInner.setPointerCapture(e.pointerId); } catch (er) {}
  const mv = ev => {
    if (!moved && Math.abs(ev.clientX - x0) < 3 && mode !== 'move') return;
    if (!moved && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - e.clientY) < 3) return;
    moved = true;
    const c = f.clip, pts = settings.snap && !ev.altKey ? TL.snapPoints(project, [id], [preview.time]) : [];
    let shown = null;
    if (mode === 'move') {
      let s = Math.max(0, start0 + (ev.clientX - x0) / pps());
      if (pts.length) {
        const a = TL.snap(s, pts, snapTol()), b = TL.snap(s + c.dur, pts, snapTol()) - c.dur;
        if (a !== s && (b === s || Math.abs(a - s) <= Math.abs(b - s))) { s = a; shown = a; } else if (b !== s) { s = b; shown = b + c.dur; }
      }
      const row = document.elementFromPoint(ev.clientX, ev.clientY);
      const tr = row && row.closest('.tl-row') && project.tracks.find(x => x.id === row.closest('.tl-row').dataset.track);
      if (tr && tr !== trackNow && TL.fits(tr, c.kind)) { trackNow.clips.splice(trackNow.clips.indexOf(c), 1); tr.clips.push(c); trackNow = tr; }
      c.start = Math.max(0, s);
    } else {
      let at = timeAt(ev.clientX);
      if (pts.length) { const a = TL.snap(at, pts, snapTol()); if (a !== at) { at = a; shown = a; } }
      TL.trim(project, id, mode, at);
    }
    const sl = tlScroll.scrollLeft;
    renderTimeline(); tlScroll.scrollLeft = sl;
    const el = tlInner.querySelector(`.clip[data-id="${id}"]`); if (el) el.classList.add('dragging');
    showSnap(shown);
  };
  const up = () => {
    tlInner.removeEventListener('pointermove', mv); tlInner.removeEventListener('pointerup', up); tlInner.removeEventListener('pointercancel', up);
    showSnap(null);
    if (!moved) return;
    if (mode === 'move') TL.move(project, id, TL.frame(project, f.clip.start), trackNow.id);
    if (TL.save(project) !== before) { hist.push(before); setDirty(true); }
    refresh();
  };
  tlInner.addEventListener('pointermove', mv); tlInner.addEventListener('pointerup', up); tlInner.addEventListener('pointercancel', up);
}
tlInner.addEventListener('click', e => {
  const b = e.target.closest('[data-tl]'); if (!b) return;
  const row = b.closest('.tl-row'), tr = row && project.tracks.find(x => x.id === row.dataset.track);
  const a = b.dataset.tl;
  if (a === 'addVideoTrack') edit(() => !!TL.addTrack(project, 'video'));
  else if (a === 'addAudioTrack') edit(() => !!TL.addTrack(project, 'audio'));
  else if (a === 'hide' && tr) edit(() => { tr.hidden = !tr.hidden; return true; });
  else if (a === 'mute' && tr) edit(() => { tr.muted = !tr.muted; return true; });
});
tlInner.addEventListener('dblclick', e => {
  const el = e.target.closest('.clip'); if (!el) return;
  sel = new Set([el.dataset.id]); settings.dockTab = 'props'; settings.dock = true; applySettings(); renderSel();
});

/* The splitter between preview and timeline. */
$('#splitH').addEventListener('pointerdown', e => {
  const sp = e.currentTarget, y0 = e.clientY, h0 = settings.tlHeight;
  try { sp.setPointerCapture(e.pointerId); } catch (er) {} sp.classList.add('on');
  const mv = ev => { settings.tlHeight = clamp(h0 - (ev.clientY - y0), 120, window.innerHeight - 260); applyTlHeight(); };
  const up = () => { sp.classList.remove('on'); sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); saveState(); preview.redraw(); };
  sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up);
});
function applyTlHeight() {
  $('#timeline').style.height = settings.tlHeight + 'px';
  document.documentElement.style.setProperty('--tl-vh', '58px'); document.documentElement.style.setProperty('--tl-ah', '44px');
}

/* ================= Media from the panel onto the timeline (pointer drag: the window's file drop switches HTML drag off) ================= */
function mediaDrag(e, m) {
  const x0 = e.clientX, y0 = e.clientY;
  let ghost = null, over = null;
  const target = ev => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = el && el.closest('.tl-row');
    const tr = row && project.tracks.find(x => x.id === row.dataset.track);
    if (tr && TL.fits(tr, m.kind)) return {track: tr, row};
    if (el && el.closest('#screen')) return {screen: true};
    if (el && el.closest('.tl-scroll')) return {anywhere: true};
    return null;
  };
  const mv = ev => {
    if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    if (!ghost) { ghost = document.createElement('div'); ghost.className = 'ghost'; ghost.textContent = m.name; document.body.append(ghost); document.body.classList.add('dragging-media'); }
    ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
    const tg = target(ev);
    $$('.tl-row.drop').forEach(r => r.classList.remove('drop'));
    if (tg && tg.row) tg.row.classList.add('drop');
    over = tg;
  };
  const up = ev => {
    document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
    document.body.classList.remove('dragging-media');
    $$('.tl-row.drop').forEach(r => r.classList.remove('drop'));
    if (!ghost) return;
    ghost.remove();
    if (!over) return;
    let at = over.screen ? preview.time : timeAt(ev.clientX);
    if (!over.screen && settings.snap) at = TL.snap(at, TL.snapPoints(project, [], [preview.time]), snapTol());
    const c = edit(() => TL.place(project, m, TL.frame(project, at), over.track ? over.track.id : null, settings.imageSec));
    if (c) { sel = new Set([c.id]); renderSel(); }
  };
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
}
function addAtPlayhead(m) {
  const c = edit(() => TL.place(project, m, preview.time, null, settings.imageSec));
  if (c) { sel = new Set([c.id]); renderSel(); }
}

/* ================= Side panel ================= */
function renderDock() {
  $$('#dockTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === settings.dockTab));
  $$('.dpanel').forEach(p => p.classList.toggle('active', p.dataset.panel === settings.dockTab));
  if (settings.dockTab === 'media') renderMedia();
  else if (settings.dockTab === 'props') renderProps();
  else renderProject();
}
$('#dockTabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { settings.dockTab = b.dataset.tab; saveState(); renderDock(); } });
const kindIcon = k => ICONS['k_' + k] || '';
function renderMedia() {
  const used = new Set(project.tracks.flatMap(tr => tr.clips.map(c => c.media)));
  const items = project.media.map(m => {
    const off = offline.has(m.id), url = esc(fileUrl(m.path));
    const thumb = off ? kindIcon(m.kind) : m.kind === 'video' ? `<video src="${url}#t=0.5" preload="metadata" muted></video>` : m.kind === 'image' ? `<img src="${url}" alt="">` : kindIcon('audio');
    const info = off ? `<small>${esc(t('ui.offline'))} · <a href="#" data-relink="${m.id}">${esc(t('a.relink'))}</a></small>` :
      `<small>${esc(t('kind.' + m.kind))}${m.duration ? ' · ' + fmtDur(m.duration) : ''}${m.width ? ` · ${m.width} × ${m.height}` : ''}${used.has(m.id) ? ` · <span class="bin-used">${esc(t('ui.inUse'))}</span>` : ''}</small>`;
    return `<div class="bin-item${selMedia === m.id ? ' on' : ''}${off ? ' offline' : ''}" data-media="${m.id}" title="${esc(m.path)}"><div class="bin-thumb">${thumb}</div><div style="min-width:0"><div class="bin-name">${esc(m.name)}</div>${info}</div></div>`;
  }).join('');
  $('#mediaBox').innerHTML = `<div class="dtools"><button class="btn-sm primary" data-act="importMedia">${esc(t('a.importMedia'))}</button><button class="btn-sm" data-act="addTitle">${esc(t('a.addTitle'))}</button></div>` +
    (items ? `<div class="bin">${items}</div><p class="hint" style="margin-top:12px">${esc(t('ui.binHint'))}</p>` : `<div class="empty">${esc(t('ui.binEmpty'))}</div>`);
  syncDisabled();
}
$('#mediaBox').addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const it = e.target.closest('[data-media]'); if (!it || e.target.closest('a')) return;
  const m = TL.mediaOf(project, it.dataset.media); if (!m) return;
  selMedia = m.id; $$('.bin-item').forEach(x => x.classList.toggle('on', x === it));
  if (!offline.has(m.id)) mediaDrag(e, m);
});
$('#mediaBox').addEventListener('dblclick', e => { const it = e.target.closest('[data-media]'); if (!it) return; const m = TL.mediaOf(project, it.dataset.media); if (m && !offline.has(m.id)) addAtPlayhead(m); });
$('#mediaBox').addEventListener('click', e => { const a = e.target.closest('[data-relink]'); if (a) { e.preventDefault(); relink(a.dataset.relink); } });

/* Properties of the selected clip(s). Sliders change live; one undo step per change. */
let editBefore = null;
function renderProps() {
  const box = $('#propsBox'), list = selected();
  if (!list.length) { box.innerHTML = `<div class="empty">${esc(t('ui.noSelection'))}</div>`; return; }
  if (list.length > 1) {
    box.innerHTML = `<div class="psec"><div class="psec-h">${esc(t('ui.nSelected', {n: list.length}))}</div><p class="hint">${esc(t('ui.multiHint'))}</p>
      <p><button class="btn-sm" data-act="deleteClips">${esc(t('a.deleteClips'))}</button> <button class="btn-sm" data-act="rippleDelete">${esc(t('a.rippleDelete'))}</button></p></div>`;
    return;
  }
  const {track: tr, clip: c} = list[0], m = TL.mediaOf(project, c.media);
  const range = (k, min, max, stp, val, unit) => `<div class="prop"><span>${esc(t('p.' + k))}</span><div class="range"><input type="range" data-p="${k}" min="${min}" max="${max}" step="${stp}" value="${val}"><b>${Math.round(val * 100)}${unit}</b></div></div>`;
  const numIn = (k, val, stp = 0.1) => `<div class="prop"><span>${esc(t('p.' + k))}</span><input type="number" data-p="${k}" min="0" step="${stp}" value="${Math.round(val * 1000) / 1000}"></div>`;
  let h = `<div class="psec"><div class="psec-h">${esc(t('kind.' + c.kind))} · ${esc(tr.name)}</div>` +
    (m ? `<div class="kv"><span>${esc(t('p.file'))}</span><b title="${esc(m.path)}">${esc(m.name)}</b></div>` : '') +
    `<div class="kv"><span>${esc(t('p.start'))}</span><b class="tc-val">${TL.timecode(c.start, project.fps)}</b></div>` +
    (c.kind === 'video' || c.kind === 'audio' ? `<div class="kv"><span>${esc(t('p.in'))}</span><b class="tc-val">${TL.timecode(c.in, project.fps)}</b></div>` : '') +
    numIn('dur', c.dur) + '</div>';
  if (c.kind === 'text') {
    h += `<div class="psec"><div class="psec-h">${esc(t('ui.title'))}</div>
      <div class="prop" style="grid-template-columns:1fr"><textarea data-p="text" placeholder="${esc(t('p.textHint'))}">${esc(c.text)}</textarea></div>
      <div class="prop"><span>${esc(t('p.size'))}</span><div class="range"><input type="range" data-p="size" min="2" max="25" step="0.5" value="${c.size}"><b>${num(c.size)} %</b></div></div>
      <div class="prop"><span>${esc(t('p.color'))}</span><input type="color" data-p="color" value="${esc(c.color)}"></div>
      <div class="prop"><span>${esc(t('p.pos'))}</span><div class="seg">${['top', 'center', 'bottom'].map(v => `<button data-pos="${v}" class="${c.pos === v ? 'active' : ''}">${esc(t('p.pos.' + v))}</button>`).join('')}</div></div>
      <label class="switch"><input type="checkbox" data-p="box"${c.box ? ' checked' : ''}><span></span>${esc(t('p.box'))}</label>
      <label class="switch"><input type="checkbox" data-p="bold"${c.bold !== false ? ' checked' : ''}><span></span>${esc(t('p.bold'))}</label></div>`;
  }
  h += `<div class="psec"><div class="psec-h">${esc(t('ui.look'))}</div>`;
  if (c.kind !== 'audio') h += range('opacity', 0, 1, 0.01, c.opacity, ' %');
  if (c.kind === 'video' || c.kind === 'audio') {
    h += range('volume', 0, 2, 0.01, c.volume, ' %') + `<label class="switch"><input type="checkbox" data-p="muted"${c.muted ? ' checked' : ''}><span></span>${esc(t('p.muted'))}</label>`;
    if (c.kind === 'video' && m && m.hasAudio === false) h += `<p class="hint">${esc(t('p.noSound'))}</p>`;
  }
  h += numIn('fadeIn', c.fadeIn) + numIn('fadeOut', c.fadeOut) + `</div>
    <p><button class="btn-sm" data-act="splitPlayhead">${esc(t('a.splitPlayhead'))}</button> <button class="btn-sm" data-act="deleteClips">${esc(t('a.deleteClips'))}</button></p>`;
  box.innerHTML = h;
  syncDisabled();
}
function propChange(el, final) {
  const s = single(); if (!s) return;
  const c = s.clip, k = el.dataset.p;
  if (!editBefore) editBefore = TL.save(project);
  if (k === 'text' || k === 'color') c[k] = el.value;
  else if (k === 'box' || k === 'bold' || k === 'muted') c[k] = el.checked;
  else if (k === 'dur') { const v = Math.max(TL.MIN_DUR, +el.value || 0); if (final) TL.trim(project, c.id, 'right', c.start + v); }
  else if (k === 'fadeIn' || k === 'fadeOut') c[k] = clamp(+el.value || 0, 0, c.dur);
  else c[k] = +el.value;
  const b = el.parentElement.querySelector('b');
  if (b) b.textContent = k === 'size' ? num(c.size) + ' %' : Math.round(c[k] * 100) + ' %';
  renderTimeline(); preview.setProject(project, offline);
  if (final) {
    if (TL.save(project) !== editBefore) { hist.push(editBefore); setDirty(true); }
    editBefore = null; syncDisabled();
    if (k === 'dur' || k === 'fadeIn' || k === 'fadeOut') renderProps();
  }
}
$('#propsBox').addEventListener('input', e => { if (e.target.dataset.p && e.target.type !== 'number') propChange(e.target, false); });
$('#propsBox').addEventListener('change', e => { if (e.target.dataset.p) propChange(e.target, true); });
$('#propsBox').addEventListener('click', e => {
  const b = e.target.closest('[data-pos]'); if (!b) return;
  const s = single(); if (!s) return;
  edit(() => { s.clip.pos = b.dataset.pos; return true; });
});

function renderProject() {
  const res = `${project.width}x${project.height}`, opt = (v, l, c) => `<option value="${v}"${String(v) === String(c) ? ' selected' : ''}>${esc(l)}</option>`;
  const resList = TL.RESOLUTIONS.map(([w, h]) => opt(`${w}x${h}`, `${w} × ${h} · ${t('res.' + w + 'x' + h)}`, res));
  if (!TL.RESOLUTIONS.some(([w, h]) => `${w}x${h}` === res)) resList.unshift(opt(res, `${project.width} × ${project.height}`, res));
  const unused = TL.unused(project).length;
  $('#projectBox').innerHTML = `<div class="psec"><div class="psec-h">${esc(t('ui.project'))}</div>
    <div class="prop"><span>${esc(t('pp.name'))}</span><input type="text" data-pp="name" value="${esc(project.name)}" placeholder="${esc(projName())}"></div>
    <div class="prop"><span>${esc(t('pp.size'))}</span><select data-pp="res">${resList.join('')}</select></div>
    <div class="prop"><span>${esc(t('pp.fps'))}</span><select data-pp="fps">${TL.FPS.map(f => opt(f, f + ' fps', project.fps)).join('')}</select></div>
    <div class="kv"><span>${esc(t('pp.length'))}</span><b class="tc-val">${TL.timecode(TL.total(project), project.fps)}</b></div>
    <div class="kv"><span>${esc(t('pp.clips'))}</span><b>${clipCount()}</b></div>
    <div class="kv"><span>${esc(t('pp.media'))}</span><b>${project.media.length}${offline.size ? ' · ' + esc(t('pp.missing', {n: offline.size})) : ''}</b></div>
    <div class="kv"><span>${esc(t('pp.file'))}</span><b title="${esc(filePath || '')}">${esc(filePath ? baseName(filePath) : t('pp.notSaved'))}</b></div></div>
    <p><button class="btn-sm primary" data-act="export">${esc(t('a.export'))}</button> <button class="btn-sm" data-act="removeUnused"${unused ? '' : ' disabled'}>${esc(t('a.removeUnused'))}${unused ? ` (${unused})` : ''}</button></p>
    <p class="hint">${esc(t('pp.hint'))}</p>`;
  syncDisabled();
}
$('#projectBox').addEventListener('change', e => {
  const k = e.target.dataset.pp; if (!k) return;
  edit(() => {
    if (k === 'name') project.name = e.target.value.trim();
    else if (k === 'res') { const [w, h] = e.target.value.split('x').map(Number); project.width = w; project.height = h; }
    else if (k === 'fps') project.fps = +e.target.value;
    return true;
  });
});

/* ================= Export ================= */
let expId = 0, expRunning = null;
async function openExport() {
  if (!invoke) return;
  if (preview.playing) { preview.pause(); buildTransport(); }
  const info = await invoke('export_formats').catch(() => ({available: false, formats: []}));
  const head = t('exp.title');
  if (!info.available) return modal(head, `<p class="note-box">${esc(t('exp.noFfmpeg'))}</p>`);
  if (TL.total(project) <= 0) return toast(t('toast.emptyTimeline'));
  const fmt = info.formats.includes(settings.format) ? settings.format : info.formats[0];
  const opt = (v, l, c) => `<option value="${v}"${v === c ? ' selected' : ''}>${esc(l)}</option>`;
  modal(head, `<div class="exp-row"><span>${esc(t('exp.format'))}</span><select id="expFmt" class="wide-sel">${info.formats.map(f => opt(f, t('exp.f.' + f), fmt)).join('')}</select></div>
    <div class="exp-row" id="expQRow"><span>${esc(t('exp.quality'))}</span><div class="seg" id="expQ">${['low', 'medium', 'high'].map(q => `<button data-q="${q}" class="${settings.quality === q ? 'active' : ''}">${esc(t('exp.q.' + q))}</button>`).join('')}</div></div>
    <div class="exp-row"><span>${esc(t('exp.frame'))}</span><b>${project.width} × ${project.height} · ${project.fps} fps</b></div>
    <div class="exp-row"><span>${esc(t('exp.length'))}</span><b>${TL.timecode(TL.total(project), project.fps)}</b></div>
    ${offline.size ? `<p class="note-box">${esc(t('exp.offline', {n: offline.size}))}</p>` : ''}
    <div id="expRun" hidden><div class="bar"><i id="expBar"></i></div><div class="hint" id="expMsg"></div></div>`);
  const foot = $('#modalFoot'); foot.hidden = false;
  foot.innerHTML = `<span class="flex"></span><button class="btn-sm" id="expCancel">${esc(t('ui.cancel'))}</button><button class="btn-sm primary" id="expGo"${offline.size ? ' disabled' : ''}>${esc(t('exp.go'))}</button>`;
  const syncQ = () => { $('#expQRow').hidden = ['wav', 'm4a'].includes($('#expFmt').value); };
  syncQ();
  $('#expFmt').onchange = () => { settings.format = $('#expFmt').value; saveState(); syncQ(); };
  $('#expQ').onclick = e => { const b = e.target.closest('[data-q]'); if (!b) return; settings.quality = b.dataset.q; saveState(); $$('#expQ button').forEach(x => x.classList.toggle('active', x === b)); };
  $('#expCancel').onclick = () => { if (expRunning != null) invoke('export_cancel', {id: expRunning}); else closeModal(); };
  $('#expGo').onclick = () => runExport($('#expFmt').value);
}
async function runExport(format) {
  const path = await invoke('export_pick', {name: projName(), ext: format, label: t('exp.f.' + format)}).catch(() => null);
  if (!path) return;
  const id = ++expId; expRunning = id;
  $('#expRun').hidden = false; $('#expGo').disabled = true; $('#expFmt').disabled = true;
  $('#expMsg').textContent = t('exp.running', {name: baseName(path)});
  const payload = TL.forExport(project, c => Preview.titlePng(c, project.width, project.height));
  try {
    const out = await invoke('export_run', {id, project: payload, output: {format, quality: settings.quality}, file: path});
    expRunning = null;
    $('#expBar').style.width = '100%';
    $('#expMsg').textContent = t('exp.done', {name: baseName(out)});
    $('#modalFoot').innerHTML = `<span class="flex"></span><button class="btn-sm" id="expReveal">${esc(t('a.reveal'))}</button><button class="btn-sm primary" id="expClose">${esc(t('set.done'))}</button>`;
    $('#expReveal').onclick = () => invoke('reveal', {path: out}).catch(() => {});
    $('#expClose').onclick = closeModal;
    toast(t('exp.done', {name: baseName(out)}));
  } catch (err) {
    expRunning = null;
    const e = String(err);
    if (e === 'cancelled') { toast(t('exp.cancelled')); closeModal(); return; }
    $('#expMsg').innerHTML = `<span style="color:var(--danger)">${esc(e.startsWith('missing:') ? t('exp.missingFile', {name: baseName(e.slice(8))}) : t('exp.fail', {e}))}</span>`;
    $('#expGo').disabled = false; $('#expFmt').disabled = false;
  }
}
if (window.__TAURI__) window.__TAURI__.event.listen('export-progress', ev => {
  const p = ev.payload || {}; if (p.id !== expRunning) return;
  const bar = $('#expBar'); if (bar) bar.style.width = Math.round(p.ratio * 100) + '%';
  const msg = $('#expMsg'); if (msg && p.ratio < 1) msg.textContent = t('exp.progress', {p: Math.round(p.ratio * 100)});
});

/* ================= Actions ================= */
const A = {
  newProject: () => newProject(), openProject: () => openProject(), saveProject: () => saveProject(false), saveAs: () => saveProject(true),
  importMedia: () => importMedia(), export: () => openExport(),
  revealProject: () => { if (filePath) invoke('reveal', {path: filePath}).catch(() => {}); },
  undo: () => undo(), redo: () => redo(),
  copyClips: () => { clip = TL.copy(project, [...sel]); toast(t('toast.copied', {n: clip.length})); syncDisabled(); },
  cutClips: () => { clip = TL.copy(project, [...sel]); edit(() => TL.remove(project, [...sel])); },
  pasteClips: () => { const list = edit(() => TL.paste(project, clip, preview.time)); if (list) { sel = new Set(list.map(c => c.id)); renderSel(); } },
  duplicate: () => {
    const items = TL.copy(project, [...sel]), after = Math.max(...selected().map(s => TL.end(s.clip)));
    const list = edit(() => TL.paste(project, items, after)); if (list) { sel = new Set(list.map(c => c.id)); renderSel(); }
  },
  deleteClips: () => edit(() => TL.remove(project, [...sel])),
  rippleDelete: () => edit(() => { TL.rippleRemove(project, [...sel]); return true; }),
  splitPlayhead: () => {
    const ids = sel.size ? [...sel] : null;
    const parts = edit(() => { const r = TL.splitAt(project, preview.time, ids); return r.length ? r : false; });
    if (!parts) toast(t('toast.nothingToSplit'));
  },
  selectAll: () => { sel = new Set(project.tracks.flatMap(tr => tr.clips.map(c => c.id))); renderSel(); },
  addTitle: () => {
    const c = edit(() => TL.addTitle(project, preview.time, t('ui.titleDefault'), null, settings.titleSec));
    if (c) { sel = new Set([c.id]); settings.dockTab = 'props'; settings.dock = true; applySettings(); renderSel(); setTimeout(() => { const a = $('#propsBox textarea'); if (a) { a.focus(); a.select(); } }, 30); }
  },
  muteClip: () => edit(() => { for (const s of selected()) if (s.clip.kind === 'video' || s.clip.kind === 'audio') s.clip.muted = !s.clip.muted; return true; }),
  removeUnused: () => edit(() => { const u = new Set(TL.unused(project).map(m => m.id)); project.media = project.media.filter(m => !u.has(m.id)); return u.size > 0; }),
  addVideoTrack: () => edit(() => !!TL.addTrack(project, 'video')), addAudioTrack: () => edit(() => !!TL.addTrack(project, 'audio')),
  toolSelect: () => setTool('select'), toolRazor: () => setTool('razor'),
  toggleSnap: () => { settings.snap = !settings.snap; saveState(); buildToolbars(); updateStatus(); toast(t(settings.snap ? 'toast.snapOn' : 'toast.snapOff')); },
  playPause: () => playPause(), toStart: () => { step(0); seek(0); }, toEnd: () => { step(0); seek(TL.total(project)); },
  prevFrame: () => step(-1), nextFrame: () => step(1), back1: () => step(-1, 1), fwd1: () => step(1, 1),
  prevCut: () => { const x = TL.cut(project, preview.time, -1); if (x != null) { step(0); seek(x); } },
  nextCut: () => { const x = TL.cut(project, preview.time, 1); if (x != null) { step(0); seek(x); } },
  zoomIn: () => zoomStep(1), zoomOut: () => zoomStep(-1), zoomFit: () => zoomFit(),
  fullscreen: () => setFull(!full),
  togglePanels: () => { settings.dock = !settings.dock; applySettings(); },
  toggleAutoHide: () => { settings.autoHide = !settings.autoHide; applySettings(); },
  settings: () => openSettings(),
  langAuto: () => setLang('auto'), langEn: () => setLang('en'), langDe: () => setLang('de'),
  themeDark: () => setTheme('dark'), themeLight: () => setTheme('light'), themeGithub: () => setTheme('github'), themeGithubDark: () => setTheme('github-dark'), themeCli: () => setTheme('cli'), themeCliAmber: () => setTheme('cli-amber'), themeCliCyan: () => setTheme('cli-cyan'), themeCliMagenta: () => setTheme('cli-magenta'), themeCliWhite: () => setTheme('cli-white'), themeMidnight: () => setTheme('midnight'), themeDusk: () => setTheme('dusk'), themeGraphite: () => setTheme('graphite'), themeContrast: () => setTheme('contrast'), themeSand: () => setTheme('sand'), themeRose: () => setTheme('rose'), themeProton: () => setTheme('proton'),
  shortcuts: () => {
    let h = '';
    MENUS.forEach(([m, items]) => {
      const rows = items.filter(it => Array.isArray(it) && it[1]);
      if (rows.length) h += `<h4>${esc(t('menu.' + m))}</h4><table>` + rows.map(it => `<tr><td>${esc(t('a.' + it[0]))}</td><td><kbd>${esc(fmtKey(it[1]))}</kbd></td></tr>`).join('') + '</table>';
    });
    h += `<h4>${esc(t('keys.more'))}</h4><table>${[['keys.drag', t('keys.dragKey')], ['keys.noSnap', 'Alt'], ['keys.multi', fmtKey('Shift') + ' / ' + fmtKey('Ctrl')], ['keys.wheel', fmtKey('Ctrl') + ' + ' + t('keys.wheelKey')]].map(([k, v]) => `<tr><td>${esc(t(k))}</td><td><kbd>${esc(v)}</kbd></td></tr>`).join('')}</table>`;
    modal(t('a.shortcuts'), h);
  },
  about: async () => {
    const v = invoke ? await window.__TAURI__.app.getVersion().catch(() => '') : '';
    modal(t('a.about'), `${v ? `<p><b>${esc(t('about.version', {v}))}</b></p>` : ''}<p>${esc(t('about.p1'))}</p><p>${esc(t('about.p2'))}</p><p class="hint">${esc(t('about.licenses'))}</p>`);
  }
};
function setTool(x) { tool = x; document.body.classList.toggle('razor', x === 'razor'); buildToolbars(); updateStatus(); }

// Menu items: [action, shortcut, checked(), fixed, more keys]; '-' separator, '#key' section label (as in every Studio app).
const MENUS = [
  ['file', [['newProject', 'Ctrl+N'], ['openProject', 'Ctrl+O'], ['saveProject', 'Ctrl+S'], ['saveAs', 'Ctrl+Shift+S'], '-', ['importMedia', 'Ctrl+I'], ['export', 'Ctrl+E'], '-', ['revealProject']]],
  ['edit', [['undo', 'Ctrl+Z'], ['redo', 'Ctrl+Shift+Z', null, false, ['Ctrl+Y']], '-', ['cutClips', 'Ctrl+X'], ['copyClips', 'Ctrl+C'], ['pasteClips', 'Ctrl+V'], ['duplicate', 'Ctrl+D'], ['deleteClips', 'Delete', null, false, ['Backspace']], ['rippleDelete', 'Shift+Delete', null, false, ['Shift+Backspace']], '-',
    ['splitPlayhead', 'Ctrl+K', null, false, ['S']], ['addTitle', 'T'], ['muteClip', 'Shift+M'], ['selectAll', 'Ctrl+A'], '-',
    ['toolSelect', 'V', () => tool === 'select'], ['toolRazor', 'C', () => tool === 'razor'], ['toggleSnap', 'N', () => settings.snap]]],
  ['play', [['playPause', 'Space'], ['toStart', 'Home'], ['toEnd', 'End'], '-', ['prevFrame', 'ArrowLeft'], ['nextFrame', 'ArrowRight'], ['back1', 'Shift+ArrowLeft'], ['fwd1', 'Shift+ArrowRight'], ['prevCut', 'ArrowUp'], ['nextCut', 'ArrowDown']]],
  ['view', [['zoomIn', '=', null, false, ['+']], ['zoomOut', '-'], ['zoomFit', 'Shift+Z'], '-', ['addVideoTrack'], ['addAudioTrack'], '-', ['fullscreen', 'F11', () => full], ['togglePanels', 'Ctrl+\\', () => settings.dock], ['toggleAutoHide', null, () => settings.autoHide]]],
  ['settings', [['settings', 'Ctrl+,'], '-', '#menu.language',
    ['langAuto', null, () => settings.lang === 'auto'], ['langEn', null, () => settings.lang === 'en'], ['langDe', null, () => settings.lang === 'de'],
    '-', '#menu.theme',
    ['themeDark', null, () => settings.theme === 'dark'], ['themeLight', null, () => settings.theme === 'light'],
    ['themeGithub', null, () => settings.theme === 'github'], ['themeGithubDark', null, () => settings.theme === 'github-dark'], ['themeCli', null, () => settings.theme === 'cli'], ['themeCliAmber', null, () => settings.theme === 'cli-amber'], ['themeCliCyan', null, () => settings.theme === 'cli-cyan'], ['themeCliMagenta', null, () => settings.theme === 'cli-magenta'], ['themeCliWhite', null, () => settings.theme === 'cli-white'], ['themeMidnight', null, () => settings.theme === 'midnight'], ['themeDusk', null, () => settings.theme === 'dusk'], ['themeGraphite', null, () => settings.theme === 'graphite'], ['themeContrast', null, () => settings.theme === 'contrast'], ['themeSand', null, () => settings.theme === 'sand'], ['themeRose', null, () => settings.theme === 'rose'], ['themeProton', null, () => settings.theme === 'proton']]],
  ['help', [['shortcuts', 'F1'], '-', ['about']]]
];
const hasClips = () => clipCount() > 0, hasSel = () => sel.size > 0;
const NEEDS = {
  saveProject: () => !!invoke, saveAs: () => !!invoke, openProject: () => !!invoke, importMedia: () => !!invoke, export: () => !!invoke && hasClips(),
  revealProject: () => !!filePath && !!invoke, undo: () => hist.canUndo, redo: () => hist.canRedo,
  cutClips: hasSel, copyClips: hasSel, pasteClips: () => clip.length > 0, duplicate: hasSel, deleteClips: hasSel, rippleDelete: hasSel,
  splitPlayhead: hasClips, muteClip: () => selected().some(s => s.clip.kind === 'video' || s.clip.kind === 'audio'), selectAll: hasClips,
  removeUnused: () => TL.unused(project).length > 0,
  playPause: hasClips, toEnd: hasClips, prevCut: hasClips, nextCut: hasClips, zoomFit: hasClips
};
const allowed = act => !NEEDS[act] || NEEDS[act]();
function run(act) { if (A[act] && allowed(act)) A[act](); }
function syncDisabled() { $$('[data-act]').forEach(b => { if (A[b.dataset.act]) b.disabled = !allowed(b.dataset.act); }); }
const KEYMAP = {};
function buildKeymap() {
  for (const k in KEYMAP) delete KEYMAP[k];
  MENUS.forEach(([, items]) => items.forEach(it => { if (Array.isArray(it) && !it[3]) [it[1], ...(it[4] || [])].forEach(k => { if (k) (KEYMAP[k] = KEYMAP[k] || []).push(it[0]); }); }));
}
let menuOpen = null;
function openMenu(m, items) {
  closeMenus();
  const dd = m.querySelector('.dropdown'); dd.innerHTML = '';
  items.forEach(it => {
    if (it === '-') return dd.append(document.createElement('hr'));
    if (typeof it === 'string') return dd.append(Object.assign(document.createElement('div'), {className: 'dd-label', textContent: t(it.slice(1))}));
    const [act, key, check] = it, b = document.createElement('button');
    b.innerHTML = `<span class="chk">${check && check() ? '&#10003;' : ''}</span><span>${esc(t('a.' + act))}</span><kbd>${esc(key ? fmtKey(key) : '')}</kbd>`;
    b.disabled = !allowed(act);
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => { closeMenus(); run(act); };
    dd.append(b);
  });
  m.classList.add('open'); menuOpen = m;
}
function closeMenus() { $$('.menu.open').forEach(x => x.classList.remove('open')); menuOpen = null; }
function buildMenubar() {
  const nav = $('#menus'); nav.innerHTML = ''; menuOpen = null;
  MENUS.forEach(([name, items]) => {
    const m = document.createElement('div'), b = document.createElement('button'), dd = document.createElement('div');
    m.className = 'menu'; dd.className = 'dropdown'; b.textContent = t('menu.' + name);
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => menuOpen === m ? closeMenus() : openMenu(m, items);
    b.onmouseenter = () => { if (menuOpen && menuOpen !== m) openMenu(m, items); };
    m.append(b, dd); nav.append(m);
  });
}
document.addEventListener('mousedown', e => { if (menuOpen && !e.target.closest('.menu')) closeMenus(); });
const keyOf = act => { for (const [, items] of MENUS) for (const it of items) if (Array.isArray(it) && it[0] === act && it[1]) return it[1]; return ''; };
const tip = act => t('a.' + act) + (keyOf(act) ? ` (${fmtKey(keyOf(act))})` : '');

const ICONS = {
  newDoc: SV('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/>'),
  open: SV('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  save: SV('<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>'),
  import: SV('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
  export: SV('<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
  undo: SV('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'), redo: SV('<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
  play: SV('<path d="m7 4 13 8-13 8z" fill="currentColor"/>'), pause: SV('<path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor"/>'),
  toStart: SV('<path d="M5 4v16M19 5 9 12l10 7z" fill="currentColor"/>'), toEnd: SV('<path d="M19 4v16M5 5l10 7-10 7z" fill="currentColor"/>'),
  prevFrame: SV('<path d="m15 6-6 6 6 6"/>'), nextFrame: SV('<path d="m9 6 6 6-6 6"/>'),
  pointer: SV('<path d="m5 3 14 8-6 2-3 6z"/>'),
  razor: SV('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M20 20 8.1 8.1"/>'),
  split: SV('<path d="M12 2v20"/><rect x="3" y="7" width="6" height="10" rx="1"/><rect x="15" y="7" width="6" height="10" rx="1"/>'),
  ripple: SV('<rect x="3" y="8" width="5" height="8" rx="1"/><rect x="16" y="8" width="5" height="8" rx="1"/><path d="M14 12H9M11 10l-2 2 2 2"/>'),
  trash: SV('<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13M9 7V4h6v3"/>'),
  title: SV('<path d="M5 5h14M12 5v14M9 19h6"/>'),
  magnet: SV('<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4M10 3v8a2 2 0 0 0 4 0V3"/>'),
  plus: SV('<path d="M12 5v14M5 12h14"/>'), minus: SV('<path d="M5 12h14"/>'),
  plusV: SV('<rect x="2" y="6" width="13" height="12" rx="2"/><path d="m15 10 4-2v8l-4-2M19 3v4M17 5h4"/>'),
  plusA: SV('<path d="M9 18V6l10-2v11"/><circle cx="6" cy="18" r="3"/><path d="M19 18v4M17 20h4"/>'),
  fit: SV('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  eye: SV('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: SV('<path d="M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.6 7.7C3.9 9.5 2 12 2 12s4 7 10 7c1.6 0 3-.4 4.3-1"/>'),
  speaker: SV('<path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
  muted: SV('<path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="m22 9-6 6M16 9l6 6"/>'),
  full: SV('<path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5"/>'),
  panel: SV('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>'),
  help: SV('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>'),
  gear: SV('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  k_video: SV('<rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3z"/>'),
  k_audio: SV('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  k_image: SV('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>'),
  k_project: SV('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20M7 4l2 5M13 4l2 5M19 4l2 5"/>')
};
function makeBtn(act, html, cls = '') {
  const b = document.createElement('button');
  b.className = 'ibtn' + (cls ? ' ' + cls : ''); b.innerHTML = html; b.title = tip(act); b.dataset.act = act;
  return b;
}
function buildToolbars() {
  const fill = (id, list) => { const box = $(id); box.innerHTML = ''; list.forEach(([a, i, c]) => box.append(makeBtn(a, ICONS[i], c))); };
  fill('#fileBtns', [['newProject', 'newDoc'], ['openProject', 'open'], ['saveProject', 'save'], ['importMedia', 'import'], ['undo', 'undo'], ['redo', 'redo']]);
  fill('#viewBtns', [['toggleSnap', 'magnet', settings.snap ? 'active' : ''], ['zoomOut', 'minus'], ['zoomIn', 'plus'], ['zoomFit', 'fit'], ['togglePanels', 'panel', settings.dock ? 'active' : ''], ['settings', 'gear'], ['shortcuts', 'help']]);
  const ctx = $('#ctxBar'); ctx.innerHTML = '';
  const g = document.createElement('div'); g.className = 'group';
  [['splitPlayhead', 'split'], ['rippleDelete', 'ripple'], ['deleteClips', 'trash'], ['addTitle', 'title'], ['muteClip', 'muted']].forEach(([a, i]) => g.append(makeBtn(a, ICONS[i])));
  ctx.append(g);
  const tools = $('#tools'); tools.innerHTML = '';
  [['toolSelect', 'pointer', tool === 'select'], ['toolRazor', 'razor', tool === 'razor'], '-', ['splitPlayhead', 'split'], ['rippleDelete', 'ripple'], ['addTitle', 'title'], '-', ['toggleSnap', 'magnet', settings.snap], '-', ['playPause', 'play'], ['fullscreen', 'full'], '-', ['export', 'export']]
    .forEach(r => { if (r === '-') { const s = document.createElement('div'); s.className = 'sep'; tools.append(s); } else tools.append(makeBtn(r[0], ICONS[r[1]], r[2] ? 'active' : '')); });
  syncDisabled();
}
document.addEventListener('mousedown', e => { if (e.target.closest('.ibtn,.cta')) e.preventDefault(); });
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) run(b.dataset.act); });

/* ================= Screen parts ================= */
function showEditor() {
  const empty = pristine();
  $('#empty').hidden = !empty; $('#editor').hidden = empty;
  if (empty) renderEmpty();
}
const FORMATS = {video: 'MP4 · MOV · M4V · WebM', audio: 'MP3 · WAV · M4A · AAC · FLAC · OGG', image: 'JPG · PNG · GIF · WebP · BMP'};
function renderEmpty() {
  $('#formats').innerHTML = Object.entries(FORMATS).map(([k, f]) => `<div><b>${ICONS['k_' + k]}${esc(t('kinds.' + k))}</b><small>${esc(f)}</small></div>`).join('');
  $('#recentBox').innerHTML = recent.length ? `<div class="sect">${esc(t('ui.recent'))}</div>` + recent.map((r, k) =>
    `<button data-recent="${k}"><span class="ficon">${ICONS.k_project}</span><span>${esc(r.name)}</span><small>${esc(r.path)}</small></button>`).join('') : '';
}
$('#recentBox').addEventListener('click', ev => { const b = ev.target.closest('[data-recent]'); if (b) openProject(recent[+b.dataset.recent].path); });
function updateTitle() {
  const title = `${projName()}${dirty ? ' •' : ''} — Video Studio`;
  document.title = title; $('#apptitle').textContent = title;
}
function updateStatus() {
  const st = $('#stState');
  st.textContent = t(dirty ? 'st.unsaved' : filePath ? 'st.saved' : 'st.new'); st.classList.toggle('dirty', dirty);
  $('#stFormat').textContent = `${project.width} × ${project.height} · ${project.fps} fps`;
  $('#stLen').textContent = t('st.length', {t: TL.timecode(TL.total(project), project.fps)});
  $('#stSel').textContent = sel.size ? t('st.selected', {n: sel.size}) : '';
  $('#stTool').textContent = t(tool === 'razor' ? 'st.razor' : 'st.select') + (settings.snap ? ' · ' + t('st.snap') : '');
  $('#stZoom').textContent = t('st.zoom', {n: Math.round(pps())});
}

/* ================= Modal, toast, settings ================= */
let settingsOpen = false, prefsSection = 'general', toastT = 0;
function toast(msg) { const n = $('#toast'); n.textContent = msg; n.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => n.classList.remove('show'), 2600); }
function modal(title, html) {
  $('.modal').classList.remove('wide'); $('#modalFoot').hidden = true; settingsOpen = false;
  $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').classList.add('show');
}
function closeModal() {
  if (expRunning != null) return;   // an export runs: stop it with Cancel
  $('#modal').classList.remove('show'); settingsOpen = false;
}
$('#modalClose').onclick = closeModal;
$('#modal').onmousedown = e => { if (e.target.id === 'modal') closeModal(); };
function openSettings(section) {
  if (section) prefsSection = section;
  $('.modal').classList.add('wide'); $('#modalFoot').hidden = false;
  settingsOpen = true; renderSettings(); $('#modal').classList.add('show');
}
function renderSettings() {
  const opt = (v, label, c) => `<option value="${v}"${String(v) === String(c) ? ' selected' : ''}>${esc(label)}</option>`;
  const sw = (name, label) => `<label class="switch"><input type="checkbox" data-sw="${name}"${settings[name] ? ' checked' : ''}><span></span>${esc(label)}</label>`;
  const mock = th => `<div class="tc-mock" data-theme="${th}"><div class="tc-bar"><i></i><i></i><i></i><b></b></div>
    <div class="tc-body" style="grid-template-columns:14px 1fr 38px"><div class="tc-rail"></div>
    <div class="tc-pv" style="padding:10px 12px"><div class="tc-paper" style="border-radius:3px;border-bottom:var(--paper-border)"><i></i><i style="width:70%"></i><i style="width:50%"></i></div></div><div class="tc-dock"></div></div></div>`;
  const body = {
    general: `<h3>${esc(t('set.language'))}</h3><p class="hint">${esc(t('set.languageHint'))}</p>
      <select class="wide-sel" data-sel="lang">${opt('auto', t('a.langAuto'), settings.lang)}${opt('en', 'English', settings.lang)}${opt('de', 'Deutsch', settings.lang)}</select>
      <h3>${esc(t('set.layout'))}</h3>${sw('dock', t('set.panels'))}${sw('autoHide', t('set.autoHide'))}
      <h3>${esc(t('set.session'))}</h3>${sw('restore', t('set.restore'))}`,
    appearance: (window.Shared ? Shared.scopePicker() : '') + `<h3>${esc(t('set.theme'))}</h3><div class="theme-grid">` + THEMES.map(th =>
      `<button class="theme-card${settings.theme === th ? ' active' : ''}" data-theme-pick="${th}">${mock(th)}
       <div class="theme-name">${esc(t('theme.' + th))}<span>${settings.theme === th ? '&#10003;' : ''}</span></div></button>`).join('') + '</div>' + (window.Shared ? Shared.layoutHeading() : ''),
    editing: `<h3>${esc(t('set.editing'))}</h3>${sw('snap', t('set.snap'))}
      <h3>${esc(t('set.imageSec'))} <span class="val">${settings.imageSec} s</span></h3><input type="range" data-range="imageSec" min="1" max="30" step="1" value="${settings.imageSec}">
      <h3>${esc(t('set.titleSec'))} <span class="val">${settings.titleSec} s</span></h3><input type="range" data-range="titleSec" min="1" max="30" step="1" value="${settings.titleSec}">
      <h3>${esc(t('set.forget'))}</h3><p><button class="btn-sm" data-pref="forgetRecent">${esc(t('set.forgetRecent'))}</button></p>`,
    keys: '<div id="keysBox"></div>'
  };
  const sections = ['general', 'appearance', 'editing', 'keys'];
  $('#modalTitle').textContent = t('set.title');
  $('#modalBody').innerHTML = `<div class="prefs"><nav>${sections.map(k =>
    `<button data-sec="${k}" class="${k === prefsSection ? 'active' : ''}">${esc(t('set.' + k))}</button>`).join('')}</nav><section>${body[prefsSection]}</section></div>`;
  if (prefsSection === 'keys') Shortcuts.editor($('#keysBox'), {MENUS, keys: settings.keys || {}, t, fmtKey, comboOf, label: a => t('a.' + a),
    onChange: keys => { settings.keys = keys; applySettings(); }});
  $('#modalFoot').innerHTML = `<button class="btn-sm" data-pref="reset">${esc(t('set.reset'))}</button><span class="flex"></span>
    <button class="btn-sm primary" data-pref="done">${esc(t('set.done'))}</button>`;
}
$('#modal').addEventListener('click', e => {
  if (!settingsOpen) return;
  const el = e.target.closest('[data-sec],[data-theme-pick],[data-pref]'); if (!el) return;
  if (el.dataset.sec) prefsSection = el.dataset.sec;
  else if (el.dataset.themePick) settings.theme = el.dataset.themePick;
  else if (el.dataset.pref === 'done') return closeModal();
  else if (el.dataset.pref === 'reset') { const keep = {theme: settings.theme, lang: settings.lang}; settings = {...DEF, ...keep}; toast(t('set.resetDone')); }
  else if (el.dataset.pref === 'forgetRecent') { recent = []; saveState(); renderEmpty(); toast(t('toast.forgotten')); }
  applySettings(); renderSettings();
});
$('#modal').addEventListener('change', e => {
  if (!settingsOpen) return;
  const el = e.target;
  if (el.dataset.sw) settings[el.dataset.sw] = el.checked;
  else if (el.dataset.sel) settings[el.dataset.sel] = el.value;
  else return;
  applySettings(); renderSettings();
});
$('#modal').addEventListener('input', e => {
  if (!settingsOpen || !e.target.dataset.range) return;
  settings[e.target.dataset.range] = +e.target.value; saveState();
  e.target.previousElementSibling.querySelector('.val').textContent = e.target.value + ' s';
});
function setLang(l) { settings.lang = l; applySettings(); }
function setTheme(th) { settings.theme = th; applySettings(); }
function applyLanguage() {
  document.documentElement.lang = lang;
  $$('[data-i18n]').forEach(n => n.textContent = t(n.dataset.i18n));
  buildMenubar(); buildToolbars(); buildTransport();
  if (booted) { renderTimeline(); renderDock(); renderEmpty(); updateStatus(); updateTitle(); preview.redraw(); }
}
let appliedKeys = null;
function applySettings() {
  if (window.AutoHide) AutoHide.set(settings.autoHide);
  if (!THEMES.includes(settings.theme)) settings.theme = 'dark';
  if (window.Shared) Shared.push({theme: settings.theme, lang: settings.lang});
  document.documentElement.dataset.theme = settings.theme;
  if (JSON.stringify(settings.keys || {}) !== appliedKeys) { appliedKeys = JSON.stringify(settings.keys || {}); Shortcuts.apply(MENUS, settings.keys || {}); buildKeymap(); buildToolbars(); buildTransport(); }
  const nl = effectiveLang();
  if (nl !== lang) { lang = nl; applyLanguage(); }
  $('#dock').classList.toggle('hidden', !settings.dock);
  $$('[data-act="togglePanels"]').forEach(b => b.classList.toggle('active', settings.dock));
  $$('[data-act="toggleSnap"]').forEach(b => b.classList.toggle('active', settings.snap));
  preview.setVolume(settings.volume);
  applyTlHeight();
  if (booted) { renderDock(); updateStatus(); }
  saveState();
}

/* ================= Keyboard ================= */
function comboOf(e) {
  let k = e.key;
  if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (e.code === 'Comma') k = ',';
  else if (e.code === 'Period') k = '.';
  else if (e.code === 'Backslash' || e.code === 'IntlBackslash') k = '\\';
  else if (e.code === 'Space') k = 'Space';
  else if (e.code === 'Minus' || e.code === 'NumpadSubtract') k = '-';
  else if (e.code === 'Equal') k = '=';
  else if (e.code === 'NumpadAdd') k = '+';
  else if (k.length === 1) k = k.toUpperCase();
  return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + k;
}
const typing = () => { const a = document.activeElement; return a && ((a.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes(a.type)) || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); };
window.addEventListener('keydown', e => {
  if (window.Shortcuts && Shortcuts.recording) return;
  if (e.key === 'Escape') {
    if ($('#modal').classList.contains('show')) closeModal();
    else if (menuOpen) closeMenus();
    else if (full) setFull(false);
    else if (tool !== 'select') setTool('select');
    else if (sel.size) { sel.clear(); renderSel(); }
    return;
  }
  if (e.ctrlKey && e.altKey) return;
  if ($('#modal').classList.contains('show') || typing()) return;
  const combo = comboOf(e);
  if (combo === 'Ctrl+C' && String(getSelection())) return;
  const acts = KEYMAP[combo], act = acts && acts.find(allowed);
  if (acts && (act || !['Enter', 'Ctrl+C'].includes(combo))) { e.preventDefault(); e.stopPropagation(); if (act) run(act); }
}, true);

/* ================= Drag & drop from outside, right-click ================= */
if (window.__TAURI__) window.__TAURI__.event.listen('tauri://drag-drop', async ev => {
  const p = (ev.payload && ev.payload.paths) || [];
  if (!p.length) return;
  const pos = ev.payload.position || {}, el = pos.x != null ? document.elementFromPoint(pos.x / devicePixelRatio, pos.y / devicePixelRatio) : null;
  // Dropped on the timeline or the preview: straight onto the timeline at the playhead; elsewhere: into the media panel.
  const place = !!(el && el.closest('#timeline, #screen'));
  dropped(await invoke('open_paths', {paths: p}), place);
});
{
  const item = (act, label) => ({id: act, label: label || t('a.' + act), accel: keyOf(act) || null, enabled: allowed(act)});
  let ctxTarget = null;
  Native.setProvider(e => {
    const clipEl = e.target.closest('.clip');
    if (clipEl) {
      if (!sel.has(clipEl.dataset.id)) { sel = new Set([clipEl.dataset.id]); renderSel(); }
      return [item('splitPlayhead'), null, item('cutClips'), item('copyClips'), item('pasteClips'), item('duplicate'), null, item('muteClip'), item('deleteClips'), item('rippleDelete'), null, {id: 'props', label: t('a.props')}];
    }
    const lane = e.target.closest('.tl-lane');
    if (lane) { ctxTarget = {track: lane.closest('.tl-row').dataset.track, at: timeAt(e.clientX)}; return [{id: 'closeGap', label: t('a.closeGap')}, item('pasteClips'), item('addTitle'), null, item('addVideoTrack'), item('addAudioTrack')]; }
    const th = e.target.closest('.tl-th');
    if (th) {
      ctxTarget = {track: th.closest('.tl-row').dataset.track};
      const tr = project.tracks.find(x => x.id === ctxTarget.track);
      const can = tr && !tr.clips.length && project.tracks.filter(x => x.kind === tr.kind).length > 1;
      return [item('addVideoTrack'), item('addAudioTrack'), null, {id: 'removeTrack', label: t('a.removeTrack'), enabled: !!can}];
    }
    const bin = e.target.closest('[data-media]');
    if (bin) {
      ctxTarget = {media: bin.dataset.media};
      const m = TL.mediaOf(project, ctxTarget.media), used = project.tracks.some(tr => tr.clips.some(c => c.media === ctxTarget.media));
      return [{id: 'addMedia', label: t('a.addAtPlayhead'), enabled: !!m && !offline.has(m.id)}, {id: 'relinkMedia', label: t('a.relink')}, {id: 'revealMedia', label: t('a.reveal'), enabled: !!m && !offline.has(m.id)}, null,
        {id: 'dropMedia', label: t('a.dropMedia'), enabled: !used}];
    }
    if (e.target.closest('#screen')) return [item('playPause'), item('fullscreen'), null, item('importMedia'), item('addTitle')];
    return null;
  });
  Native.setHandler(id => {
    const c = ctxTarget || {};
    if (id === 'props') { settings.dockTab = 'props'; settings.dock = true; applySettings(); }
    else if (id === 'closeGap') edit(() => TL.closeGap(project, c.track, c.at));
    else if (id === 'removeTrack') edit(() => TL.removeTrack(project, c.track));
    else if (id === 'addMedia') { const m = TL.mediaOf(project, c.media); if (m) addAtPlayhead(m); }
    else if (id === 'relinkMedia') relink(c.media);
    else if (id === 'revealMedia') { const m = TL.mediaOf(project, c.media); if (m) invoke('reveal', {path: m.path}).catch(() => {}); }
    else if (id === 'dropMedia') edit(() => { const n = project.media.length; project.media = project.media.filter(m => m.id !== c.media); return project.media.length !== n; });
    else run(id);
  });
}
window.addEventListener('resize', () => { if (booted) { renderTimeline(); preview.redraw(); } });

/* Test hook (like the other apps' __md / __dt / __vw). */
window.__vd = {A, run, TL, get project() { return project; }, set project(p) { project = p; refresh(); }, get sel() { return sel; }, set sel(s) { sel = new Set(s); renderSel(); },
  preview, settings: () => settings, addMediaInfos, loadProject, refresh, get dirty() { return dirty; }, get filePath() { return filePath; }, hist, offline: () => offline};

/* ================= Boot ================= */
(async function boot() {
  await loadTexts();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE)); } catch (e) {}
  if (saved) { if (saved.settings) settings = {...DEF, ...saved.settings}; recent = saved.recent || []; }
  // Theme, layout and language shared by all Studio apps (shared.js); the shared values win over this app's own.
  if (window.Shared) await Shared.init({app: 'vd', apply: sh => {
    if (sh.theme) settings.theme = sh.theme;
    if (sh.lang) settings.lang = sh.lang;
    if (booted) applySettings();
  }});
  lang = effectiveLang();
  applyLanguage();
  booted = true;
  applySettings();
  // The last session comes back (also unsaved work); its media folders are opened for the preview again.
  let session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION)); } catch (e) {}
  if (settings.restore && session && session.text) {
    try {
      project = TL.load(session.text); filePath = session.path || null; dirty = !!session.dirty;
      if (invoke && project.media.length) {
        const d = await invoke('open_paths', {paths: project.media.map(m => m.path)}).catch(() => ({media: []}));
        const there = new Set(d.media.map(i => i.path));
        offline = new Set(project.media.filter(m => !there.has(m.path)).map(m => m.id));
      }
    } catch (e) { project = TL.create(); filePath = null; dirty = false; }
  }
  updateTitle(); refresh(); buildTransport();
  if (invoke) {
    window.__TAURI__.window.getCurrentWindow().onCloseRequested(async ev => {
      saveState(); clearTimeout(sessionT);
      try { localStorage.setItem(SESSION, JSON.stringify({text: TL.save(project), path: filePath, dirty})); } catch (e) {}
      if (expRunning != null) { ev.preventDefault(); return toast(t('toast.exportRunning')); }
      if (dirty && !pristine() && !await ask(t('confirm.quit'), t('confirm.quitOk'))) ev.preventDefault();
    });
    const first = await invoke('initial_files').catch(() => null);
    if (first) { if (first.projects.length) openProject(first.projects[0]); else if (first.media.length) addMediaInfos(first.media); }
    window.__TAURI__.event.listen('open-files', e => dropped(e.payload, false));
  }
})();
