/* Cycle Hub — app.js
 * Boot, settings, screens + history (the glasses' Back calls history.back()),
 * focus movement, key routing, menu, clock, pills, pairing, status, wake lock.
 *
 * Input: the Neural Band / temple swipes send ArrowUp/Down/Left/Right + Enter.
 * Main screen: Enter map/dash view · Down menu · Left/Right previous/next track.
 * Add ?demo to ride a loop indoors (&start=LAT,LON &speed=7 &box=800).
 */
(() => {
  'use strict';
  const CH = window.CH;
  const CFG = CH.CONFIG;
  const G = CH.geo;
  const $ = (id) => document.getElementById(id);
  const { Loc, Sim, Compass, Motion, MapData, MapView, Relay, Media } = CH;

  // ------------------------------------------------------------------ storage + settings
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ch.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { if (v === null || v === undefined) localStorage.removeItem('ch.' + k); else localStorage.setItem('ch.' + k, JSON.stringify(v)); } catch { /* full or blocked */ } },
  };
  CH.store = store;

  const settings = {
    units: store.get('units', CFG.DEFAULT_UNITS),         // 'mph' | 'kmh'
    mapMode: store.get('mapMode', 'auto'),                 // 'auto' (facing up) | 'north'
    view: store.get('view', 'map'),                        // 'map' | 'dash' (no map: speed, media, clock)
    media: store.get('media', 'off'),                      // 'spotify' | 'plex' | 'off'
    zoom: store.get('zoom', CFG.DEFAULT_ZOOM),
    debug: store.get('debug', true),                       // on-map readout, toggled on the Status screen
  };
  if (!['mph', 'kmh'].includes(settings.units)) settings.units = CFG.DEFAULT_UNITS;
  if (!['auto', 'north'].includes(settings.mapMode)) settings.mapMode = 'auto';
  if (!['map', 'dash'].includes(settings.view)) settings.view = 'map';
  if (!['spotify', 'plex', 'off'].includes(settings.media)) settings.media = 'off';
  if (!(settings.zoom >= 0 && settings.zoom < CFG.ZOOMS.length)) settings.zoom = CFG.DEFAULT_ZOOM;
  CH.settings = settings;

  // ------------------------------------------------------------------ toast
  let toastT = null;
  function toast(msg, ms = 3000) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; }, ms);
  }
  Media.toast = toast;

  // ------------------------------------------------------------------ formatting
  function fmtSpeed(mps) {
    if (!G.finite(mps)) return '--';
    const v = settings.units === 'mph' ? mps * 2.236936 : mps * 3.6;
    return v < 10 ? v.toFixed(1) : String(Math.round(v));
  }
  const unitLabel = () => settings.units === 'mph' ? 'mph' : 'km/h';
  function fmtClock(d) {
    const h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  const ago = (t) => !t ? 'never' : Math.round((Date.now() - t) / 1000) + ' s ago';

  // ------------------------------------------------------------------ screens + history
  let current = 'map';
  const SCREENS = ['map', 'menu', 'pair', 'status'];

  function render(name) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
    const was = current;
    current = name;
    if (name === 'map') applyView();
    else { MapView.enabled = false; MapView.stop(); }
    if (name === 'menu') renderMenu();
    if (name === 'pair') renderPair();
    if (name === 'pair' || was === 'pair') Relay.setFastPoll(name === 'pair');
    if (name === 'status') renderStatus();
    if (was === 'status' || name === 'status') scheduleStatus();
    focusScreen(name);
  }

  function show(name, mode = 'push') {
    const depth = (history.state && history.state.d) || 0;
    if (mode === 'push') history.pushState({ s: name, d: depth + 1 }, '', '#' + name);
    else if (mode === 'replace') history.replaceState({ s: name, d: depth }, '', '#' + name);
    render(name);
  }

  function goBack() {
    const depth = (history.state && history.state.d) || 0;
    if (depth > 0) history.back();
  }

  window.addEventListener('popstate', (e) => {
    const st = e.state || { s: 'map', d: 0 };
    render(SCREENS.includes(st.s) ? st.s : 'map');
  });

  // The glasses can move focus around just after a screen changes, so we
  // place focus a few times over the first second — and stop the moment the
  // user presses anything.
  let lastKeyAt = 0;
  document.addEventListener('keydown', () => { lastKeyAt = Date.now(); }, true);
  function holdFocus(screen, getEl) {
    const since = Date.now();
    const put = () => {
      if (current !== screen || lastKeyAt > since) return;
      const el = getEl();
      if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    };
    [0, 80, 250, 600, 1200].forEach((ms) => setTimeout(put, ms));
  }
  function focusScreen(name) {
    if (name === 'map') holdFocus('map', () => $('map-focus'));
    else holdFocus(name, () => {
      // a [data-default] control (the menu's Play/Pause) wins, else the first visible control
      const scope = document.querySelector(`[data-screen="${name}"]`);
      if (!scope) return null;
      const pref = scope.querySelector('[data-default]');
      if (pref && !pref.disabled && !pref.closest('[hidden]')) return pref;
      return FocusNav.items(scope)[0] || null;
    });
  }

  // ------------------------------------------------------------------ focus movement (menu / pair / status)
  const FocusNav = {
    scope() { return document.querySelector('.screen:not([hidden])'); },
    items(scope) {
      return [...scope.querySelectorAll('button, [tabindex="0"]')].filter((el) =>
        !el.disabled && el.id !== 'map-focus' && !el.closest('[hidden]') && el.getClientRects().length);
    },
    move(dir) {
      const scope = FocusNav.scope();
      if (!scope) return false;
      const items = FocusNav.items(scope);
      if (!items.length) return false;
      const cur = document.activeElement;
      if (!cur || !scope.contains(cur) || cur === document.body) { items[0].focus(); return true; }
      if (cur.classList.contains('scroll') && (dir === 'down' || dir === 'up')) {
        const before = cur.scrollTop;
        cur.scrollBy({ top: (dir === 'down' ? 1 : -1) * cur.clientHeight * 0.6 });
        if (cur.scrollTop !== before) return true;
      }
      const r = cur.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let best = null, bestScore = Infinity;
      for (const el of items) {
        if (el === cur) continue;
        const b = el.getBoundingClientRect();
        const ex = b.left + b.width / 2, ey = b.top + b.height / 2;
        let along, across;
        if (dir === 'down') { if (b.top < r.bottom - 6) continue; along = b.top - r.bottom; across = gap(r.left, r.right, b.left, b.right, cx, ex); }
        else if (dir === 'up') { if (b.bottom > r.top + 6) continue; along = r.top - b.bottom; across = gap(r.left, r.right, b.left, b.right, cx, ex); }
        else if (dir === 'right') { if (b.left < r.right - 6) continue; along = b.left - r.right; across = gap(r.top, r.bottom, b.top, b.bottom, cy, ey); }
        else { if (b.right > r.left + 6) continue; along = r.left - b.right; across = gap(r.top, r.bottom, b.top, b.bottom, cy, ey); }
        const score = Math.max(0, along) + across * 2.5;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (best) { best.focus({ preventScroll: true }); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      return true;
    },
  };
  function gap(a1, a2, b1, b2, ca, cb) {
    if (b1 < a2 && b2 > a1) return Math.abs(ca - cb) * 0.05;
    return Math.min(Math.abs(b1 - a2), Math.abs(a1 - b2), Math.abs(ca - cb));
  }

  // ------------------------------------------------------------------ keys
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    if (current === 'map') {
      if (k === 'ArrowDown') { openMenu(); e.preventDefault(); }
      else if (k === 'ArrowUp') { e.preventDefault(); }
      else if (k === 'ArrowLeft') { mediaAct('prev'); e.preventDefault(); }
      else if (k === 'ArrowRight') { mediaAct('next'); e.preventDefault(); }
      else if (k === 'Enter') { toggleView(); e.preventDefault(); }
      return;
    }
    const dir = { ArrowDown: 'down', ArrowUp: 'up', ArrowLeft: 'left', ArrowRight: 'right' }[k];
    if (dir) { if (FocusNav.move(dir)) { e.preventDefault(); e.stopPropagation(); } return; }
    if (k === 'Enter') {
      const el = document.activeElement;
      if (el && el.tagName === 'BUTTON') { el.click(); e.preventDefault(); }
      return;
    }
    if (k === 'Escape') { goBack(); e.preventDefault(); }
  }, true);

  document.addEventListener('click', (e) => {
    if (e.target.id === 'map-focus') { toggleView(); return; }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    if (a === 'back') goBack();
    else if (a === 'playpause') { mediaAct('toggle'); renderMenu(); }
    else if (a === 'prev') mediaAct('prev');
    else if (a === 'next') mediaAct('next');
    else if (a === 'units') { settings.units = settings.units === 'mph' ? 'kmh' : 'mph'; store.set('units', settings.units); applyUnits(); renderMenu(); }
    else if (a === 'mapmode') { cycleMapMode(); renderMenu(); }
    else if (a === 'zoom') { cycleZoom(); renderMenu(); }
    else if (a === 'media') { cycleMedia(); renderMenu(); }
    else if (a === 'pair') show('pair');
    else if (a === 'status') show('status');
    else if (a === 'newcode') { Relay.start(true); renderPair(); toast('New code — enter it on your phone'); }
    else if (a === 'locretry') { Loc.restart(); toast('Looking for your location…'); renderStatus(); }
    else if (a === 'debug') { settings.debug = !settings.debug; store.set('debug', settings.debug); renderStatus(); updateDebug(); }
  });

  function cycleZoom() {
    MapView.setZoom((MapView.zoom + 1) % CFG.ZOOMS.length);
    store.set('zoom', MapView.zoom);
    toast('Zoom: ' + CFG.ZOOM_LABELS[MapView.zoom] + ' · ' + MapView.acrossText(), 1500);
  }

  // ------------------------------------------------------------------ main-screen view (map / dash)
  function applyView() {
    $('screen-map').classList.toggle('dash', settings.view === 'dash');
    MapView.enabled = current === 'map' && settings.view === 'map';
    if (MapView.enabled) MapView.requestDraw(); else MapView.stop();
    Media.remeasure();
    updateDebug();
  }
  function toggleView() {
    settings.view = settings.view === 'map' ? 'dash' : 'map';
    store.set('view', settings.view);
    applyView();
  }

  function mediaAct(name) {
    if (settings.media === 'off') { if (name !== 'toggle') toast('Media is off — Menu → Media', 2000); return; }
    Media.act(name);
  }

  // ------------------------------------------------------------------ menu
  function openMenu() { show('menu'); }

  function renderMenu() {
    const hasMedia = settings.media !== 'off';
    const pp = $('row-playpause');
    $('row-transport').hidden = !hasMedia;
    pp.textContent = Media.last.playing ? '❚❚  Pause' : '▶  Play';
    $('row-units').textContent = 'Units: ' + unitLabel();
    $('row-mapmode').textContent = 'Map: ' + mapModeLabel();
    $('row-zoom').textContent = 'Zoom: ' + CFG.ZOOM_LABELS[MapView.zoom];
    $('row-media').textContent = 'Media: ' + ({ spotify: 'Spotify', plex: 'Plex', off: 'Off' })[settings.media];
  }
  Media.onState = () => { if (current === 'menu') renderMenu(); };

  const mapModeLabel = () => ({ auto: 'Facing up', north: 'North up' })[settings.mapMode];

  function applyUnits() {
    MapView.units = settings.units;
    $('speed-unit').textContent = unitLabel();
    updateSpeedPill();
    MapView.requestDraw();
  }

  function cycleMapMode() {
    const next = settings.mapMode === 'auto' ? 'north' : 'auto';
    settings.mapMode = next;
    store.set('mapMode', next);
    Motion.mode = next;
    toast('Map: ' + mapModeLabel(), 1500);
    MapView.requestDraw();
  }

  function cycleMedia() {
    const order = ['spotify', 'plex', 'off'];
    settings.media = order[(order.indexOf(settings.media) + 1) % order.length];
    store.set('media', settings.media);
    Media.setSource(settings.media);
    MapView.requestDraw();
  }

  // ------------------------------------------------------------------ clock + pills
  function tickClock() {
    const now = new Date();
    $('clock').textContent = fmtClock(now);
    setTimeout(tickClock, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  }

  function updateSpeedPill() {
    const pill = $('speed-pill');
    const stale5 = Motion.speedStale(5000), stale15 = Motion.speedStale(15000);
    $('speed-val').textContent = stale15 ? '--' : fmtSpeed(Motion.speed);
    pill.classList.toggle('dim', stale5 && !stale15);
  }

  function updateGpsPill() {
    const el = $('gps-pill');
    const f = Loc.last;
    const age = f ? Date.now() - f.t : Infinity;
    let msg = '';
    if (Loc.status.state === 'denied') msg = 'Location blocked';
    else if (!f || age > 30000) msg = 'Waiting for GPS';
    else if (age > 10000 || (G.finite(f.accuracy) && f.accuracy > 60)) msg = 'Weak GPS';
    el.hidden = !msg;
    if (msg) el.textContent = msg;
  }

  function updateMapPill() {
    const el = $('map-pill');
    let msg = '';
    if (MapData.status === 'loading') msg = 'Loading map…';
    else if (MapData.status === 'error') msg = 'Map data unavailable';
    else if (MapData.status === 'idle' && Loc.last) msg = 'Loading map…';
    el.hidden = !msg;
    if (msg) el.textContent = msg;
  }

  // Two short lines about what the heading is based on, readable while riding.
  function updateDebug() {
    const el = $('debug-pill');
    el.hidden = !settings.debug || settings.view === 'dash';
    if (el.hidden) return;
    const f = Loc.last;
    const dg = (v) => G.finite(v) ? Math.round(v) + '°' : '–';
    const b = Math.round(Motion.bias);
    const l1 = Motion.courseSrc + ' ' + dg(Motion.course) + ' · cmp ' + dg(Compass.fresh()) + ' b' + (b >= 0 ? '+' : '') + b + ' · map ' + dg(Motion.displayed) + (Motion.road ? ' · ' + Math.round(Motion.road.dist) + 'm' : '');
    const l2 = f ? mapModeLabel() + ' · fix ' + Math.round((Date.now() - f.t) / 1000) + 's ±' + Math.round(f.accuracy) + 'm · h' + dg(f.heading) + ' s' + (G.finite(f.speed) ? f.speed.toFixed(1) : '–')
      : mapModeLabel() + ' · no fix yet';
    el.innerHTML = '<span>' + esc(l1) + '</span><span>' + esc(l2) + '</span>';
  }

  // Cheap 1 Hz housekeeping for the pills (the map itself redraws only on events).
  setInterval(() => {
    if (document.visibilityState === 'hidden' || current !== 'map') return;
    updateSpeedPill(); updateGpsPill(); updateMapPill(); updateDebug();
  }, 1000);

  // ------------------------------------------------------------------ location → everything
  function onFix(fix) {
    Motion.onFix(fix);
    if (!MapData.origin) MapData.tryCache(fix);
    MapData.update(fix);
    MapView.setFix(fix);
    if (current === 'map') { updateSpeedPill(); updateGpsPill(); updateMapPill(); updateDebug(); }
  }
  MapData.onChange = () => { updateMapPill(); MapView.requestDraw(); if (current === 'status') renderStatus(); };
  Compass.onChange = () => { if (MapView.enabled) MapView.requestDraw(); };
  Loc.onStatus = () => { updateGpsPill(); if (current === 'status') renderStatus(); };

  // ------------------------------------------------------------------ pairing
  function pairUrl() {
    const dir = location.origin + location.pathname.replace(/[^/]*$/, '');
    return (dir + 'pair.html').replace(/^https?:\/\//, '');
  }
  function renderPair() {
    $('pair-url').textContent = pairUrl();
    $('pair-code').textContent = Relay.pretty();
    renderRelayDot();
  }
  let pairMsg = '';   // last confirmation shown on the Pair screen
  function renderRelayDot() {
    const el = $('pair-status');
    if (!el) return;
    const recent = Relay.lastDeliveredAt && Date.now() - Relay.lastDeliveredAt < 180000;
    el.classList.toggle('on', Relay.connected || recent);
    el.classList.toggle('paired', recent);
    $('pair-status-text').textContent = recent ? (pairMsg || 'Phone paired ✓') + ' · ' + ago(Relay.lastDeliveredAt)
      : Relay.connected ? 'Ready — waiting for your phone' : 'Connecting…';
  }
  setInterval(() => { if (current === 'pair') renderRelayDot(); }, 2000);
  Relay.onStatus = renderRelayDot;
  Relay.onMessage = (p) => {
    if (p.spotify && typeof p.spotify === 'object' && p.spotify.refreshToken && p.spotify.clientId) {
      store.set('spotify', {
        clientId: String(p.spotify.clientId), refreshToken: String(p.spotify.refreshToken),
        accessToken: p.spotify.accessToken || '', expiresAt: Number(p.spotify.expiresAt) || 0,
      });
      settings.media = 'spotify'; store.set('media', 'spotify');
      Media.setSource('spotify');
      pairMsg = 'Spotify connected ✓';
      toast(pairMsg);
      if (current === 'menu') renderMenu();
      renderRelayDot();
      return;
    }
    if (p.plex && typeof p.plex === 'object' && p.plex.url && p.plex.token) {
      store.set('plex', { url: String(p.plex.url), token: String(p.plex.token) });
      settings.media = 'plex'; store.set('media', 'plex');
      Media.setSource('plex');
      pairMsg = 'Plex connected ✓';
      toast(pairMsg);
      if (current === 'menu') renderMenu();
      renderRelayDot();
      return;
    }
    if (p.ping) { pairMsg = 'Phone paired ✓'; toast(pairMsg); renderRelayDot(); }
  };

  // ------------------------------------------------------------------ status screen
  let statusTimer = null;
  function scheduleStatus() {
    clearInterval(statusTimer); statusTimer = null;
    if (current === 'status') statusTimer = setInterval(renderStatus, 2000);
  }
  function renderStatus() {
    const f = Loc.last;
    const rows = [
      ['Location', CH.DEMO ? 'demo rider' : Loc.status.state + (Loc.status.code != null ? ' (code ' + Loc.status.code + ')' : '')],
      ['Last fix', f ? ago(f.t) + ' · ±' + Math.round(f.accuracy) + ' m' : 'none'],
      ['Fixes / restarts', Loc.fixes + ' / ' + Loc.restarts],
      ['Speed', fmtSpeed(Motion.speed) + ' ' + unitLabel() + (Motion.speedStale(5000) ? ' (stale)' : '')],
      ['Course', (Motion.course == null ? '–' : Math.round(Motion.course) + '°') + ' · ' + Motion.courseSrc + ' · ' + Motion.state],
      ['Heading', (Motion.heading == null ? '–' : Math.round(Motion.heading) + '°') + ' · compass ' + (Compass.fresh() == null ? (Compass.attached ? 'no data' : 'off') : Math.round(Compass.fresh()) + '°') + ' · bias ' + Math.round(Motion.bias) + '°'],
      ['Fix fields', f ? 'heading ' + (G.finite(f.heading) ? Math.round(f.heading) + '°' : 'none') + ' · speed ' + (G.finite(f.speed) ? f.speed.toFixed(1) + ' m/s' : 'none') : '–'],
      ['Map tiles', MapData.loadedCount() + ' loaded · ' + MapData.wayCount() + ' ways · ' + MapData.pending.size + ' loading' + (MapData.lastSrc ? ' · last from ' + MapData.lastSrc : '')],
      ['Map fetch', MapData.status + (MapData.error ? ' · ' + MapData.error : '')],
      ['Draw', MapView.frames + ' frames · last ' + MapView.lastFrameMs.toFixed(1) + ' ms · zoom ' + MapView.metresPerPx() + ' m/px'],
      ['Relay', (Relay.connected ? 'connected' : 'not connected') + ' · code ' + Relay.pretty()],
      ['Media', Media.statusText()],
      ['Spotify', CH.SpotifySource.statusText()],
      ['Plex', CH.PlexSource.statusText()],
      ['Wake lock', wakeLock ? 'held' : 'not held'],
      ['Version', CFG.VERSION + ' · map data © OpenStreetMap contributors'],
    ];
    $('status-list').innerHTML = rows.map(([k, v]) => `<div class="kv-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    $('btn-locretry').hidden = CH.DEMO;
    $('btn-debug').textContent = 'Debug: ' + (settings.debug ? 'on' : 'off');
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------------ wake lock
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* not supported — fine */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { keepAwake(); if (current === 'map') MapView.requestDraw(); }
    else MapView.stop();
  });

  // ------------------------------------------------------------------ boot
  function boot() {
    MapView.init($('map'));
    MapView.zoom = settings.zoom;
    Motion.mode = settings.mapMode;
    Motion.roadLookup = MapData.nearestRoad;
    // The compass is always part of the heading. Try straight away (attaches
    // directly where no permission API exists); where a prompt needs a user
    // gesture the first attempt fails, so ask again on the first key press.
    Compass.request().then((ok) => { if (!ok) document.addEventListener('keydown', () => { Compass.request(); }, { once: true }); });
    applyUnits();
    history.replaceState({ s: 'map', d: 0 }, '', location.pathname + location.search + '#map');
    render('map');
    tickClock();
    Relay.start();
    Media.setSource(settings.media);
    Loc.watch(onFix);
    keepAwake();
    updateGpsPill(); updateMapPill(); updateDebug();
    if (CH.DEMO) toast('Demo: riding a loop at ' + fmtSpeed(Sim.speed) + ' ' + unitLabel(), 3000);
    console.info('Cycle Hub', CFG.VERSION, CH.DEMO ? '[demo]' : '');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
