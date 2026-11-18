/* CycleHUD — media-spotify.js
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Spotify Web API source. Credentials {clientId, refreshToken, accessToken,
 * expiresAt} arrive from pair.html (PKCE flow on your phone) and live in
 * localStorage 'ch.spotify'. PKCE refresh tokens rotate, so every refresh
 * response is persisted immediately.
 */
(() => {
  'use strict';
  const CH = window.CH;
  const API = 'https://api.spotify.com/v1/me/player';
  const TOKEN = 'https://accounts.spotify.com/api/token';

  const Spotify = {
    key: 'spotify',
    label: 'Spotify',
    creds: null,
    refreshing: null,
    canControl: true,
    lastError: '',

    start(creds) {
      Spotify.creds = creds || null;
      Spotify.lastError = '';
      return !!(creds && creds.refreshToken && creds.clientId);
    },
    stop() { Spotify.creds = null; },

    async token() {
      const c = Spotify.creds;
      if (!c) throw { auth: true };
      if (c.accessToken && c.expiresAt - Date.now() > 60000) return c.accessToken;
      return Spotify.refresh();
    },

    refresh() {
      if (Spotify.refreshing) return Spotify.refreshing;
      Spotify.refreshing = (async () => {
        const c = Spotify.creds;
        if (!c) throw { auth: true };
        const res = await CH.fetchTimeout(TOKEN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.clientId }).toString(),
        }, CH.CONFIG.MEDIA_FETCH_TIMEOUT_MS);
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          if (res.status === 400 && (j.error === 'invalid_grant' || j.error === 'invalid_client')) {
            Spotify.creds = null;
            CH.store.set('spotify', null);
            throw { auth: true };
          }
          throw new Error('refresh HTTP ' + res.status);
        }
        const j = await res.json();
        c.accessToken = j.access_token;
        c.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
        if (j.refresh_token) c.refreshToken = j.refresh_token;
        CH.store.set('spotify', c);   // persist the rotated refresh token first
        return c.accessToken;
      })().finally(() => { Spotify.refreshing = null; });
      return Spotify.refreshing;
    },

    async poll() {
      try {
        let tok = await Spotify.token();
        let res = await CH.fetchTimeout(API + '?additional_types=track,episode', { headers: { Authorization: 'Bearer ' + tok } }, CH.CONFIG.MEDIA_FETCH_TIMEOUT_MS);
        if (res.status === 401) { tok = await Spotify.refresh(); res = await CH.fetchTimeout(API + '?additional_types=track,episode', { headers: { Authorization: 'Bearer ' + tok } }, CH.CONFIG.MEDIA_FETCH_TIMEOUT_MS); }
        if (res.status === 204) return { state: 'idle' };
        if (res.status === 429) { const ra = Number(res.headers.get('Retry-After')); return { state: 'ratelimit', retryAfterMs: (ra > 0 ? ra : 10) * 1000 }; }
        if (!res.ok) { Spotify.lastError = 'HTTP ' + res.status; return { state: 'offline' }; }
        const j = await res.json();
        const item = j && j.item;
        if (!item) return { state: 'idle', playing: !!(j && j.is_playing) };
        const artist = item.type === 'episode'
          ? ((item.show && item.show.name) || '')
          : (item.artists || []).map((a) => a.name).join(', ');
        return { state: 'ok', playing: !!j.is_playing, title: item.name || '', artist, pos: j.progress_ms, dur: item.duration_ms };
      } catch (e) {
        if (e && e.auth) return { state: 'auth' };
        Spotify.lastError = (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'error';
        return { state: 'offline' };
      }
    },

    async cmd(method, path) {
      const tok = await Spotify.token();
      const res = await CH.fetchTimeout(API + '/' + path, { method, headers: { Authorization: 'Bearer ' + tok } }, CH.CONFIG.MEDIA_FETCH_TIMEOUT_MS);
      if (res.status === 403) {
        const j = await res.json().catch(() => null);
        throw { code: 403, reason: (j && j.error && j.error.reason) || '' };
      }
      if (res.status === 404) throw { code: 404 };
      if (!res.ok && res.status !== 204) throw { code: res.status };
    },
    play() { return Spotify.cmd('PUT', 'play'); },
    pause() { return Spotify.cmd('PUT', 'pause'); },
    next() { return Spotify.cmd('POST', 'next'); },
    prev() { return Spotify.cmd('POST', 'previous'); },

    // Human-readable error for the bar / toast.
    describe(err) {
      if (!err) return 'Spotify error';
      if (err.auth) return 'Spotify: sign in on phone';
      if (err.code === 403) return err.reason === 'PREMIUM_REQUIRED' ? 'Spotify Premium needed' : 'Spotify refused that';
      if (err.code === 404) return 'No active Spotify device';
      return 'Spotify: ' + (err.message || ('HTTP ' + err.code));
    },

    statusText() {
      if (!Spotify.creds) return 'not connected (pair page)';
      const left = Math.round((Spotify.creds.expiresAt - Date.now()) / 1000);
      return 'paired · token ' + (left > 0 ? 'ok for ' + Math.round(left / 60) + ' min' : 'expired, will refresh') + (Spotify.lastError ? ' · ' + Spotify.lastError : '');
    },
  };
  CH.SpotifySource = Spotify;
})();
