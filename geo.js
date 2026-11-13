/* Cycle Hub — geo.js
 * Geo maths, the phone-sourced location watch, the demo rider, the compass,
 * and the speed / course fusion that decides how the map rotates.
 * Location + compass handling is adapted from Waypoint (audiojoe4444/waypoint).
 */
(() => {
  'use strict';
  const CH = window.CH;
  const CFG = CH.CONFIG;
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');
  CH.params = params;
  CH.DEMO = DEMO;

  // ------------------------------------------------------------------ maths
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const EARTH = 6371008.8;
  const rad = (d) => d * Math.PI / 180;
  const deg = (r) => r * 180 / Math.PI;

  function haversine(a, b) {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
    const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  // Flat metres (east, north) relative to ref — accurate enough over a few km.
  function project(p, ref) {
    return [rad(p[1] - ref[1]) * Math.cos(rad(ref[0])) * EARTH, rad(p[0] - ref[0]) * EARTH];
  }
  function unproject(xy, ref) {
    return [ref[0] + deg(xy[1] / EARTH), ref[1] + deg(xy[0] / (EARTH * Math.cos(rad(ref[0]))))];
  }
  function angleDiff(a, b) { return ((b - a + 540) % 360) - 180; }
  function angleLerp(a, b, t) { return (a + angleDiff(a, b) * t + 360) % 360; }

  CH.geo = { EARTH, rad, deg, finite, haversine, bearing, project, unproject, angleDiff, angleLerp };

  // ------------------------------------------------------------------ location
  // The glasses' location comes from the phone and can be flaky to start: a
  // request may be refused or go silent even when permission is fine, and a
  // fresh request then works. So we ask once, keep one watch running and
  // quietly restart it (with back-off) whenever it errors or goes quiet.
  const Loc = {
    last: null,        // best fix {lat, lon, accuracy, heading, speed, t}
    lastFixAt: 0,
    watchId: null,
    listeners: new Set(),
    status: { state: 'idle', msg: 'Not started', code: null, at: 0 },
    perm: 'unknown',
    fixes: 0,
    started: false,
    startedAt: 0,
    fails: 0,
    denies: 0,
    firstDenyAt: 0,
    restarts: 0,
    timer: null,
    dead: false,
    lastErr: null,
    onStatus: null,    // app hook

    norm(pos) {
      const c = pos.coords;
      return { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed, t: Date.now() };
    },

    setStatus(state, msg, code = null) {
      Loc.status = { state, msg, code, at: Date.now() };
      if (Loc.onStatus) Loc.onStatus(Loc.status);
    },

    reallyBlocked() { return Loc.denies >= 4 && Date.now() - Loc.firstDenyAt > 20000; },

    onFix(pos) {
      const c = pos && pos.coords;
      if (!c || !finite(c.latitude) || !finite(c.longitude)) return;
      Loc.last = Loc.norm(pos);
      Loc.lastFixAt = Date.now();
      Loc.fixes++;
      Loc.fails = 0; Loc.denies = 0; Loc.firstDenyAt = 0;
      if (Loc.status.state !== 'ok') Loc.setStatus('ok', 'Location found');
      Loc.listeners.forEach((cb) => cb(Loc.last));
      Loc.schedule();
    },

    onError(err) {
      const code = err && err.code;
      if (code === 1) { Loc.denies++; if (!Loc.firstDenyAt) Loc.firstDenyAt = Date.now(); }
      Loc.lastErr = { code, msg: (err && err.message) || '', at: Date.now() };
      if (!Loc.fresh(30000)) {
        if (code === 1 && Loc.reallyBlocked()) Loc.setStatus('denied', Loc.errorText(err), code);
        else Loc.setStatus('searching', 'Looking for your location…', code);
      }
      Loc.dead = true;
      Loc.schedule(code === 1 ? (Loc.denies <= 2 ? 700 : 2000) : 2500);
    },

    errorText(err) {
      if (!err) return 'Location unavailable.';
      if (err.code === 1) return 'Location is blocked. On your phone: Meta AI app → Location → Always, Precise on.';
      if (err.code === 3) return 'Still looking for your location…';
      return 'Can’t get your location right now. Is your phone connected?';
    },

    clearWatch() {
      if (Loc.watchId != null) { try { navigator.geolocation.clearWatch(Loc.watchId); } catch { /* ignore */ } }
      Loc.watchId = null;
    },

    startWatch() {
      Loc.clearWatch();
      Loc.restarts++;
      Loc.dead = false;
      Loc.startedAt = Date.now();
      try { Loc.watchId = navigator.geolocation.watchPosition(Loc.onFix, Loc.onError, { enableHighAccuracy: true }); }
      catch (e) { Loc.onError({ code: 2, message: e.message }); return; }
      if (Loc.fails % 2 === 1) { try { navigator.geolocation.getCurrentPosition(Loc.onFix, () => {}, { timeout: 10000 }); } catch { /* ignore */ } }
      Loc.schedule();
    },

    schedule(delay) {
      clearTimeout(Loc.timer);
      if (delay == null) delay = Loc.fresh(30000) ? 15000 : Math.min(15000, 3000 * Math.pow(1.6, Loc.fails));
      Loc.timer = setTimeout(Loc.check, delay);
    },

    check() {
      if (document.visibilityState === 'hidden') { Loc.schedule(5000); return; }
      const quietFor = Date.now() - Math.max(Loc.lastFixAt, Loc.startedAt);
      const needRestart = !Loc.fresh(30000) && (Loc.dead || quietFor > 2500 || Loc.watchId == null);
      if (needRestart) { Loc.fails++; Loc.startWatch(); }
      else Loc.schedule();
    },

    start() {
      if (DEMO || Loc.started) return;
      Loc.started = true;
      if (!('geolocation' in navigator)) { Loc.setStatus('unsupported', 'This browser has no location support.'); return; }
      Loc.setStatus('searching', 'Looking for your location…');
      let begun = false;
      const begin = () => { if (!begun) { begun = true; Loc.startWatch(); } };
      try {
        navigator.geolocation.getCurrentPosition((p) => { Loc.onFix(p); begin(); }, (e) => { Loc.onError(e); begin(); }, { timeout: 15000 });
      } catch { begin(); }
      setTimeout(begin, 4000);
      Loc.checkPermission();
    },

    restart() {
      if (DEMO) return;
      Loc.fails = 0; Loc.denies = 0; Loc.firstDenyAt = 0;
      Loc.started ? Loc.startWatch() : Loc.start();
    },

    async checkPermission() {
      try {
        if (!navigator.permissions || !navigator.permissions.query) return;
        const p = await navigator.permissions.query({ name: 'geolocation' });
        Loc.perm = p.state;
        p.onchange = () => { Loc.perm = p.state; if (p.state === 'granted') Loc.restart(); };
      } catch { /* not supported */ }
    },

    fresh(maxAge = 60000) { return Loc.last && Date.now() - Loc.last.t < maxAge ? Loc.last : null; },

    watch(cb) {
      Loc.listeners.add(cb);
      if (DEMO) Sim.start();
      else Loc.start();
    },
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !DEMO && Loc.started && !Loc.fresh(30000)) { Loc.fails = 0; Loc.startWatch(); }
  });

  CH.Loc = Loc;

  // ------------------------------------------------------------------ demo rider
  // ?demo rides a loop of about 2 km around ?start=LAT,LON (default Trafalgar
  // Square) at ?speed= metres per second (default 7 ≈ 25 km/h), pausing for a
  // few seconds at one corner so the "held course" behaviour can be seen.
  const Sim = {
    start0: (() => {
      const s = (params.get('start') || '').split(',').map(Number);
      return (s.length === 2 && s.every(finite)) ? s : [51.50797, -0.12804];
    })(),
    speed: (() => { const v = Number(params.get('speed')); return finite(v) && v > 0 ? v : 7; })(),
    // loop corners in metres east/north of the start
    corners: [[0, 0], [450, 0], [450, 320], [150, 320], [150, 140], [-250, 140], [-250, -140], [0, -140]],
    path: [], cum: [], total: 0, along: 0, timer: null, pauseUntil: 0, pausedAtLap: -1, lap: 0,

    build() {
      const pts = Sim.corners.concat([Sim.corners[0]]).map((xy) => unproject(xy, Sim.start0));
      Sim.path = pts; Sim.cum = [0];
      for (let i = 1; i < pts.length; i++) Sim.cum[i] = Sim.cum[i - 1] + haversine(pts[i - 1], pts[i]);
      Sim.total = Sim.cum[Sim.cum.length - 1];
    },
    pointAt(d) {
      d = ((d % Sim.total) + Sim.total) % Sim.total;
      let i = 1; while (i < Sim.cum.length - 1 && Sim.cum[i] < d) i++;
      const a = Sim.path[i - 1], b = Sim.path[i];
      const t = (d - Sim.cum[i - 1]) / Math.max(1e-6, Sim.cum[i] - Sim.cum[i - 1]);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    },
    start() {
      if (Sim.timer) return;
      if (!Sim.path.length) Sim.build();
      Sim.timer = setInterval(Sim.tick, 1000);
      Sim.tick();
    },
    tick() {
      const now = Date.now();
      const lap = Math.floor(Sim.along / Sim.total);
      // pause for 6 s just after the 3rd corner, once per lap
      if (Sim.pausedAtLap !== lap && Sim.along % Sim.total >= Sim.cum[3] + 20) { Sim.pausedAtLap = lap; Sim.pauseUntil = now + 6000; }
      const stopped = now < Sim.pauseUntil;
      if (!stopped) Sim.along += Sim.speed;
      const p = Sim.pointAt(Sim.along), ahead = Sim.pointAt(Sim.along + 5);
      // &noheading drops the heading and speed fields, like fixes relayed from
      // the phone can, so the derived course / speed paths can be tested.
      const bare = params.has('noheading');
      const fix = {
        lat: p[0], lon: p[1], accuracy: 8,
        heading: stopped || bare ? null : bearing(p, ahead),
        speed: bare ? null : stopped ? 0 : Sim.speed * (0.95 + Math.random() * 0.1),
        t: now,
      };
      Loc.last = fix; Loc.lastFixAt = now; Loc.fixes++;
      if (Loc.status.state !== 'ok') Loc.setStatus('ok', 'Demo location');
      Loc.listeners.forEach((cb) => cb(fix));
    },
    stop() { clearInterval(Sim.timer); Sim.timer = null; },
  };
  CH.Sim = Sim;

  // ------------------------------------------------------------------ compass (opt-in map mode)
  const Compass = {
    value: null, at: 0, attached: false,
    async request() {
      try {
        const O = window.DeviceOrientationEvent, M = window.DeviceMotionEvent;
        const owner = (O && typeof O.requestPermission === 'function') ? O
          : (M && typeof M.requestPermission === 'function') ? M : null;
        if (owner) {
          const state = await Promise.race([owner.requestPermission(), new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
          if (state !== 'granted') return false;
        }
        Compass.attach();
        return true;
      } catch (e) { console.warn('sensor permission', e); return false; }
    },
    attach() {
      if (Compass.attached) return;
      Compass.attached = true;
      if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', Compass.onEvent);
      window.addEventListener('deviceorientation', Compass.onEvent);
    },
    detach() {
      window.removeEventListener('deviceorientationabsolute', Compass.onEvent);
      window.removeEventListener('deviceorientation', Compass.onEvent);
      Compass.attached = false;
      Compass.value = null;
    },
    onEvent(e) {
      let h = null;
      if (finite(e.webkitCompassHeading)) h = e.webkitCompassHeading;
      else if ((e.absolute === true || e.type === 'deviceorientationabsolute') && finite(e.alpha)) h = (360 - e.alpha) % 360;
      if (h == null) return;
      Compass.value = Compass.value == null ? h : angleLerp(Compass.value, h, 0.25);
      Compass.at = Date.now();
      if (Compass.onChange) Compass.onChange();
    },
    fresh() { return Compass.value != null && Date.now() - Compass.at < 2500 ? Compass.value : null; },
    onChange: null,
  };
  CH.Compass = Compass;

  // ------------------------------------------------------------------ motion fusion
  // Speed: GPS speed when the phone gives one, else distance/time between
  // fixes, smoothed. Course: GPS course while moving, held while stopped
  // (so the map doesn't swing when you look around), compass only if chosen.
  const Motion = {
    mode: 'auto',          // 'auto' (facing up), 'north', 'compass'
    speed: 0,              // m/s, smoothed
    speedAt: 0,
    slowCount: 0,
    prev: null,            // previous fix used for derived speed
    course: null,          // target course (deg) or null before the first one
    courseSrc: 'none',     // 'gps' | 'derived' | 'held' | 'compass' | 'none'
    anchor: null,          // fix the derived course is measured from
    derived: null,         // { v: bearing, t } from our own movement
    state: 'NONE',         // NONE | MOVING | HELD
    displayed: null,       // smoothed heading used for the rotation
    lastStep: 0,

    onFix(f) {
      // --- speed
      let raw = null;
      if (finite(f.speed) && f.speed >= 0) raw = f.speed;
      else if (Motion.prev) {
        const dt = (f.t - Motion.prev.t) / 1000;
        if (dt >= 0.5 && dt <= 10 && f.accuracy < 50 && Motion.prev.accuracy < 50) {
          raw = haversine([Motion.prev.lat, Motion.prev.lon], [f.lat, f.lon]) / dt;
        }
      }
      Motion.prev = f;
      if (raw != null && raw <= 25) {
        Motion.speed += 0.4 * (raw - Motion.speed);
        if (raw < 0.5) { if (++Motion.slowCount >= 2) Motion.speed = 0; } else Motion.slowCount = 0;
        Motion.speedAt = f.t;
      }
      // --- course
      // GPS course when the fix carries one; otherwise the bearing of our own
      // movement since an anchor fix (the glasses' phone-relayed fixes can
      // arrive without a heading field). The anchor advances once we've moved
      // further than the position noise.
      let heading = null, src = 'gps';
      if (finite(f.heading) && f.heading >= 0 && f.accuracy < 50) { heading = f.heading; Motion.anchor = f; }
      else {
        const a = Motion.anchor;
        if (!a || !finite(f.accuracy) || !finite(a.accuracy)) Motion.anchor = f;
        else {
          const moved = haversine([a.lat, a.lon], [f.lat, f.lon]);
          const need = Math.max(8, Math.min(40, 0.6 * Math.max(f.accuracy, a.accuracy)));
          if (moved >= need && f.accuracy < 100) { Motion.derived = { v: bearing([a.lat, a.lon], [f.lat, f.lon]), t: f.t }; Motion.anchor = f; }
          else if (f.t - a.t > 20000) Motion.anchor = f;
        }
        if (Motion.derived && f.t - Motion.derived.t < 10000) { heading = Motion.derived.v; src = 'derived'; }
      }
      const hasHeading = heading != null;
      if (Motion.state === 'MOVING') {
        if (Motion.speed < 1.0 || !hasHeading) { Motion.state = 'HELD'; Motion.courseSrc = Motion.course == null ? 'none' : 'held'; }
      } else if (Motion.speed >= 1.5 && hasHeading) {
        Motion.state = 'MOVING';
      }
      if (Motion.state === 'MOVING') { Motion.course = heading; Motion.courseSrc = src; }
    },

    // Course used to centre the next map box ahead of you (null when unknown).
    lookahead() { return Motion.course; },

    // Heading the map should rotate to right now; null = north up.
    target() {
      if (Motion.mode === 'north') return null;
      if (Motion.mode === 'compass') {
        const c = Compass.fresh();
        if (c != null) { Motion.courseSrc = 'compass'; return c; }
      }
      return Motion.course;
    },

    // Advance the smoothed heading. Returns true when settled.
    step(now) {
      const t = Motion.target();
      if (t == null) { Motion.displayed = null; Motion.lastStep = now; return true; }
      if (Motion.displayed == null) { Motion.displayed = t; Motion.lastStep = now; return true; }
      const dt = Math.min(0.5, Math.max(0, (now - Motion.lastStep) / 1000));
      Motion.lastStep = now;
      const d = Math.abs(angleDiff(Motion.displayed, t));
      const tau = d > 30 ? 0.3 : 0.6;
      Motion.displayed = angleLerp(Motion.displayed, t, 1 - Math.exp(-dt / tau));
      return Math.abs(angleDiff(Motion.displayed, t)) < 0.5;
    },

    speedStale(ms = 5000) { return !Motion.speedAt || Date.now() - Motion.speedAt > ms; },
  };
  CH.Motion = Motion;
})();
