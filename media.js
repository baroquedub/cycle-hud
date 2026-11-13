/* Cycle Hub — media.js
 * The mini player bar: polls the chosen source, shows title/artist with a
 * marquee only when the title overflows, and sends transport commands.
 */
(() => {
  'use strict';
  const CH = window.CH;
  const CFG = CH.CONFIG;
  const $ = (id) => document.getElementById(id);

  const Media = {
    sourceKey: 'off',
    source: null,
    timer: null,
    inflight: false,
    backoff: CFG.MEDIA_POLL_MS,
    last: { state: 'idle', playing: false, title: '', artist: '' },
    lastPollAt: 0,
    lastTitle: null,
    onState: null,       // app hook (so the menu's Play/Pause row can follow)
    toast: (msg) => console.log('[media]', msg),

    sources() { return { spotify: CH.SpotifySource, plex: CH.PlexSource }; },

    visible() { return Media.sourceKey !== 'off'; },

    setSource(key) {
      Media.stopPolling();
      if (Media.source) Media.source.stop();
      Media.sourceKey = key;
      Media.source = null;
      Media.last = { state: 'idle', playing: false, title: '', artist: '' };
      Media.lastTitle = null;
      const bar = $('media-bar');
      if (key === 'off') { bar.hidden = true; Media.render(); return; }
      const src = Media.sources()[key];
      Media.source = src;
      bar.hidden = false;
      const creds = CH.store.get(key, null);
      if (!src.start(creds)) { Media.last = { state: 'auth', playing: false, title: '', artist: '' }; Media.render(); return; }
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
      if (!Media.source || Media.inflight) return;
      if (document.visibilityState === 'hidden') { Media.schedule(5000); return; }
      Media.inflight = true;
      let r;
      try { r = await Media.source.poll(); } catch (e) { r = { state: 'offline' }; }
      Media.inflight = false;
      Media.lastPollAt = Date.now();
      Media.apply(r);
      let next = CFG.MEDIA_POLL_MS;
      if (r.state === 'offline') { Media.backoff = Math.min(60000, Media.backoff * 2); next = Media.backoff; }
      else if (r.state === 'ratelimit') next = r.retryAfterMs || 10000;
      else if (r.state === 'auth') { Media.render(); return; }     // stop until re-paired
      else Media.backoff = CFG.MEDIA_POLL_MS;
      Media.schedule(next);
    },

    apply(r) {
      const prev = Media.last;
      Media.last = {
        state: r.state,
        playing: r.state === 'ok' ? !!r.playing : (r.state === 'ratelimit' || r.state === 'offline') ? prev.playing : false,
        title: r.state === 'ok' ? r.title : (r.state === 'offline' || r.state === 'ratelimit') ? prev.title : '',
        artist: r.state === 'ok' ? r.artist : (r.state === 'offline' || r.state === 'ratelimit') ? prev.artist : '',
      };
      Media.render();
      if (Media.onState) Media.onState(Media.last);
    },

    render() {
      const bar = $('media-bar');
      if (bar.hidden) return;
      const L = Media.last, src = Media.source;
      const title = $('media-title'), artist = $('media-artist'), glyph = $('media-glyph');
      let t = L.title, a = L.artist;
      if (L.state === 'idle' && !t) { t = 'Nothing playing'; a = 'Start it on your phone'; }
      else if (L.state === 'auth') { t = src ? src.label + ' not paired' : 'Not paired'; a = 'Menu → Pair phone'; }
      else if (L.state === 'offline') { a = (a ? a + ' · ' : '') + 'Reconnecting…'; }
      if (title.textContent !== t) { title.textContent = t; Media.marquee(title, t); }
      artist.textContent = a;
      glyph.textContent = L.playing ? '❚❚' : '▶';      // play state, not the source
      title.classList.toggle('paused', !L.playing || document.visibilityState === 'hidden');
      bar.classList.toggle('dim', L.state !== 'ok');
    },

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
      if (Media.last.state === 'auth') { Media.toast(src.label + ' not paired — Menu → Pair phone'); return; }
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
      if (document.visibilityState === 'visible') { if (Media.source && Media.last.state !== 'auth') Media.schedule(0); }
      Media.render();
    },

    statusText() {
      if (Media.sourceKey === 'off') return 'off';
      const s = Media.source ? Media.source.statusText() : '';
      const age = Media.lastPollAt ? Math.round((Date.now() - Media.lastPollAt) / 1000) + ' s ago' : 'never';
      return Media.sourceKey + ' · ' + Media.last.state + ' · polled ' + age + (s ? ' · ' + s : '');
    },
  };
  document.addEventListener('visibilitychange', () => Media.onVisibility());
  CH.Media = Media;
})();
