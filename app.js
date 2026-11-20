/* CycleHUD — app.js
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Boot, settings, screens + history (the glasses' Back calls history.back()),
 * focus movement, key routing, menu, clock, pills, pairing, status, wake lock.
 *
 * Input: the Neural Band / temple swipes send ArrowUp/Down/Left/Right + Enter.
 * Main screen: Enter Map View / Glance View (dash) · Up zoom · Down menu · Left/Right previous/next track.
 * Menu: Pause / Stop Ride opens the pause screen (Enter resumes; Back asks before quitting).
 * Add ?demo to ride a loop indoors (&start=LAT,LON &speed=7; degradations in
 * geo.js), or ?replay=URL to play a ride log back.
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
    view: store.get('view', 'map'),                        // 'map' | 'dash' (no map: speed, media, clock on the media bar's row, dimmed)
    media: store.get('media', 'auto'),                     // 'auto' (whichever is playing) | 'spotify' | 'plex' | 'off' (shown as Audio: None; the bar is hidden)
    zoom: store.get('zoom', CFG.DEFAULT_ZOOM),
    debug: store.get('debug', false),                      // on-map readout (bottom band), toggled on the Status screen
    glance: store.get('glance', 'dim'),                    // Glance View brightness: 'dim' (--dash-dim) | 'bright'
  };
  if (!['mph', 'kmh'].includes(settings.units)) settings.units = CFG.DEFAULT_UNITS;
  if (!['auto', 'north'].includes(settings.mapMode)) settings.mapMode = 'auto';
  if (!['map', 'dash'].includes(settings.view)) settings.view = 'map';
  if (!['auto', 'spotify', 'plex', 'off'].includes(settings.media)) settings.media = 'auto';
  if (!(settings.zoom >= 0 && settings.zoom < CFG.ZOOMS.length)) settings.zoom = CFG.DEFAULT_ZOOM;
  if (!['dim', 'bright'].includes(settings.glance)) settings.glance = 'dim';
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
    return v.toFixed(1);                        // always one decimal: cyclists read 14.2, not 14
  }
  // Speed dial gauge: a circle of radius 54 in a 120 x 120 viewBox, rotated so
  // its path starts at 7:30 and sweeps 270 degrees clockwise (index.html). The
  // arc is GAUGE_SEGS short segments of 10 degrees (overlapping 0.4 degrees so
  // no seams show), each coloured from the white -> yellow -> orange -> red
  // run by its position; updateSpeedPill reveals them in turn.
  const GAUGE_R = 54, GAUGE_C = 2 * Math.PI * GAUGE_R, GAUGE_SWEEP_DEG = 270;
  const GAUGE_SEGS = 27, SEG_DEG = GAUGE_SWEEP_DEG / GAUGE_SEGS, SEG_OVERLAP = 0.4;
  const SEG_LEN = GAUGE_C * (SEG_DEG + SEG_OVERLAP) / 360;
  const GAUGE_STOPS = [[255, 255, 255], [255, 214, 102], [255, 140, 50], [255, 59, 59]];
  let gaugeSegs = [];
  function gaugeColour(f) {                       // f 0..1 along the sweep
    const p = Math.min(0.9999, Math.max(0, f)) * (GAUGE_STOPS.length - 1), i = Math.floor(p), t = p - i;
    const a = GAUGE_STOPS[i], b = GAUGE_STOPS[i + 1];
    return 'rgb(' + a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(',') + ')';
  }
  function buildGauge() {
    const g = $('speed-arc'), NS = 'http://www.w3.org/2000/svg';
    const pt = (deg) => { const r = deg * Math.PI / 180; return (60 + GAUGE_R * Math.cos(r)).toFixed(2) + ' ' + (60 + GAUGE_R * Math.sin(r)).toFixed(2); };
    gaugeSegs = [];
    for (let i = 0; i < GAUGE_SEGS; i++) {
      const a0 = i * SEG_DEG, a1 = a0 + SEG_DEG + SEG_OVERLAP;
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('class', 'gauge-seg');
      p.setAttribute('d', 'M ' + pt(a0) + ' A ' + GAUGE_R + ' ' + GAUGE_R + ' 0 0 1 ' + pt(a1));
      p.style.stroke = gaugeColour((a0 + SEG_DEG / 2) / GAUGE_SWEEP_DEG);
      p.style.strokeDasharray = '0 999';
      g.appendChild(p);
      gaugeSegs.push(p);
    }
  }

  // Ride time: how long the bike has been moving since the app was opened. It
  // runs while Motion has confirmed movement and the shown speed is above
  // zero (so a stop at a light pauses it the moment the dial reads 0.0, a few
  // seconds before the heading logic declares the hold), and not at all while
  // the ride is paused from the menu. Distance is the speed integrated over
  // that running time, so the average speed (distance / ride time) is a
  // moving average that stops at lights do not drag down. Nothing is persisted:
  // a fresh launch starts from 00:00, a sleeping display keeps the count.
  const RideTime = {
    acc: 0, since: null, started: false,
    held: false,             // Pause / Stop Ride: nothing counts until Resume
    dist: 0, lastAt: null,   // metres covered while running; when the last slice was added
    running() { return !RideTime.held && Motion.moving && Motion.speed >= 0.05; },   // 0.05 m/s = the dial's smallest non-zero reading
    update(now) {
      const run = RideTime.running();
      if (run && RideTime.since == null) { RideTime.since = now; RideTime.started = true; }
      else if (!run && RideTime.since != null) { RideTime.acc += now - RideTime.since; RideTime.since = null; }
      if (run && RideTime.lastAt != null && now > RideTime.lastAt) RideTime.dist += Motion.speed * (now - RideTime.lastAt) / 1000;
      RideTime.lastAt = run ? now : null;
    },
    ms(now = CH.clock()) { return RideTime.acc + (RideTime.since != null ? now - RideTime.since : 0); },
    paused() { return RideTime.started && !RideTime.running(); },
    avg() { const s = RideTime.ms() / 1000; return s >= 10 && RideTime.dist > 0 ? RideTime.dist / s : null; },   // m/s; null until 10 s of riding
  };
  CH.RideTime = RideTime;
  function fmtRide(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    const mm = (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
    return h ? h + ':' + mm : mm;
  }
  const fmtDist = (m) => (settings.units === 'mph' ? m / 1609.344 : m / 1000).toFixed(1);
  const distUnit = () => settings.units === 'mph' ? 'mi' : 'km';
  function renderRide() {
    const now = CH.clock();
    RideTime.update(now);
    const text = fmtRide(RideTime.ms(now)), paused = RideTime.paused();
    for (const id of ['ride-val', 'clock-ride', 'pause-ride']) {
      const el = $(id);
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle('paused', paused);
    }
  }
  const unitLabel = () => settings.units === 'mph' ? 'mph' : 'km/h';
  function fmtClock(d) {
    const h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  const ago = (t) => !t ? 'never' : Math.round((CH.clock() - t) / 1000) + ' s ago';

  // ------------------------------------------------------------------ screens + history
  let current = 'map';
  const SCREENS = ['map', 'menu', 'pair', 'status', 'pause', 'quit'];
  let resumeIntent = false;   // Enter on the pause screen has called history.back(): the popstate is a resume, not a Back

  function render(name) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
    const was = current;
    current = name;
    placeMediaBar(name);
    if (name === 'map') applyView();
    else { MapView.enabled = false; MapView.stop(); }
    if (name === 'menu') renderMenu();
    if (name === 'pause') renderPause();
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

  // History: map (0) -> menu (1) -> pair / status (2). Pause / Stop Ride replaces the
  // menu entry, so the pause screen sits at depth 1 over the map. Enter there
  // goes back to the map; the Back gesture is turned into the Quit? screen at
  // depth 0, where the next Back leaves the app through the glasses (a web app
  // cannot close itself) and Resume puts the map back at depth 0.
  window.addEventListener('popstate', (e) => {
    const st = e.state || { s: 'map', d: 0 };
    const resuming = resumeIntent; resumeIntent = false;
    if (resuming) { show('map', 'replace'); return; }
    if (current === 'pause') { show('quit', 'replace'); return; }
    render(SCREENS.includes(st.s) ? st.s : 'map');
  });

  // The glasses can move focus around just after a screen changes, so we
  // place focus a few times over the first second — and stop the moment the
  // user presses anything.
  let lastKeyAt = 0;
  document.addEventListener('keydown', () => { lastKeyAt = CH.clock(); }, true);
  function holdFocus(screen, getEl) {
    const since = CH.clock();
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
    if (Splash.up) { Splash.dismiss(); e.preventDefault(); e.stopImmediatePropagation(); return; }   // skip the splash, nothing else
    const k = e.key;
    if (current === 'map') {
      if (k === 'ArrowDown') { openMenu(); e.preventDefault(); }
      else if (k === 'ArrowUp') { cycleZoom(); e.preventDefault(); }
      else if (k === 'ArrowLeft') { mediaAct('prev'); e.preventDefault(); }
      else if (k === 'ArrowRight') { mediaAct('next'); e.preventDefault(); }
      else if (k === 'Enter') { toggleView(); e.preventDefault(); }
      return;
    }
    if (current === 'pause') {
      // Enter resumes whatever has focus (focus wanders on the glasses after a screen change)
      if (k === 'ArrowLeft') mediaAct('prev');
      else if (k === 'ArrowRight') mediaAct('next');
      else if (k === 'Enter') resumeRide();
      else if (k === 'Escape') goBack();
      else return;
      e.preventDefault(); return;
    }
    if (current === 'quit' && k === 'Enter') { resumeRide(); e.preventDefault(); return; }
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
    else if (a === 'glance') { cycleGlance(); renderMenu(); }
    else if (a === 'pause') pauseRide();
    else if (a === 'resume') resumeRide();
    else if (a === 'pair') show('pair');
    else if (a === 'status') show('status');
    else if (a === 'newcode') { Relay.start(true); renderPair(); toast('New code — enter it on your phone'); }
    else if (a === 'locretry') { Loc.restart(); toast('Looking for your location…'); renderStatus(); }
    else if (a === 'debug') { settings.debug = !settings.debug; store.set('debug', settings.debug); renderStatus(); updateDebug(); }
    else if (a === 'ridelog') sendRideLog();
  });

  // Publish the ride log (every fix and what the heading made of it) to the
  // relay as a file; pair.html on the phone lists it for download.
  let sendingLog = false;
  async function sendRideLog() {
    if (sendingLog) return;
    if (!Motion.log.length) { toast('No ride log yet', 2500); return; }
    sendingLog = true;
    toast('Sending ride log…', 30000);
    try {
      const name = 'cyclehud-ride-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
      await Relay.upload(name, Motion.exportLog());
      toast('Ride log sent · pair.html on your phone lists it', 5000);
    } catch (e) { toast('Could not send the log: ' + (e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'error'), 5000); }
    sendingLog = false;
  }

  function cycleZoom() {
    MapView.setZoom((MapView.zoom + 1) % CFG.ZOOMS.length);
    store.set('zoom', MapView.zoom);
    toast('Zoom: ' + CFG.ZOOM_LABELS[MapView.zoom] + ' · ' + MapView.acrossText(), 1500);
  }

  // ------------------------------------------------------------------ main-screen view (map / dash)
  function applyView() {
    const scr = $('screen-map');
    scr.classList.toggle('dash', settings.view === 'dash');
    scr.classList.toggle('bright', settings.glance === 'bright');
    MapView.enabled = current === 'map' && settings.view === 'map';
    if (MapView.enabled) {
      // back on show with an old fix (display was off, or the phone went quiet
      // at a standstill while another screen was up): ask for a fresh one
      const away = MapView.resume();
      if (away || !Loc.fresh(CFG.STALE_FIX_MS)) Loc.refresh();
    } else MapView.stop();
    Media.remeasure(); renderRide();
    updateDebug(); updateGpsPill(); updateMapPill();
  }
  function cycleGlance() {
    settings.glance = settings.glance === 'bright' ? 'dim' : 'bright';
    store.set('glance', settings.glance);
    $('screen-map').classList.toggle('bright', settings.glance === 'bright');
    toast('Glance View: ' + (settings.glance === 'bright' ? 'Bright' : 'Dimmed'), 1500);
  }
  function toggleView() {
    settings.view = settings.view === 'map' ? 'dash' : 'map';
    store.set('view', settings.view);
    applyView();
  }

  function mediaAct(name) {
    if (settings.media === 'off') { if (name !== 'toggle') toast('Audio is set to None — Menu → Audio', 2000); return; }
    Media.act(name);
  }

  // ------------------------------------------------------------------ menu
  function openMenu() { show('menu'); }

  function renderMenu() {
    $('row-transport').hidden = settings.media === 'off';
    renderMenuPlayer();
    $('row-units').textContent = 'Units: ' + unitLabel();
    $('row-mapmode').textContent = 'Map: ' + mapModeLabel();
    $('row-zoom').textContent = 'Zoom: ' + CFG.ZOOM_LABELS[MapView.zoom];
    $('row-glance').textContent = 'Glance View: ' + (settings.glance === 'bright' ? 'Bright' : 'Dimmed');
    $('row-media').textContent = 'Audio: ' + ({ auto: 'Auto', spotify: 'Spotify', plex: 'Plex', off: 'None' })[settings.media];
  }
  // The menu's centre button is a small now-playing card: the action glyph
  // (press = play / pause), title, artist and a progress line along its bottom.
  function renderMenuPlayer() {
    const L = Media.last, src = Media.source;
    let t = L.title, a = L.artist;
    if (L.state === 'auth') { t = (src ? src.label : 'Audio') + ' not connected'; a = Media.connectHint(src); }
    else if (!t) { t = L.state === 'offline' ? 'Reconnecting…' : 'Nothing playing'; a = L.state === 'offline' ? '' : 'Start it on your phone'; }
    else if (L.state === 'offline') a = (a ? a + ' · ' : '') + 'Reconnecting…';
    $('pp-glyph').textContent = L.playing ? '❚❚' : '▶';
    const title = $('pp-title'), artist = $('pp-artist');
    if (title.textContent !== t) title.textContent = t;
    if (artist.textContent !== a) artist.textContent = a;
    const f = Media.progress();
    $('pp-prog').hidden = f == null;
    if (f != null) $('pp-prog-fill').style.width = (f * 100).toFixed(2) + '%';
  }
  Media.onState = () => { if (current === 'menu') renderMenu(); };

  // ------------------------------------------------------------------ pause ride / quit?
  // One media bar serves the map screen and the pause screen: the node moves
  // between them (media.js finds it by id wherever it is).
  function placeMediaBar(name) {
    const bar = $('media-bar');
    const host = name === 'pause' ? $('pause-media') : name === 'map' ? $('screen-map') : null;
    if (!host || bar.parentElement === host) return;
    host.appendChild(bar);
    if (name === 'pause') Media.remeasure();
  }
  function pauseRide() {
    RideTime.update(CH.clock());
    RideTime.held = true;
    show('pause', 'replace');            // the menu entry (depth 1) becomes the pause screen
  }
  function resumeRide() {
    RideTime.held = false;
    const depth = (history.state && history.state.d) || 0;
    if (current === 'quit' || depth === 0) { show('map', 'replace'); return; }
    if (resumeIntent) return;            // back() already on its way (a second Enter)
    resumeIntent = true;
    history.back();
  }
  function renderPause() {
    renderRide();
    const avg = RideTime.avg();
    $('pause-avg').textContent = avg == null ? '--' : fmtSpeed(avg);
    $('pause-avg-unit').textContent = unitLabel();
    $('pause-dist').textContent = fmtDist(RideTime.dist);
    $('pause-dist-unit').textContent = distUnit();
  }

  // ------------------------------------------------------------------ splash
  // Wordmark and tagline, then the safety line, over the map while it boots.
  // Any key skips it (and is swallowed). Not shown for ride replays or with
  // ?nosplash (harness runs that press keys straight away).
  const Splash = {
    up: false, timers: [],
    start() {
      const el = $('splash');
      if (!el) return;
      if (CH.REPLAY || /[?&]nosplash\b/.test(location.search)) { el.remove(); return; }
      Splash.up = true;
      const at = (ms, fn) => Splash.timers.push(setTimeout(fn, ms));
      requestAnimationFrame(() => el.classList.add('in'));
      at(1000, () => $('splash-safe').classList.add('show'));
      at(4000, Splash.dismiss);
    },
    dismiss() {
      if (!Splash.up) return;
      Splash.up = false;
      Splash.timers.forEach(clearTimeout);
      const el = $('splash');
      el.classList.add('out');
      setTimeout(() => el.remove(), 550);
    },
  };

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
    const order = ['auto', 'spotify', 'plex', 'off'];
    settings.media = order[(order.indexOf(settings.media) + 1) % order.length];
    store.set('media', settings.media);
    Media.setSource(settings.media);
    MapView.requestDraw();
  }

  // ------------------------------------------------------------------ clock + pills
  function tickClock() {
    const now = new Date(), t = fmtClock(now);
    document.querySelectorAll('.clock-time').forEach((el) => { if (el.textContent !== t) el.textContent = t; });
    setTimeout(tickClock, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  }

  function updateSpeedPill() {
    const pill = $('speed-pill');
    const stale5 = Motion.speedStale(5000), stale15 = Motion.speedStale(15000);
    $('speed-val').textContent = stale15 ? '--' : fmtSpeed(Motion.speed);
    pill.classList.toggle('dim', stale5 && !stale15);
    // gauge arc: reveal the first frac x 270 degrees, segment by segment
    const frac = stale15 || !G.finite(Motion.speed) ? 0 : Math.min(1, Math.max(0, Motion.speed / CFG.SPEED_GAUGE_FULL_MPS));
    const sweep = frac * GAUGE_SWEEP_DEG;
    gaugeSegs.forEach((p, i) => {
      const vis = Math.min(SEG_DEG + SEG_OVERLAP, Math.max(0, sweep - i * SEG_DEG)) / (SEG_DEG + SEG_OVERLAP) * SEG_LEN;
      p.style.strokeDasharray = vis.toFixed(2) + ' 999';
    });
  }

  function updateGpsPill() {
    const el = $('gps-pill');
    const f = Loc.last;
    const age = f ? CH.clock() - f.t : Infinity;
    let msg = '';
    if (Loc.status.state === 'denied') msg = 'Location blocked';
    else if (!f || age > 30000) msg = 'Waiting for GPS';
    else if (age > 10000 || (G.finite(f.accuracy) && f.accuracy > 60)) msg = 'Weak GPS';
    if (settings.view === 'dash' && msg !== 'Location blocked') msg = '';   // no map on show: only something you must act on
    el.hidden = !msg;
    if (msg) el.textContent = msg;
  }

  function updateMapPill() {
    const el = $('map-pill');
    let msg = '';
    if (MapData.status === 'loading') msg = 'Loading map…';
    else if (MapData.status === 'error') msg = 'Map data unavailable';
    else if (MapData.status === 'idle' && Loc.last) msg = 'Loading map…';
    else if (settings.view === 'map' && MapView.isStale(CH.clock())) msg = 'Map out of date…';
    if (settings.view === 'dash') msg = '';   // map notices mean nothing without the map
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
    // line 1: heading source + value, raw track bearing, drawn rotation, distance to the road used, sideways events
    // line 2: mode, fix age + accuracy, how often positions change + share of repeated fixes, compass (reference only)
    const D = Motion.diag, iv = Motion.median(Motion.intervals);
    const l1 = Motion.courseSrc + ' ' + dg(Motion.course) + ' · trk ' + dg(Motion.raw) + ' · map ' + dg(Motion.displayed) + (Motion.road ? ' · ' + Math.round(Motion.road.dist) + 'm' : '') + (D.sideways ? ' · sw' + D.sideways : '');
    const l2 = f ? (settings.mapMode === 'north' ? 'N-up' : 'Up') + ' · fix ' + Math.round((CH.clock() - f.t) / 1000) + 's ±' + Math.round(f.accuracy) + 'm · ' + (iv == null ? '–' : (iv / 1000).toFixed(1) + 's') + ' ' + (D.fixes ? Math.round(100 * D.repeats / D.fixes) : 0) + '%rep · cmp ' + (Motion.headHeading() != null ? dg(Motion.headHeading()) + '*' : dg(Compass.fresh()))
      : mapModeLabel() + ' · no fix yet';
    el.innerHTML = '<span>' + esc(l1) + '</span><span>' + esc(l2) + '</span>';
  }

  // Cheap 1 Hz housekeeping for the pills (the map itself redraws only on events).
  setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    Motion.tick(CH.clock());                       // compass-at-rest rules keep running if the phone goes quiet
    if (current === 'map') { updateSpeedPill(); updateGpsPill(); updateMapPill(); updateDebug(); renderRide(); }
    else if (current === 'pause') renderPause();
    else if (current === 'menu') renderMenuPlayer();
    else return;
    Media.renderProgress();                        // the track progress line creeps between polls
    // no fixes means no draws: start the stale (dimmed, pulsing) rendering ourselves
    if (current === 'map' && MapView.enabled && !MapView.stale && MapView.isStale(CH.clock())) MapView.requestDraw();
  }, 1000);

  // ------------------------------------------------------------------ location → everything
  function onFix(fix) {
    Motion.onFix(fix);
    if (!MapData.origin) MapData.tryCache(fix);
    MapData.update(fix);
    MapView.setFix(fix);
    RideTime.update(CH.clock());                   // catch the moving / stopped edge on the fix itself
    if (current === 'map') { updateSpeedPill(); updateGpsPill(); updateMapPill(); updateDebug(); renderRide(); }
    else if (current === 'pause') renderPause();
  }
  MapData.onChange = () => { updateMapPill(); MapView.requestDraw(); if (current === 'status') renderStatus(); };
  Motion.onChange = () => { if (MapView.enabled) MapView.requestDraw(); if (current === 'map') updateDebug(); };
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
    const recent = Relay.lastDeliveredAt && CH.clock() - Relay.lastDeliveredAt < 180000;
    el.classList.toggle('on', Relay.connected || recent);
    el.classList.toggle('paired', recent);
    const next = !pairMsg && !CH.SpotifySource.creds && !CH.PlexSource.creds ? ' · for music press Connect Spotify or Send to glasses on the phone' : '';
    $('pair-status-text').textContent = recent ? (pairMsg || 'Phone paired ✓') + next + ' · ' + ago(Relay.lastDeliveredAt)
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
      if (settings.media !== 'auto') { settings.media = 'spotify'; store.set('media', 'spotify'); }
      Media.setSource(settings.media);
      pairMsg = 'Spotify connected ✓';
      toast(pairMsg);
      if (current === 'menu') renderMenu();
      renderRelayDot();
      return;
    }
    if (p.plex && typeof p.plex === 'object' && p.plex.url && p.plex.token) {
      store.set('plex', { url: String(p.plex.url), token: String(p.plex.token) });
      if (settings.media !== 'auto') { settings.media = 'plex'; store.set('media', 'plex'); }
      Media.setSource(settings.media);
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
      ['Location', CH.REPLAY ? 'replaying a ride log' : CH.DEMO ? 'demo rider' : Loc.status.state + (Loc.status.code != null ? ' (code ' + Loc.status.code + ')' : '')],
      ['Last fix', f ? ago(f.t) + (f.ts ? ' (position ' + ago(f.ts) + ')' : '') + ' · ±' + Math.round(f.accuracy) + ' m' : 'none'],
      ['Fixes / restarts', Loc.fixes + ' / ' + Loc.restarts],
      ['Speed', fmtSpeed(Motion.speed) + ' ' + unitLabel() + (Motion.speedStale(5000) ? ' (stale)' : '')],
      ['Ride time', fmtRide(RideTime.ms()) + ' · ' + fmtDist(RideTime.dist) + ' ' + distUnit() + (RideTime.avg() != null ? ' · avg ' + fmtSpeed(RideTime.avg()) + ' ' + unitLabel() : '') + (RideTime.held ? ' · ride paused' : RideTime.paused() ? ' · paused' : RideTime.running() ? ' · moving' : ' · not started')],
      ['Heading', (Motion.course == null ? '–' : Math.round(Motion.course) + '°') + ' · from ' + Motion.courseSrc + (Motion.road ? ' (' + Math.round(Motion.road.dist) + ' m away)' : '') + ' · ' + (Motion.moving ? 'moving' : 'held')],
      ['Track', (Motion.raw == null ? '–' : Math.round(Motion.raw) + '° over ' + Math.round(Motion.base) + ' m') + ' · jitter ' + Motion.jitter.toFixed(1) + ' m'],
      ['Compass', Motion.calText() + ' · orients the map at launch and on a sustained turn while stopped'],
      ['Fix stream', Motion.diagText()],
      ['Fix fields', f ? 'heading ' + (G.finite(f.heading) ? Math.round(f.heading) + '°' : 'none') + ' · speed ' + (G.finite(f.speed) ? f.speed.toFixed(1) + ' m/s' : 'none') : '–'],
      ['Map tiles', MapData.loadedCount() + ' loaded · ' + MapData.wayCount() + ' ways · ' + MapData.pending.size + ' loading' + (MapData.lastSrc ? ' · last from ' + MapData.lastSrc : '')],
      ['Map fetch', MapData.status + (MapData.error ? ' · ' + MapData.error : '')],
      ['Draw', MapView.frames + ' frames · last ' + MapView.lastFrameMs.toFixed(1) + ' ms · zoom ' + MapView.metresPerPx() + ' m/px'],
      ['Relay', (Relay.connected ? 'connected' : 'not connected') + ' · code ' + Relay.pretty()],
      ['Audio', Media.statusText()],
      ['Spotify', CH.SpotifySource.statusText()],
      ['Plex', CH.PlexSource.statusText()],
      ['Wake lock', wakeLock ? 'held' : 'not held'],
      ['Version', CFG.VERSION + ' · AGPL-3.0 · github.com/baroquedub/cycle-hud · map data © OpenStreetMap contributors'],
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
    if (document.visibilityState === 'visible') { keepAwake(); if (MapView.enabled) MapView.resume(); }   // geo.js restarts the location watch itself
    else { MapView.stop(); MapView.hiddenAt = CH.clock(); Motion.saveLog(); Motion.saveCal(); }   // hiddenAt: the stale-map rule on resume
  });

  // ------------------------------------------------------------------ boot
  function boot() {
    MapView.init($('map'));
    MapView.zoom = settings.zoom;
    Motion.mode = settings.mapMode;
    store.set('compassVotes', null); store.set('compassSign', null);   // the compass no longer steers the map
    Motion.roadLookup = MapData.roadCandidates;
    Motion.loadLog();
    Motion.loadCal();
    // The compass is read for the debug readout and the ride log only. Try
    // straight away (attaches directly where no permission API exists); where a
    // prompt needs a user gesture the first attempt fails, so ask again on the
    // first key press.
    Compass.request().then((ok) => { if (!ok) document.addEventListener('keydown', () => { Compass.request(); }, { once: true }); });
    buildGauge();
    applyUnits();
    history.replaceState({ s: 'map', d: 0 }, '', location.pathname + location.search + '#map');
    render('map');
    Splash.start();
    tickClock();
    Relay.start();
    Media.setSource(settings.media);
    Loc.watch(onFix);
    keepAwake();
    updateGpsPill(); updateMapPill(); updateDebug();
    if (CH.REPLAY) toast('Replaying a ride log', 3000);
    else if (CH.DEMO) toast('Demo: riding a loop at ' + fmtSpeed(Sim.speed) + ' ' + unitLabel(), 3000);
    console.info('CycleHUD', CFG.VERSION, CH.DEMO ? '[demo]' : '');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
