/* CycleHUD — media-plex.js
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
    creds: null,
    clientId: null,
    cmdId: 0,
    player: null,          // machineIdentifier of the player we last saw
    playerName: '',
    canControl: true,
    lastError: '',
    lastControl: '',       // what the last transport command came back with (for Status)

    start(creds) {
      Plex.creds = creds || null;
      Plex.lastError = ''; Plex.lastControl = '';
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
        const res = await CH.fetchTimeout(Plex.url('/status/sessions'), { headers: { Accept: 'application/json' } }, CH.CONFIG.MEDIA_FETCH_TIMEOUT_MS);
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
          pos: t.viewOffset, dur: t.duration,      // ms into the track / track length
        };
      } catch (e) {
        Plex.lastError = (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'error';   // a TypeError here usually means CORS/unreachable
        return { state: 'offline' };
      }
    },

    // The server's companion client list: what /player/playback can actually
    // reach right now. Plexamp drops out of it when the phone app has been in
    // the background or restarted, even while /status/sessions still reports
    // the track, so a 404 on a command means "look the player up again".
    async refreshPlayer() {
      try {
        const res = await CH.fetchTimeout(Plex.url('/clients'), { headers: { Accept: 'application/json' } }, CH.CONFIG.MEDIA_FETCH_TIMEOUT_MS);
        if (!res.ok) { Plex.lastControl = 'clients HTTP ' + res.status; return false; }
        const j = await res.json();
        const list = ((j && j.MediaContainer && j.MediaContainer.Server) || [])
          .filter((c) => c.machineIdentifier && /playback/.test(c.protocolCapabilities || ''));
        const match = list.find((c) => c.machineIdentifier === Plex.player)
          || list.find((c) => /plexamp/i.test(c.product || '') || /plexamp/i.test(c.name || ''));
        if (!match) { Plex.lastControl = 'player not in server client list (' + list.length + ' clients)'; return false; }
        Plex.player = match.machineIdentifier; Plex.playerName = match.name || match.product || Plex.playerName;
        return true;
      } catch (e) { Plex.lastControl = 'clients: ' + ((e && e.message) || 'error'); return false; }
    },

    send(name) {
      Plex.cmdId++;
      return CH.fetchTimeout(Plex.url('/player/playback/' + name, {
        type: 'music',
        commandID: String(Plex.cmdId),
        'X-Plex-Target-Client-Identifier': Plex.player,
        'X-Plex-Client-Identifier': Plex.clientId,
      }), {}, CH.CONFIG.MEDIA_FETCH_TIMEOUT_MS);
    },

    async cmd(name) {
      if (!Plex.creds) throw { auth: true };
      if (!Plex.player) await Plex.poll();                       // first command before the first poll
      if (!Plex.player) { Plex.lastControl = 'no player id yet'; throw { code: 404, local: true }; }
      let res = await Plex.send(name);
      if (res.status === 404 && await Plex.refreshPlayer()) res = await Plex.send(name);   // retry once with a fresh id
      if (!res.ok) {
        if (res.status === 404) Plex.lastControl = 'server 404: player not reachable';
        else Plex.lastControl = 'control HTTP ' + res.status;
        throw { code: res.status };
      }
      Plex.lastControl = name + ' ok';
    },
    play() { return Plex.cmd('play'); },
    pause() { return Plex.cmd('pause'); },
    next() { return Plex.cmd('skipNext'); },
    prev() { return Plex.cmd('skipPrevious'); },

    describe(err) {
      if (!err) return 'Plex error';
      if (err.auth) return 'Plex: pair on phone';
      if (err.code === 404 && err.local) return 'Plex: nothing playing yet';
      if (err.code === 404) return 'Plex: player not reachable — open Plexamp';
      return 'Plex: control unavailable';
    },

    statusText() {
      if (!Plex.creds) return 'not connected (pair page)';
      return 'paired · ' + (Plex.playerName ? 'player ' + Plex.playerName : 'no player yet') + (Plex.lastError ? ' · ' + Plex.lastError : '') + (Plex.lastControl ? ' · last control: ' + Plex.lastControl : '');
    },
  };
  CH.PlexSource = Plex;
})();
