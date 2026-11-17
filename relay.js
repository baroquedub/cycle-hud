/* Cycle Hub — relay.js
 * pair.html on your phone publishes to a private ntfy.sh topic named after
 * your pairing code; the glasses listen on the same topic. Adapted from
 * Waypoint. Payloads: {ping}, {spotify:{...}}, {plex:{...}}. The glasses
 * publish ride logs the other way as attachments (Relay.upload).
 */
(() => {
  'use strict';
  const CH = window.CH;
  const CFG = CH.CONFIG;

  const Relay = {
    base: String(CFG.RELAY_URL || 'https://ntfy.sh').replace(/\/+$/, ''),
    code: null, es: null, connected: false, seen: [],
    sinceId: null, pollTimer: null, pollFast: false, lastDeliveredAt: 0,
    onMessage: null,   // app hook (payload)
    onStatus: null,    // app hook (connected)

    newCode() {
      const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
      const r = new Uint32Array(8);
      if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(r);
      else for (let i = 0; i < 8; i++) r[i] = Math.floor(Math.random() * 1e9);
      return Array.from(r, (n) => A[n % A.length]).join('');
    },
    topic() { return CFG.RELAY_PREFIX + Relay.code.toLowerCase(); },
    pretty() { return Relay.code ? Relay.code.slice(0, 4) + '-' + Relay.code.slice(4) : ''; },

    start(reset = false) {
      const store = CH.store;
      Relay.seen = store.get('relaySeen', []);
      if (reset || !store.get('pairCode', null)) store.set('pairCode', Relay.newCode());
      Relay.code = store.get('pairCode', null);
      if (Relay.es) { Relay.es.close(); Relay.es = null; }
      Relay.sinceId = null;
      Relay.setStatus(false);
      // Anything sent while the app was closed (last 15 min)? Then keep
      // polling as a fallback in case the live stream is silent on this browser.
      Relay.poll('15m');
      Relay.schedulePoll();
      if (!('EventSource' in window)) return;
      try {
        const es = new EventSource(`${Relay.base}/${Relay.topic()}/sse`);
        es.onopen = () => Relay.setStatus(true);
        es.onerror = () => Relay.setStatus(false);
        es.onmessage = (e) => {
          let m; try { m = JSON.parse(e.data); } catch { return; }
          Relay.setStatus(true);
          if (m.event !== 'message' || Relay.seen.includes(m.id)) return;
          Relay.markSeen(m.id);
          Relay.deliver(m);
        };
        Relay.es = es;
      } catch (e) { console.warn('relay', e); }
    },

    // Fetch cached messages newer than the last one we saw.
    poll(since) {
      if (!Relay.code) return Promise.resolve();
      const s = since || Relay.sinceId || '15m';
      return fetch(`${Relay.base}/${Relay.topic()}/json?poll=1&since=${encodeURIComponent(s)}`, { cache: 'no-store' })
        .then((r) => r.text()).then((txt) => {
          const msgs = txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter((m) => m && m.event === 'message');
          if (msgs.length) Relay.sinceId = msgs[msgs.length - 1].id;
          const fresh = msgs.filter((m) => !Relay.seen.includes(m.id));
          fresh.forEach((m) => Relay.markSeen(m.id));
          fresh.forEach((m) => Relay.deliver(m));
        }).catch(() => {});
    },

    // Poll every 4 s while the Pair screen is open, every 30 s otherwise.
    schedulePoll() {
      clearTimeout(Relay.pollTimer);
      Relay.pollTimer = setTimeout(async () => {
        if (document.visibilityState !== 'hidden') await Relay.poll();
        Relay.schedulePoll();
      }, Relay.pollFast ? 4000 : 30000);
    },
    setFastPoll(on) { Relay.pollFast = on; Relay.schedulePoll(); if (on) Relay.poll(); },

    markSeen(id) { Relay.seen = [id, ...Relay.seen].slice(0, 30); CH.store.set('relaySeen', Relay.seen); },

    setStatus(on) {
      Relay.connected = on;
      if (Relay.onStatus) Relay.onStatus(on);
    },

    // Publish a file to our topic as an ntfy attachment (kept 3 h), so the
    // phone can download it from pair.html. Resolves to the attachment URL.
    async upload(name, text) {
      const res = await CH.fetchTimeout(`${Relay.base}/${Relay.topic()}`, {
        method: 'PUT', body: text, headers: { Filename: name, 'Content-Type': 'application/json' },
      }, 30000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (j && j.id) Relay.markSeen(j.id);         // it's our own message: don't try to read it back
      return (j && j.attachment && j.attachment.url) || '';
    },

    deliver(m) {
      if (m.time && Date.now() / 1000 - m.time > 15 * 60) return;
      let p; try { p = JSON.parse(m.message); } catch { return; }
      if (!p || typeof p !== 'object') return;
      Relay.lastDeliveredAt = Date.now();
      if (Relay.onMessage) Relay.onMessage(p);
    },
  };
  CH.Relay = Relay;
})();
