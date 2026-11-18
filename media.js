/* CycleHUD — media.js
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * The mini player bar: polls the chosen source, shows title/artist with a
 * marquee only when the title overflows, and sends transport commands.
 */
(() => {
  'use strict';
  const CH = window.CH;
  const CFG = CH.CONFIG;
  const $ = (id) => document.getElementById(id);

  const Media = {
    sourceKey: 'off',    // 'auto' | 'spotify' | 'plex' | 'off'
    source: null,        // the source being shown and controlled
    other: null,         // in auto: the other paired source, checked when this one isn't playing
    pollId: 0,           // bumps whenever a poll result would be stale (source change, page woke up)
    visibleAt: 0,
    timer: null,
    inflight: false,
    inflightAt: 0,
    backoff: CFG.MEDIA_POLL_MS,
    last: { state: 'idle', playing: false, title: '', artist: '', pos: null, dur: null, posAt: 0 },
    lastPollAt: 0,
    lastTitle: null,
    lastProg: -1,        // fraction last drawn on the progress line (-1 = hidden)
    onState: null,       // app hook (so the menu's Play/Pause row can follow)
    toast: (msg) => console.log('[media]', msg),

    sources() { return { spotify: CH.SpotifySource, plex: CH.PlexSource }; },

    visible() { return Media.sourceKey !== 'off'; },

    setSource(key) {
      Media.stopPolling();
      const all = Media.sources();
      for (const k of Object.keys(all)) all[k].stop();
      Media.sourceKey = key;
      Media.source = null; Media.other = null;
      Media.pollId++; Media.inflight = false;
      Media.last = { state: 'idle', playing: false, title: '', artist: '', pos: null, dur: null, posAt: 0 };
      Media.lastTitle = null;
      const bar = $('media-bar');
      if (key === 'off') { bar.hidden = true; Media.render(); return; }
      bar.hidden = false;
      const keys = key === 'auto' ? ['spotify', 'plex'] : [key];
      const ready = keys.filter((k) => all[k].start(CH.store.get(k, null)));   // the paired ones
      if (!ready.length) { Media.source = all[keys[0]]; Media.last = { state: 'auth', playing: false, title: '', artist: '', pos: null, dur: null, posAt: 0 }; Media.render(); return; }
      Media.source = all[ready[0]];
      Media.other = ready.length > 1 ? all[ready[1]] : null;
      Media.backoff = CFG.MEDIA_POLL_MS;
      Media.schedule(0);
    },

    schedule(ms) {
      clearTimeout(Media.timer);
      if (!Media.source) return;
      Media.timer = setTimeout(Media.tick, ms);
    },
    stopPolling() { clearTimeout(Media.timer); Media.timer = null; },

    async tick() {
      if (!Media.source) return;
      if (Media.inflight) { if (Date.now() - Media.inflightAt < 30000) return; Media.inflight = false; }   // a stuck poll must not block the next
      if (document.visibilityState === 'hidden') { Media.schedule(5000); return; }
      const id = ++Media.pollId;
      Media.inflight = true; Media.inflightAt = Date.now();
      let r, src = Media.source;
      try { r = await src.poll(); } catch (e) { r = { state: 'offline' }; }
      // Auto: if what we're showing isn't playing, see whether the other service is
      if (id === Media.pollId && Media.other && !(r.state === 'ok' && r.playing)) {
        let ro = null;
        try { ro = await Media.other.poll(); } catch (e) { ro = null; }
        if (id === Media.pollId && ro && ro.state === 'ok' && ro.playing) {
          const o = Media.other; Media.other = Media.source; Media.source = o; src = o; r = ro;
          Media.lastTitle = null;
        }
      }
      if (id !== Media.pollId) return;          // superseded: the source changed or the page woke up
      Media.inflight = false;
      Media.lastPollAt = Date.now();
      // A timeout that fires just after the page became visible is the timer
      // the browser suspended while the display was off, not the network.
      if (r.state === 'offline' && src.lastError === 'timeout' && Date.now() - Media.visibleAt < CFG.MEDIA_FETCH_TIMEOUT_MS) { Media.schedule(0); return; }
      Media.apply(r);
      let next = CFG.MEDIA_POLL_MS;
      if (r.state === 'offline') { Media.backoff = Math.min(20000, Media.backoff * 2); next = Media.backoff; }
      else if (r.state === 'ratelimit') next = r.retryAfterMs || 10000;
      else if (r.state === 'auth') { Media.render(); return; }     // stop until re-paired
      else Media.backoff = CFG.MEDIA_POLL_MS;
      Media.schedule(next);
    },

    apply(r) {
      const prev = Media.last;
      const keep = r.state === 'offline' || r.state === 'ratelimit';   // nothing new known: show what we had
      const ms = (v) => Number.isFinite(v) && v >= 0 ? v : null;
      Media.last = {
        state: r.state,
        playing: r.state === 'ok' ? !!r.playing : keep ? prev.playing : false,
        title: r.state === 'ok' ? r.title : keep ? prev.title : '',
        artist: r.state === 'ok' ? r.artist : keep ? prev.artist : '',
        // position in the track (ms) at the moment posAt, and the track length
        pos: r.state === 'ok' ? ms(r.pos) : keep ? prev.pos : null,
        dur: r.state === 'ok' ? ms(r.dur) : keep ? prev.dur : null,
        posAt: r.state === 'ok' ? Date.now() : keep ? prev.posAt : 0,
      };
      Media.render();
      if (Media.onState) Media.onState(Media.last);
    },

    // How far through the current track we are (0..1), extrapolated from the
    // last poll while playing; null when there is nothing to show. Kept up
    // through an offline / rate-limited spell (the bar keeps the track then
    // too) so a network blip doesn't make the line flicker; the next good
    // poll corrects it.
    progress() {
      const L = Media.last;
      if (!(L.state === 'ok' || L.state === 'offline' || L.state === 'ratelimit') || !(L.dur > 0) || L.pos == null) return null;
      const p = L.pos + (L.playing ? Date.now() - L.posAt : 0);
      return Math.min(1, Math.max(0, p / L.dur));
    },

    // The thin line along the bottom of the bar. Called on every render and
    // once a second from app.js so it creeps between polls.
    renderProgress() {
      const box = $('media-prog'), fill = $('media-prog-fill');
      const f = $('media-bar').hidden ? null : Media.progress();
      if (f == null) { box.hidden = true; Media.lastProg = -1; return; }
      box.hidden = false;
      // going backwards (new track, a seek) must snap, not animate over a second
      fill.classList.toggle('snap', f < Media.lastProg);
      fill.style.width = (f * 100).toFixed(2) + '%';
      Media.lastProg = f;
    },

    render() {
      const bar = $('media-bar');
      Media.renderProgress();
      if (bar.hidden) return;
      const L = Media.last, src = Media.source;
      const title = $('media-title'), artist = $('media-artist'), glyph = $('media-glyph');
      let t = L.title, a = L.artist;
      if (L.state === 'idle' && !t) { t = 'Nothing playing'; a = 'Start it on your phone'; }
      else if (L.state === 'auth') { t = src ? src.label + ' not connected' : 'Not connected'; a = Media.connectHint(src); }
      else if (L.state === 'offline') { a = (a ? a + ' · ' : '') + 'Reconnecting…' + (src && src.lastError ? ' (' + src.lastError + ')' : ''); }
      if (title.textContent !== t) { title.textContent = t; Media.marquee(title, t); }
      artist.textContent = a;
      glyph.textContent = L.playing ? '❚❚' : '▶';      // play state, not the source
      title.classList.toggle('paused', !L.playing || document.visibilityState === 'hidden');
      bar.classList.toggle('dim', L.state !== 'ok');
    },

    // The bar changes width between the map and Glance views.
    remeasure() { const t = $('media-title'); Media.marquee(t, t.textContent); },

    // Animate only when the text overflows its box; otherwise sit still.
    marquee(el, text) {
      el.classList.remove('marquee');
      el.style.removeProperty('--mq-x'); el.style.removeProperty('--mq-t');
      if (!text) return;
      const box = el.parentElement;
      const over = el.scrollWidth - box.clientWidth;
      if (over > 4) {
        el.style.setProperty('--mq-x', (-over - 8) + 'px');
        el.style.setProperty('--mq-t', Math.max(4, (over + 8) / 35).toFixed(1) + 's');
        el.classList.add('marquee');
      }
    },

    async act(name) {
      const src = Media.source;
      if (!src) { Media.toast('Media is off'); return; }
      if (Media.last.state === 'auth') { Media.toast(src.label + ' not connected — ' + Media.connectHint(src)); return; }
      if (!src.canControl) { Media.toast(src.label + ': control unavailable'); return; }
      if (name === 'toggle') name = Media.last.playing ? 'pause' : 'play';
      // optimistic
      if (name === 'play') Media.last.playing = true;
      if (name === 'pause') Media.last.playing = false;
      Media.render();
      if (Media.onState) Media.onState(Media.last);
      try {
        await src[name]();
      } catch (e) {
        Media.toast(src.describe(e));
      }
      Media.schedule(600);
    },

    // visibility: pause/resume the poll and marquee
    onVisibility() {
      if (document.visibilityState === 'visible') {
        // whatever was in flight when the display went off is not coming back: start afresh
        Media.visibleAt = Date.now(); Media.pollId++; Media.inflight = false;
        if (Media.source && Media.last.state !== 'auth') { Media.backoff = CFG.MEDIA_POLL_MS; Media.schedule(0); }
      }
      Media.render();
    },

    // What to do next when a source has no credentials: pair the phone first, then press the
    // source's button on the pair page (pairing alone only opens the channel).
    connectHint(src) {
      const paired = CH.Relay && CH.Relay.lastDeliveredAt > 0;
      const btn = src && src.label === 'Plex' ? 'Send to glasses' : 'Connect Spotify';
      return paired ? 'On the pair page press ' + btn : 'Menu → Pair phone, then ' + btn;
    },
    statusText() {
      if (Media.sourceKey === 'off') return 'off';
      const s = Media.source ? Media.source.statusText() : '';
      const age = Media.lastPollAt ? Math.round((Date.now() - Media.lastPollAt) / 1000) + ' s ago' : 'never';
      return Media.sourceKey + (Media.other && Media.source ? ' (' + Media.source.key + ')' : '') + ' · ' + Media.last.state + ' · polled ' + age + (s ? ' · ' + s : '');
    },
  };
  document.addEventListener('visibilitychange', () => Media.onVisibility());
  CH.Media = Media;
})();
