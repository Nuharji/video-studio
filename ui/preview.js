/* Video Studio: the preview. Plays the timeline into a canvas: every clip on screen gets its own <video> / <audio> element
   (two clips of the same file can run at once), the pictures are drawn from the bottom track up, letterboxed like the
   export, with opacity and fades; titles are drawn here and — the same drawing — handed to the export as pictures.
   The clock is the computer's; elements that drift more than a quarter second are put back in place.

   Preview.create({canvas, host, url, onTime, onEnd}) → {setProject, play, pause, toggle, seek, redraw, time, playing,
   setVolume, dispose}. Preview.drawTitle(ctx, clip, w, h) draws one title. */
(function (root) {
  'use strict';
  const TL = root.TL;

  /* A title: lines of text, a size in % of the frame height, at the top / in the middle / at the bottom, maybe on a box. */
  function drawTitle(ctx, c, w, h) {
    const lines = String(c.text || '').split('\n');
    const size = Math.max(4, (c.size || 8) / 100 * h), lh = size * 1.22;
    ctx.save();
    ctx.font = `${c.bold === false ? 500 : 700} ${size}px -apple-system, "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const block = lh * lines.length;
    const top = c.pos === 'top' ? h * .08 : c.pos === 'center' ? (h - block) / 2 : h * .92 - block;
    if (c.box) {
      const wMax = Math.max(...lines.map(l => ctx.measureText(l).width)), pad = size * .45;
      ctx.fillStyle = 'rgba(0,0,0,.62)';
      const x = (w - wMax) / 2 - pad, y = top - pad * .6, bw = wMax + pad * 2, bh = block + pad * 1.2, r = size * .25;
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + bw, y, x + bw, y + bh, r); ctx.arcTo(x + bw, y + bh, x, y + bh, r);
      ctx.arcTo(x, y + bh, x, y, r); ctx.arcTo(x, y, x + bw, y, r); ctx.closePath(); ctx.fill();
    } else {
      ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = size * .18; ctx.shadowOffsetY = size * .04;
    }
    ctx.fillStyle = c.color || '#fff';
    lines.forEach((l, i) => ctx.fillText(l, w / 2, top + lh * (i + .5)));
    ctx.restore();
  }

  /* A title over the whole frame on a transparent picture, as a PNG data URL (for the export). */
  function titlePng(c, w, h) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    drawTitle(cv.getContext('2d'), c, w, h);
    return cv.toDataURL('image/png');
  }

  /* Draws a picture (video frame or photo) into the frame, as large as fits, centered. */
  function drawFit(ctx, src, sw, sh, w, h) {
    if (!sw || !sh) return;
    const s = Math.min(w / sw, h / sh), dw = sw * s, dh = sh * s;
    ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function create({canvas, host, url, onTime = () => {}, onEnd = () => {}}) {
    const ctx = canvas.getContext('2d');
    let p = null, off = new Set(), t = 0, playing = false, clock0 = 0, t0 = 0, raf = 0, volume = 1;
    const els = new Map(), images = new Map();   // clip id → {el, media}; media id → Image

    function size() {
      // At most Full HD inside: enough for the screen, and drawing stays quick.
      const k = Math.min(1, 1920 / p.width, 1080 / p.height);
      const w = Math.round(p.width * k), h = Math.round(p.height * k);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }
    function elFor(c) {
      const m = TL.mediaOf(p, c.media);
      if (!m || off.has(m.id)) return null;
      let e = els.get(c.id);
      if (e && e.path !== m.path) { drop(c.id); e = null; }
      if (!e) {
        const el = document.createElement(c.kind === 'audio' ? 'audio' : 'video');
        el.preload = 'auto'; el.playsInline = true; el.src = url(m.path);
        el.addEventListener('seeked', () => { if (!playing) draw(); });
        el.addEventListener('loadeddata', () => { if (!playing) seekEls(); });
        el.addEventListener('error', () => { e.failed = true; if (!playing) draw(); });
        host.append(el);
        e = {el, path: m.path, failed: false};
        els.set(c.id, e);
      }
      return e;
    }
    function drop(id) {
      const e = els.get(id); if (!e) return;
      e.el.pause(); e.el.removeAttribute('src'); e.el.load(); e.el.remove(); els.delete(id);
    }
    function imageFor(m) {
      let img = images.get(m.id);
      if (!img || img.dataset.path !== m.path) {
        img = new Image(); img.dataset.path = m.path; img.onload = () => { if (!playing) draw(); }; img.src = url(m.path);
        images.set(m.id, img);
      }
      return img;
    }

    /* What can be heard of a clip right now (0..1; the HTML elements can't go louder than 1). */
    const loudness = (tr, c, at) => tr.muted || c.muted ? 0 : Math.min(1, c.volume * TL.fadeAt(c, at) * volume);

    function draw() {
      if (!p) return;
      size();
      const w = canvas.width, h = canvas.height;
      ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      for (const {track, clip: c} of TL.at(p, t)) {
        if (track.kind !== 'video' || track.hidden) continue;
        ctx.globalAlpha = Math.max(0, Math.min(1, c.opacity * TL.fadeAt(c, t)));
        if (c.kind === 'text') { drawTitle(ctx, c, w, h); continue; }
        const m = TL.mediaOf(p, c.media);
        if (!m || off.has(m.id)) { offline(c, w, h); continue; }
        if (c.kind === 'image') { const img = imageFor(m); if (img.complete && img.naturalWidth) drawFit(ctx, img, img.naturalWidth, img.naturalHeight, w, h); continue; }
        const e = els.get(c.id);
        if (e && e.failed) { offline(c, w, h, true); continue; }
        if (e && e.el.readyState >= 2) drawFit(ctx, e.el, e.el.videoWidth, e.el.videoHeight, w, h);
      }
      ctx.globalAlpha = 1;
    }
    /* A missing (or unplayable) file: a striped area with a note, so the gap is seen. */
    function offline(c, w, h, unplayable) {
      ctx.save(); ctx.globalAlpha = 1;
      ctx.fillStyle = '#3a1418'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ff8a8f'; ctx.font = `600 ${Math.round(h / 22)}px system-ui, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText((root.VS_TEXT || (k => k))(unplayable ? 'pv.unplayable' : 'pv.offline'), w / 2, h / 2);
      ctx.restore();
    }

    /* Puts every element where it belongs at time t (paused: for the still picture; also the sound positions). */
    function seekEls() {
      const live = new Set();
      for (const {track, clip: c} of TL.at(p, t)) {
        if (c.kind !== 'video' && c.kind !== 'audio') continue;
        if (track.kind === 'video' && track.hidden && track.muted) continue;
        const e = elFor(c); if (!e) continue;
        live.add(c.id);
        const want = TL.sourceTime(c, t);
        if (Math.abs(e.el.currentTime - want) > 0.5 / p.fps) { try { e.el.currentTime = want; } catch (er) {} }
      }
      return live;
    }

    function tick() {
      raf = 0;
      if (!playing || !p) return;
      t = t0 + (performance.now() - clock0) / 1000;
      const len = TL.total(p);
      if (t >= len) { t = len; pause(); draw(); onTime(t); onEnd(); return; }
      const live = new Set();
      for (const {track, clip: c} of TL.at(p, t)) {
        if (c.kind !== 'video' && c.kind !== 'audio') continue;
        const e = elFor(c); if (!e || e.failed) continue;
        live.add(c.id);
        const want = TL.sourceTime(c, t), el = e.el;
        const vol = loudness(track, c, t);
        el.volume = vol; el.muted = vol <= 0;
        if (el.paused) { try { el.currentTime = want; } catch (er) {} el.play().catch(() => {}); }
        else if (Math.abs(el.currentTime - want) > .25) { try { el.currentTime = want; } catch (er) {} }
      }
      // Elements of clips that are over stop; the next ones (within 1.5 s) get ready at their first frame.
      for (const [id, e] of els) {
        if (live.has(id)) continue;
        if (!e.el.paused) e.el.pause();
        const f = TL.findClip(p, id);
        if (f && f.clip.start > t && f.clip.start - t < 1.5 && Math.abs(e.el.currentTime - f.clip.in) > .1 && !e.primed) { e.primed = true; try { e.el.currentTime = f.clip.in; } catch (er) {} }
        if (f && (f.clip.start <= t || f.clip.start - t >= 1.5)) e.primed = false;
      }
      for (const tr of p.tracks) for (const c of tr.clips) {
        if ((c.kind === 'video' || c.kind === 'audio') && c.start > t && c.start - t < 1.5 && !els.has(c.id)) elFor(c);
      }
      draw();
      onTime(t);
      raf = requestAnimationFrame(tick);
    }

    function play() {
      if (!p || playing) return;
      if (t >= TL.total(p) - 1e-3) t = 0;
      playing = true; clock0 = performance.now(); t0 = t;
      raf = requestAnimationFrame(tick);
    }
    function pause() {
      playing = false;
      if (raf) cancelAnimationFrame(raf); raf = 0;
      for (const e of els.values()) e.el.pause();
    }
    function seek(to) {
      t = Math.max(0, to);
      if (playing) { clock0 = performance.now(); t0 = t; for (const e of els.values()) if (!e.el.paused) e.el.pause(); }
      else { seekEls(); draw(); }
      onTime(t);
    }
    /* A new or changed project: elements of clips that are gone are dropped. */
    function setProject(project, offlineIds) {
      p = project; off = offlineIds || new Set();
      const ids = new Set(p.tracks.flatMap(tr => tr.clips.map(c => c.id)));
      for (const id of [...els.keys()]) if (!ids.has(id)) drop(id);
      if (!playing) { seekEls(); draw(); }
    }
    function dispose() { pause(); for (const id of [...els.keys()]) drop(id); images.clear(); }
    return {
      setProject, play, pause, seek, dispose, redraw: () => { if (!playing) { seekEls(); draw(); } },
      toggle: () => playing ? pause() : play(),
      setVolume(v) { volume = Math.max(0, Math.min(1, v)); },
      get time() { return t; }, get playing() { return playing; }, get elements() { return els; }
    };
  }

  root.Preview = {create, drawTitle, titlePng, drawFit};
})(typeof window !== 'undefined' ? window : globalThis);
