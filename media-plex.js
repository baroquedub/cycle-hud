/* Cycle Hub — media-plex.js
 * Plex source. Now-playing from your Plex Media Server's /status/sessions;
 * transport controls relayed through the server's Plex Companion endpoint
 * (/player/playback/*) to the Plexamp player. Credentials {url, token}
 * arrive from pair.html and live in localStorage 'ch.plex'.
 *
 * All X-Plex-* values go in the query string (never headers) so the browser
 * never needs a CORS preflight.
 */
(() => {
  'use strict';
  const CH = window.CH;

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  const Plex = {
    key: 'plex',
    label: 'Plex',
    glyph: 'P',
    creds: null,
    clientId: null,
    cmdId: 0,
    player: null,          // machineIdentifier of the player we last saw
    playerName: '',
    canControl: true,
    lastError: '',

    start(creds) {
      Plex.creds = creds || null;
      Plex.lastError = '';
      Plex.canControl = CH.store.get('plexControl', true);
      if (!Plex.clientId) {
        Plex.clientId = CH.store.get('plexClientId', null);
        if (!Plex.clientId) { Plex.clientId = uuid(); CH.store.set('plexClientId', Plex.clientId); }
      }
      return !!(creds && creds.url && creds.token);
    },
    stop() { Plex.creds = null; Plex.player = null; },

    url(path, extra) {
      const base = String(Plex.creds.url).replace(/\/+$/, '');
      const u = new URL(base + path);
      u.searchParams.set('X-Plex-Token', Plex.creds.token);
      if (extra) for (const k of Object.keys(extra)) u.searchParams.set(k, extra[k]);
      return u.toString();
    },

    async poll() {
      if (!Plex.creds) return { state: 'auth' };
      try {
        const res = await fetch(Plex.url('/status/sessions'), { headers: { Accept: 'application/json' } });
        if (res.status === 401) { Plex.lastError = 'token rejected'; return { state: 'auth' }; }
        if (!res.ok) { Plex.lastError = 'HTTP ' + res.status; return { state: 'offline' }; }
        const j = await res.json();
        const md = (j && j.MediaContainer && j.MediaContainer.Metadata) || [];
        const tracks = md.filter((m) => m.type === 'track');
        if (!tracks.length) return { state: 'idle' };
        const t = tracks.find((m) => m.Player && /plexamp/i.test(m.Player.product || '')) || tracks[0];
        if (t.Player) { Plex.player = t.Player.machineIdentifier || Plex.player; Plex.playerName = t.Player.title || t.Player.product || ''; }
        return {
          state: 'ok',
          playing: !!(t.Player && t.Player.state === 'playing'),
          title: t.title || '',
          artist: t.grandparentTitle || t.originalTitle || '',
        };
      } catch (e) {
        Plex.lastError = (e && e.message) || 'error';   // a TypeError here usually means CORS/unreachable
        return { state: 'offline' };
      }
    },

    async cmd(name) {
      if (!Plex.creds) throw { auth: true };
      if (!Plex.player) throw { code: 404 };
      Plex.cmdId++;
      const u = Plex.url('/player/playback/' + name, {
        type: 'music',
        commandID: String(Plex.cmdId),
        'X-Plex-Target-Client-Identifier': Plex.player,
        'X-Plex-Client-Identifier': Plex.clientId,
      });
      const res = await fetch(u);
      if (!res.ok) throw { code: res.status };
    },
    play() { return Plex.cmd('play'); },
    pause() { return Plex.cmd('pause'); },
    next() { return Plex.cmd('skipNext'); },
    prev() { return Plex.cmd('skipPrevious'); },

    describe(err) {
      if (!err) return 'Plex error';
      if (err.auth) return 'Plex: pair on phone';
      if (err.code === 404) return 'Plex: no player found';
      return 'Plex: control unavailable';
    },

    statusText() {
      if (!Plex.creds) return 'not paired';
      return 'paired · ' + (Plex.playerName ? 'player ' + Plex.playerName : 'no player yet') + (Plex.canControl ? '' : ' · control off') + (Plex.lastError ? ' · ' + Plex.lastError : '');
    },
  };
  CH.PlexSource = Plex;
})();
