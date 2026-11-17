/* Cycle Hub — geo.js
 * Geo maths, the phone-sourced location watch, the demo rider and ride
 * replay, the compass (shown for reference only) and Motion: the estimator
 * that turns the rider's own track into the heading the map rotates to.
 * Location + compass handling is adapted from Waypoint (audiojoe4444/waypoint).
 */
(() => {
  'use strict';
  const CH = window.CH;
  const CFG = CH.CONFIG;
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');
  const REPLAY = params.get('replay') || '';
  const SIM = DEMO || !!REPLAY;       // fixes come from this file, not from the phone
  CH.params = params;
  CH.DEMO = SIM;
  CH.REPLAY = REPLAY;

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

  // The app's clock for fixes, timers and ages. Real time normally; during a
  // replay it runs in the ride's own time (at &rate= speed) so every timing
  // rule behaves as it did on the road.
  CH.clock = () => Date.now();

  // Shared fetch with a deadline: a request that never answers (the phone's
  // connection dropping while the display is off) must not hang a poll loop.
  CH.fetchTimeout = function (url, opts, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return fetch(url, Object.assign({ signal: ctl.signal }, opts)).finally(() => clearTimeout(t));
  };

  // ------------------------------------------------------------------ location
  // The glasses' location comes from the phone and can be flaky to start: a
  // request may be refused or go silent even when permission is fine, and a
  // fresh request then works. So we ask once, keep one watch running and
  // quietly restart it (with back-off) whenever it errors or goes quiet.
  const Loc = {
    last: null,        // best fix {lat, lon, accuracy, heading, speed, t, ts}
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
      // t = when we received it (what staleness keys on); ts = the position's own timestamp (what the track keys on)
      return { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed, t: CH.clock(), ts: finite(pos.timestamp) ? pos.timestamp : null };
    },

    setStatus(state, msg, code = null) {
      Loc.status = { state, msg, code, at: CH.clock() };
      if (Loc.onStatus) Loc.onStatus(Loc.status);
    },

    reallyBlocked() { return Loc.denies >= 4 && CH.clock() - Loc.firstDenyAt > 20000; },

    onFix(pos) {
      const c = pos && pos.coords;
      if (!c || !finite(c.latitude) || !finite(c.longitude)) return;
      Loc.last = Loc.norm(pos);
      Loc.lastFixAt = CH.clock();
      Loc.fixes++;
      Loc.fails = 0; Loc.denies = 0; Loc.firstDenyAt = 0;
      if (Loc.status.state !== 'ok') Loc.setStatus('ok', 'Location found');
      Loc.listeners.forEach((cb) => cb(Loc.last));
      Loc.schedule();
    },

    onError(err) {
      const code = err && err.code;
      if (code === 1) { Loc.denies++; if (!Loc.firstDenyAt) Loc.firstDenyAt = CH.clock(); }
      Loc.lastErr = { code, msg: (err && err.message) || '', at: CH.clock() };
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
      Loc.startedAt = CH.clock();
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
      const quietFor = CH.clock() - Math.max(Loc.lastFixAt, Loc.startedAt);
      const needRestart = !Loc.fresh(30000) && (Loc.dead || quietFor > 2500 || Loc.watchId == null);
      if (needRestart) { Loc.fails++; Loc.startWatch(); }
      else Loc.schedule();
    },

    start() {
      if (SIM || Loc.started) return;
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

    // Back from a long absence (display off, dash view): make sure a fix is on its way.
    refresh() {
      if (SIM || !Loc.started || Loc.fresh(30000)) return;
      Loc.fails = 0;
      Loc.startWatch();
    },

    restart() {
      if (SIM) return;
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

    fresh(maxAge = 60000) { return Loc.last && CH.clock() - Loc.last.t < maxAge ? Loc.last : null; },

    watch(cb) {
      Loc.listeners.add(cb);
      if (DEMO) Sim.start();
      else if (REPLAY) Replay.start();
      else Loc.start();
    },

    // Used by the simulators: hand a fix to the app as if the phone sent it.
    inject(fix) {
      Loc.last = fix; Loc.lastFixAt = CH.clock(); Loc.fixes++;
      if (Loc.status.state !== 'ok') Loc.setStatus('ok', DEMO ? 'Demo location' : 'Replaying');
      Loc.listeners.forEach((cb) => cb(fix));
    },
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !SIM && Loc.started && !Loc.fresh(30000)) { Loc.fails = 0; Loc.startWatch(); }
  });

  CH.Loc = Loc;

  // ------------------------------------------------------------------ demo rider
  // ?demo rides a loop of about 2.3 km around ?start=LAT,LON (default Trafalgar
  // Square) at ?speed= metres per second (default 7 ≈ 25 km/h), pausing for a
  // few seconds (&pause=N) at one corner so the "held course" behaviour can be seen.
  // Degradations, to test the heading against what a phone can do to a fix
  // stream: &noheading (no heading/speed fields, like the glasses) &sparse=N
  // (a new position only every N s, the same one repeated in between) &noise=M
  // (M metres of position noise) &late (every 7th position arrives after the
  // one that follows it) &nots (no position timestamps) &jump (one fix per lap
  // is 60 m off to the side). Every fix carries the true heading as _true for
  // the harness to score against (null while paused).
  const num = (k, d) => { const v = Number(params.get(k)); return finite(v) && v > 0 ? v : d; };
  const Sim = {
    start0: (() => {
      const s = (params.get('start') || '').split(',').map(Number);
      return (s.length === 2 && s.every(finite)) ? s : [51.50797, -0.12804];
    })(),
    speed: num('speed', 7),
    sparse: Math.round(num('sparse', 0)),
    noise: num('noise', 0),
    late: params.has('late'),
    nots: params.has('nots'),
    jump: params.has('jump'),
    bare: params.has('noheading'),
    pauseMs: num('pause', 6) * 1000,   // &pause=N seconds stopped after the 3rd corner
    // loop corners in metres east/north of the start
    corners: [[0, 0], [450, 0], [450, 320], [150, 320], [150, 140], [-250, 140], [-250, -140], [0, -140]],
    path: [], cum: [], total: 0, along: 0, timer: null, pauseUntil: 0, pausedAtLap: -1, lap: 0,
    n: 0, lastEmit: null, held: null, jumpedLap: -1,

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
    gauss() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); },
    start() {
      if (Sim.timer) return;
      if (!Sim.path.length) Sim.build();
      Sim.timer = setInterval(Sim.tick, 1000);
      Sim.tick();
    },
    tick() {
      const now = CH.clock();
      Sim.n++;
      const lap = Math.floor(Sim.along / Sim.total);
      // pause for 6 s just after the 3rd corner, once per lap
      if (Sim.pausedAtLap !== lap && Sim.along % Sim.total >= Sim.cum[3] + 20) { Sim.pausedAtLap = lap; Sim.pauseUntil = now + Sim.pauseMs; }
      const stopped = now < Sim.pauseUntil;
      if (!stopped) Sim.along += Sim.speed;
      let p = Sim.pointAt(Sim.along);
      const ahead = Sim.pointAt(Sim.along + 5);
      const trueHdg = stopped ? null : bearing(p, ahead);
      let fix;
      if (Sim.sparse > 1 && Sim.lastEmit && Sim.n % Sim.sparse !== 0) {
        fix = Object.assign({}, Sim.lastEmit, { t: now, _true: trueHdg });     // the phone's provider hasn't updated: same position again
      } else {
        let acc = 8;
        if (Sim.noise) { const xy = project(p, Sim.start0); xy[0] += Sim.gauss() * Sim.noise; xy[1] += Sim.gauss() * Sim.noise; p = unproject(xy, Sim.start0); acc = Math.max(8, Sim.noise); }
        if (Sim.jump && Sim.jumpedLap !== lap && Sim.along % Sim.total >= Sim.cum[5] + 30) { Sim.jumpedLap = lap; const xy = project(p, Sim.start0); xy[0] += 60; p = unproject(xy, Sim.start0); }
        fix = {
          lat: p[0], lon: p[1], accuracy: acc,
          heading: stopped || Sim.bare ? null : trueHdg,
          speed: Sim.bare ? null : stopped ? 0 : Sim.speed * (0.95 + Math.random() * 0.1),
          t: now, ts: Sim.nots ? null : now, _true: trueHdg,
        };
        Sim.lastEmit = fix;
      }
      const out = [];
      if (Sim.late && fix === Sim.lastEmit && Sim.n % 7 === 0) Sim.held = fix;    // delivered after the next one
      else out.push(fix);
      if (Sim.held && Sim.held !== fix) { out.push(Object.assign({}, Sim.held, { t: now })); Sim.held = null; }
      out.forEach((f) => Loc.inject(f));
    },
    stop() { clearInterval(Sim.timer); Sim.timer = null; },
  };
  CH.Sim = Sim;

  // ------------------------------------------------------------------ ride replay
  // ?replay=URL plays a ride log (Status -> Send ride log, downloaded from
  // pair.html) back through the app at &rate= times real time, so what the
  // glasses saw can be reproduced in a desktop browser or the harness.
  const Replay = {
    fixes: [], i: 0, timer: null, t0: 0, start0: 0, shift: 0, rate: num('rate', 1), done: false,
    async start() {
      if (Replay.fixes.length || Replay.timer) return;
      try {
        const res = await fetch(REPLAY, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        const rows = Array.isArray(j) ? j : (j && j.fixes) || [];
        Replay.fixes = rows.filter((r) => Array.isArray(r) && finite(r[0]) && finite(r[2]) && finite(r[3]));
      } catch (e) { console.warn('replay', e); Loc.setStatus('error', 'Replay failed: ' + e.message); return; }
      if (!Replay.fixes.length) { Loc.setStatus('error', 'Replay: no fixes in the file'); return; }
      Replay.t0 = Replay.fixes[0][0]; Replay.start0 = Date.now();
      // the app's clock carries on from now at `rate` x; the ride's times are shifted to match
      Replay.shift = Replay.start0 - Replay.t0;
      CH.clock = () => Replay.start0 + (Date.now() - Replay.start0) * Replay.rate;
      console.info('replay', Replay.fixes.length, 'fixes at', Replay.rate + 'x');
      Replay.next();
    },
    next() {
      const r = Replay.fixes[Replay.i];
      if (!r) { Replay.done = true; Replay.timer = null; Loc.setStatus('ok', 'Replay finished'); return; }
      const due = Replay.start0 + (r[0] - Replay.t0) / Replay.rate;   // real time
      Replay.timer = setTimeout(() => {
        if (finite(r[7])) Compass.onEvent({ type: 'deviceorientationabsolute', absolute: true, alpha: (360 - r[7]) % 360 });   // the logged compass reading
        Loc.inject({
          lat: r[2], lon: r[3], accuracy: finite(r[4]) ? r[4] : 20,
          heading: finite(r[5]) ? r[5] : null, speed: finite(r[6]) ? r[6] : null,
          t: r[0] + Replay.shift, ts: finite(r[1]) ? r[1] + Replay.shift : null, _true: finite(r[12]) ? r[12] : null,
        });
        Replay.i++;
        Replay.next();
      }, Math.max(0, due - Date.now()));   // real time   // real time
    },
  };
  CH.Replay = Replay;

  // ------------------------------------------------------------------ compass (head direction)
  // The glasses' compass is on your head, not the bike, and on this device it
  // runs the wrong way round. It never steers the map while moving; Motion
  // calibrates it against the track (sign + offset) and then uses it only
  // before the first movement and while stopped (see Motion.atRest).
  const Compass = {
    value: null, at: 0, attached: false,
    raw: null, rawAt: 0, rate: 0,     // deg/s the raw reading is turning, smoothed
    movedAt: 0,                       // last time it was swinging (a head turn in progress)
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
      const now = CH.clock();
      if (Compass.raw != null && now - Compass.rawAt > 20 && now - Compass.rawAt < 1000) {
        const r = angleDiff(Compass.raw, h) / ((now - Compass.rawAt) / 1000);
        Compass.rate += 0.3 * (r - Compass.rate);
      } else if (now - Compass.rawAt >= 1000) Compass.rate = 0;
      Compass.raw = h; Compass.rawAt = now;
      if (Math.abs(Compass.rate) > 25) Compass.movedAt = now;
      Compass.value = Compass.value == null ? h : angleLerp(Compass.value, h, 0.25);
      Compass.at = now;
      if (Compass.onChange) Compass.onChange();
    },
    fresh() { return Compass.value != null && CH.clock() - Compass.at < 2500 ? Compass.value : null; },
    steady() { return Compass.fresh() != null && CH.clock() - Compass.movedAt > CFG.HEAD_STEADY_MS; },
    onChange: null,
  };
  CH.Compass = Compass;

  // ------------------------------------------------------------------ motion: the track is the heading
  // First principles. In Facing up the map must be rotated so that the rider's
  // own recent movement points up the screen (the roads flow down past the
  // marker). So the heading IS that movement: the bearing from the fix a
  // baseline behind us to the newest fix, refined to the exact bearing of the
  // road the movement runs along. Nothing else may rotate the map, and nothing
  // may freeze it while the position is visibly moving. The compass (on the
  // head, and mirrored on this device) plays no part.
  //
  // The fix stream from the phone is cleaned first: repeated positions are
  // ignored (they say nothing new), fixes are ordered by their own timestamp
  // when it is believable, a late one is dropped, and a position jump is only
  // believed when the next fix agrees with it. A heading is only started from
  // rest when two consecutive track bearings agree, so a jolt in the position
  // while waiting at a light doesn't spin the map; once moving, each fix that
  // completes a baseline updates it. Moving less than a baseline in
  // TRACK_WINDOW_MS means we've stopped: the heading is held.
  const Motion = {
    mode: 'auto',          // 'auto' (facing up: map rotates) | 'north' (arrow rotates)
    pts: [],               // accepted track points { x, y, lat, lon, acc, time, t } in position-time order
    lastPos: null,
    lastFixAt: 0,
    origin: null,          // flat projection reference for the track
    quarantine: null,      // a point that implied an impossible jump, waiting for the next fix to confirm it
    tsTrust: true,         // position timestamps order the track until they prove useless
    lateRun: 0,
    raw: null,             // bearing of the track (deg) or null
    rawAt: 0,              // position time it was measured at
    rawSrc: 'none',        // 'track' | 'gps'
    base: 0,               // baseline used (m)
    jitter: 0,             // median scatter of the fixes about a smooth path (m)
    pendingRaw: null,      // first bearing after a standstill, awaiting agreement
    moving: false,
    course: null,          // the heading: track bearing refined to the road (deg) or null
    courseSrc: 'none',     // 'road' | 'track' | 'gps' | 'held' | 'none'
    courseAt: 0,
    recentCourses: [],     // last three headings, for a steady value to hold when stopping
    road: null,            // { bearing, dist, cls, off } of the road giving the heading, or null
    roadLookup: null,      // (lat, lon, radius) => [{ axis, dist, cls }] — set by app.js
    speed: 0,              // m/s, smoothed
    speedAt: 0,
    heading: null,         // = course (kept for the status screen)
    displayed: null,       // smoothed heading used for the rotation
    lastStep: 0,
    sidewaysRun: 0,
    // compass calibration against the track: heading ~ sign * compass + offset.
    // pos/neg = [sum cos, sum sin, weight] of the residual for each sign, decayed
    cal: { pos: [0, 0, 0], neg: [0, 0, 0], sign: 1, offset: 0, conc: 0, w: 0, n: 0 },
    calSavedAt: 0,
    restNow: false,        // this fix found us at rest (no progress)
    stillRun: 0,           // consecutive fixes without progress
    restSince: 0,
    diag: { fixes: 0, accepted: 0, repeats: 0, late: 0, jumps: 0, noTs: 0, badAcc: 0, sideways: 0, tsOff: false },
    intervals: [],         // ms between accepted positions (last 60)
    lags: [],              // receipt time minus position time (last 60)
    log: [], logDirty: false, logSavedAt: 0,

    // Position time when the fix has a believable one, else receipt time.
    time(f) {
      if (!Motion.tsTrust || !finite(f.ts)) return f.t;
      if (Math.abs(f.ts - f.t) > CFG.TRACK_TS_SANE_MS) return f.t;
      return f.ts;
    },

    onFix(f) {
      const D = Motion.diag;
      D.fixes++;
      Motion.lastFixAt = f.t;
      if (!finite(f.ts)) D.noTs++;
      else { Motion.lags.push(f.t - f.ts); if (Motion.lags.length > 60) Motion.lags.shift(); }
      const gpsSpeed = finite(f.speed) && f.speed >= 0 && f.speed <= 25 ? f.speed : null;
      const acc = finite(f.accuracy) ? f.accuracy : 50;
      const last = Motion.lastPos;
      let flag = 'ok', accepted = false;
      if (last && Math.abs(f.lat - last.lat) < 1e-7 && Math.abs(f.lon - last.lon) < 1e-7) {
        // the phone sent the same position again: nothing new about where we are
        D.repeats++; flag = 'rep';
        if (gpsSpeed != null) { Motion.speed += 0.5 * (gpsSpeed - Motion.speed); Motion.speedAt = f.t; }
        else if (f.t - last.t > CFG.TRACK_REPEAT_STOP_MS) { Motion.speed = 0; Motion.speedAt = f.t; }
        if (Motion.moving && f.t - last.t > CFG.TRACK_WINDOW_MS) Motion.hold();
      } else if (acc > CFG.TRACK_MAX_ACC_M) {
        D.badAcc++; flag = 'acc';
      } else {
        let time = Motion.time(f);
        if (last && time <= last.time) {
          // moved, yet dated before the last point: a late delivery (dropped). Three in a row
          // means the timestamps aren't position times at all: restart on receipt times.
          D.late++; flag = 'late';
          if (++Motion.lateRun >= 3 && Motion.tsTrust) { Motion.tsTrust = false; D.tsOff = true; Motion.resetTrack(); time = f.t; }
        } else Motion.lateRun = 0;
        if (!Motion.lastPos || time > Motion.lastPos.time) {
          accepted = Motion.accept(f, time, acc);
          flag = accepted ? 'ok' : 'jump';
        }
      }
      Motion.restNow = !accepted || flag === 'rep';
      if (accepted) Motion.update(f, gpsSpeed);
      if (Motion.restNow) Motion.atRest(f); else Motion.restSince = 0;
      Motion.record(f, flag);
    },

    // Before the first movement (app just opened, standing with the bike): the
    // head direction orients the map, once the compass has proved itself
    // against the track on an earlier ride, with a deadband so glances don't
    // twitch it. Not at stops mid-ride: the ride log showed the head at a
    // light looks at traffic, not where the bike goes next (it matched the
    // departure at 2 stops of 6 and was 40 deg off at another), while the
    // approach heading is where the bike is pointing. Never while moving.
    atRest(f) {
      if (!Motion.restSince) Motion.restSince = f.t;
      if (Motion.course != null && Motion.courseSrc !== 'head') return;
      const h = Motion.headHeading();
      if (h == null || !Compass.steady()) return;
      if (Motion.course == null || Math.abs(angleDiff(Motion.course, h)) > CFG.HEAD_DEADBAND_DEG) { Motion.course = Motion.heading = h; Motion.courseSrc = 'head'; Motion.courseAt = f.t; }
    },

    // Learn how the compass relates to the track while moving. Each sample
    // votes for both signs; the sign whose residuals cluster tighter wins, and
    // the cluster's direction is the offset. Decayed so it follows slow drift.
    learnCompass(raw, f) {
      const c = Compass.fresh();
      if (c == null || Math.abs(Compass.rate) > 25) return;      // a swinging head is not a sample
      const cal = Motion.cal, k = CFG.COMPASS_CAL_DECAY;
      for (const [key, sign] of [['pos', 1], ['neg', -1]]) {
        const a = cal[key], d = rad(raw - sign * c);
        a[0] = a[0] * k + Math.cos(d); a[1] = a[1] * k + Math.sin(d); a[2] = a[2] * k + 1;
      }
      cal.n++;
      Motion.refreshCal();
      if (f.t - Motion.calSavedAt > 30000) Motion.saveCal();
    },
    refreshCal() {
      const cal = Motion.cal;
      const pc = Math.hypot(cal.pos[0], cal.pos[1]) / Math.max(1e-9, cal.pos[2]);
      const nc = Math.hypot(cal.neg[0], cal.neg[1]) / Math.max(1e-9, cal.neg[2]);
      const [key, sign, conc] = pc >= nc ? ['pos', 1, pc] : ['neg', -1, nc];
      cal.sign = sign; cal.conc = conc; cal.w = cal[key][2];
      cal.offset = (deg(Math.atan2(cal[key][1], cal[key][0])) + 360) % 360;
    },
    compassCalibrated() { return Motion.cal.w >= CFG.COMPASS_CAL_MIN_N && Motion.cal.conc >= CFG.COMPASS_CAL_MIN_CONC; },
    // The head direction as a map heading, or null until the compass has proved itself.
    headHeading() {
      const c = Compass.fresh();
      if (c == null || !Motion.compassCalibrated()) return null;
      return (Motion.cal.sign * c + Motion.cal.offset + 720) % 360;
    },
    saveCal() {
      Motion.calSavedAt = CH.clock();
      if (CH.store && !SIM) CH.store.set('compassCal', { pos: Motion.cal.pos, neg: Motion.cal.neg, n: Motion.cal.n });
    },
    loadCal() {
      const c = CH.store && CH.store.get('compassCal', null);
      if (!c || !Array.isArray(c.pos) || !Array.isArray(c.neg) || c.pos.length !== 3 || c.neg.length !== 3) return;
      Motion.cal.pos = c.pos.map(Number); Motion.cal.neg = c.neg.map(Number); Motion.cal.n = Number(c.n) || 0;
      Motion.refreshCal();
    },

    resetTrack() { Motion.pts = []; Motion.lastPos = null; Motion.quarantine = null; Motion.raw = null; Motion.pendingRaw = null; if (Motion.moving) Motion.hold(); },

    hold() { Motion.moving = false; Motion.pendingRaw = null; Motion.road = null; Motion.recentCourses = []; Motion.courseSrc = Motion.course == null ? 'none' : 'held'; },

    // Add a fix to the track unless it implies an impossible jump. Returns true when accepted.
    accept(f, time, acc) {
      if (!Motion.origin) Motion.origin = [f.lat, f.lon];
      const [x, y] = project([f.lat, f.lon], Motion.origin);
      const p = { x, y, lat: f.lat, lon: f.lon, acc, time, t: f.t };
      const last = Motion.lastPos;
      if (last) {
        const v = Math.hypot(x - last.x, y - last.y) / Math.max(0.5, (time - last.time) / 1000);
        if (v > CFG.TRACK_JUMP_MPS) {
          const q = Motion.quarantine;
          if (q && Math.hypot(x - q.x, y - q.y) / Math.max(0.5, (time - q.time) / 1000) <= CFG.TRACK_JUMP_MPS) {
            // two fixes agree with each other and not with the track: we really are over there
            Motion.diag.jumps++;
            Motion.pts = [q]; Motion.lastPos = q; Motion.quarantine = null;
            Motion.raw = null; Motion.pendingRaw = null; Motion.moving = false;
          } else { Motion.quarantine = p; return false; }
        } else Motion.quarantine = null;
        Motion.intervals.push(time - Motion.lastPos.time); if (Motion.intervals.length > 60) Motion.intervals.shift();
      }
      Motion.pts.push(p); Motion.lastPos = p;
      while (Motion.pts.length > 400 || time - Motion.pts[0].time > CFG.TRACK_KEEP_MS) Motion.pts.shift();
      Motion.diag.accepted++;
      return true;
    },

    update(f, gpsSpeed) {
      const pts = Motion.pts, n = pts.length, p = pts[n - 1];
      // --- jitter: how far the fixes scatter about a smooth path (each point's
      // deviation off the chord between its neighbours, median of the last
      // twenty). Noisy fixes need a longer baseline for the same bearing error,
      // and a bigger displacement before it counts as movement.
      const devs = [];
      for (let i = n - 2; i >= 1 && devs.length < 20; i--) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1];
        const cx = c.x - a.x, cy = c.y - a.y, L = Math.hypot(cx, cy);
        if (L >= 1) devs.push(Math.abs((b.x - a.x) * cy - (b.y - a.y) * cx) / L);
      }
      const jit = Motion.jitter = Math.max(devs.length >= 3 ? Motion.median(devs) : 0, devs.length >= 10 ? 0 : 0.5 * p.acc);   // until well measured, at least the accuracy figure
      // --- progress over the last few seconds: net distance from the newest point
      // at least TRACK_SPEED_MS older. Less than the fix scatter is standing still:
      // the speed reads 0 and the heading is left alone (a jittering position
      // at the near end of the baseline would otherwise nudge it).
      let recent = null, recentDt = 0;
      for (let i = n - 2; i >= 0; i--) {
        const q = pts[i];
        if (p.time - q.time < CFG.TRACK_SPEED_MS) continue;
        recent = Math.hypot(p.x - q.x, p.y - q.y); recentDt = (p.time - q.time) / 1000;
        break;
      }
      // The phone's own speed, when it gives one, says "stopped" straight away.
      const still = (recent != null && recent < Math.max(0.3 * p.acc, CFG.TRACK_STILL_K * jit)) || (gpsSpeed != null && gpsSpeed < CFG.TRACK_STOP_MPS);
      // --- speed: the phone's when it gives one, else that recent progress, and
      // only once movement is established (scatter at rest must never read as speed)
      let spd = gpsSpeed;
      if (spd == null && recent != null) spd = still || !Motion.moving ? 0 : recent / recentDt;
      if (spd != null && spd <= 25) { Motion.speed += 0.5 * (spd - Motion.speed); if (Motion.speed < 0.3) Motion.speed = 0; Motion.speedAt = f.t; }
      if (still) {
        Motion.restNow = true;
        // The first fixes of a stop still complete the track to the stopping
        // point (stopping just after a corner would otherwise freeze the map
        // mid-swing); after that the position only jitters, so the heading is
        // left alone: the steadiest of the last three is kept.
        if (++Motion.stillRun > CFG.TRACK_STILL_FIXES) {
          if (Motion.moving && Motion.recentCourses.length === 3) {
            const r = Motion.recentCourses, cost = (i) => r.reduce((acc, v) => acc + Math.abs(angleDiff(r[i], v)), 0);
            let best = 0; for (let i = 1; i < 3; i++) if (cost(i) < cost(best)) best = i;
            Motion.course = Motion.heading = r[best];
            Motion.recentCourses = [];
          }
          if (Motion.moving && p.time - Motion.rawAt > CFG.TRACK_WINDOW_MS) Motion.hold();
          return;
        }
      } else Motion.stillRun = 0;

      // --- track bearing, always from our own positions. The fix's heading field
      // is never a source: on the glasses it is 0 in every fix (a placeholder,
      // not north), which with a valid speed used to send the map north on every
      // pull-away. It may only confirm the track (see below).
      let raw = null, src = 'track';
      {
        const base = Math.max(CFG.TRACK_BASE_MIN_M, Math.min(CFG.TRACK_BASE_MAX_M, Math.max(CFG.TRACK_BASE_K * p.acc, CFG.TRACK_JITTER_K * jit)));
        Motion.base = base;
        let path = 0, prev = p;
        for (let i = n - 2; i >= 0; i--) {
          const q = pts[i];
          path += Math.hypot(prev.x - q.x, prev.y - q.y); prev = q;
          const d = Math.hypot(p.x - q.x, p.y - q.y);
          if (d < base) continue;
          if (p.time - q.time > CFG.TRACK_WINDOW_MS) break;      // took too long to cover a baseline: standing still
          if (path / d > CFG.TRACK_WIGGLE) break;                // wandered rather than travelled
          raw = (deg(Math.atan2(p.x - q.x, p.y - q.y)) + 360) % 360;
          break;
        }
      }
      if (raw != null && finite(f.heading) && f.heading > 0 && f.heading < 360 && gpsSpeed != null && gpsSpeed >= CFG.TRACK_GPS_COURSE_MPS
          && Math.abs(angleDiff(raw, f.heading)) <= CFG.TRACK_GPS_AGREE_DEG) { raw = f.heading; src = 'gps'; }   // a real course that agrees is less noisy than a chord
      if (raw == null) {
        if (!Motion.moving) Motion.restNow = true;
        if (Motion.moving && p.time - Motion.rawAt > CFG.TRACK_WINDOW_MS) Motion.hold();
        return;
      }
      if (!Motion.moving) {
        // from rest, two bearings in a row must agree before the map turns, unless
        // the phone's own speed already says we're clearly moving
        const sure = gpsSpeed != null && gpsSpeed >= CFG.TRACK_GPS_COURSE_MPS;
        if (!sure && (Motion.pendingRaw == null || Math.abs(angleDiff(Motion.pendingRaw, raw)) > CFG.TRACK_START_DEG)) { Motion.pendingRaw = raw; return; }
        Motion.pendingRaw = null; Motion.moving = true;
      }
      Motion.raw = raw; Motion.rawAt = p.time; Motion.rawSrc = src;
      Motion.learnCompass(raw, f);

      // --- the road this movement runs along gives the exact bearing
      const before = Motion.course;
      let course = raw, csrc = src, road = null;
      if (Motion.roadLookup) {
        const radius = Math.max(CFG.SNAP_RADIUS_M, Math.min(60, 2 * p.acc));
        const cands = Motion.roadLookup(f.lat, f.lon, radius) || [];
        let bestScore = Infinity;
        for (const c of cands) {
          let dir = c.axis;
          if (Math.abs(angleDiff(raw, dir)) > 90) dir = (dir + 180) % 360;   // the way along it that we're going
          const off = Math.abs(angleDiff(raw, dir));
          if (off > CFG.SNAP_MAX_DEG) continue;                              // crossing it, not riding along it
          let score = c.dist + off * CFG.SNAP_DEG_M;
          if (Motion.road && Math.abs(angleDiff(Motion.road.bearing, dir)) < CFG.SNAP_STICK_DEG) score -= CFG.SNAP_STICK_M;
          if (score < bestScore) { bestScore = score; road = { bearing: dir, dist: c.dist, cls: c.cls, off }; }
        }
        if (road) { course = road.bearing; csrc = 'road'; }
      }
      Motion.course = Motion.heading = course; Motion.courseSrc = csrc; Motion.road = road;
      Motion.recentCourses.push(course); if (Motion.recentCourses.length > 3) Motion.recentCourses.shift();
      if (before == null || Math.abs(angleDiff(before, course)) > 10) Motion.courseAt = f.t;

      // --- self-check: the track must point up the drawn map. Two fixes running with it
      // pointing elsewhere means something upstream is wrong: snap to it and count the event.
      if (Motion.displayed != null && Math.abs(angleDiff(Motion.displayed, raw)) > CFG.SIDEWAYS_DEG) {
        if (++Motion.sidewaysRun >= 2) { Motion.diag.sideways++; Motion.displayed = course; Motion.sidewaysRun = 0; }
      } else Motion.sidewaysRun = 0;
    },

    // Advance the smoothed heading (map rotation in Facing up, arrow in North
    // up). Returns true when settled.
    step(now) {
      const t = Motion.course != null ? Motion.course : Motion.headHeading();   // before any fix: the head, if the compass is proven
      if (t == null) { Motion.displayed = null; Motion.lastStep = now; return true; }
      if (Motion.displayed == null) { Motion.displayed = t; Motion.lastStep = now; return true; }
      const dt = Math.min(0.5, Math.max(0, (now - Motion.lastStep) / 1000));
      Motion.lastStep = now;
      const d = Math.abs(angleDiff(Motion.displayed, t));
      const tau = d > 30 ? 0.2 : 0.6;     // turns swing fast; small changes (fix noise) are eased
      Motion.displayed = angleLerp(Motion.displayed, t, 1 - Math.exp(-dt / tau));
      return Math.abs(angleDiff(Motion.displayed, t)) < 0.5;
    },

    speedStale(ms = 5000) { return !Motion.speedAt || CH.clock() - Motion.speedAt > ms; },

    // One line about the fix stream, for the status screen: how often positions
    // change, how many fixes just repeat the last one, how late they arrive, and
    // anything the cleaning had to do.
    median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; },
    diagText() {
      const D = Motion.diag, iv = Motion.median(Motion.intervals), lag = Motion.median(Motion.lags);
      const parts = [iv == null ? 'interval –' : (iv / 1000).toFixed(1) + ' s apart'];
      if (D.fixes) parts.push(Math.round(100 * D.repeats / D.fixes) + '% repeats');
      if (lag != null) parts.push('lag ' + (lag / 1000).toFixed(1) + ' s' + (D.tsOff ? ' (times ignored)' : ''));
      else if (D.noTs) parts.push('no timestamps');
      if (D.late) parts.push(D.late + ' late');
      if (D.jumps) parts.push(D.jumps + ' jump' + (D.jumps > 1 ? 's' : ''));
      if (D.badAcc) parts.push(D.badAcc + ' poor');
      if (D.sideways) parts.push(D.sideways + ' sideways');
      return parts.join(' · ');
    },

    // --- ride log: every fix and what the heading made of it
    LOG_COLS: ['t', 'ts', 'lat', 'lon', 'acc', 'heading', 'speed', 'compass', 'track', 'course', 'map', 'flag', 'true'],
    record(f, flag) {
      const r = (v, d) => finite(v) ? Number(v.toFixed(d)) : null;
      Motion.log.push([f.t, finite(f.ts) ? f.ts : null, r(f.lat, 6), r(f.lon, 6), r(f.accuracy, 0), r(f.heading, 0), r(f.speed, 1),
        r(Compass.fresh(), 0), r(Motion.raw, 0), r(Motion.course, 0), r(Motion.displayed, 0), flag, r(f._true, 0)]);
      if (Motion.log.length > CFG.LOG_MAX) Motion.log.splice(0, Motion.log.length - CFG.LOG_MAX);
      Motion.logDirty = true;
      if (f.t - Motion.logSavedAt > 10000) Motion.saveLog();
    },
    saveLog() {
      Motion.logSavedAt = CH.clock();
      if (!Motion.logDirty || !CH.store || SIM) return;        // simulated rides are not worth keeping
      Motion.logDirty = false;
      CH.store.set('rideLog', { v: 1, app: CFG.VERSION, fixes: Motion.log });
    },
    loadLog() {
      const s = CH.store && CH.store.get('rideLog', null);
      if (!s || s.v !== 1 || !Array.isArray(s.fixes) || !s.fixes.length) return;
      const lastT = s.fixes[s.fixes.length - 1][0];
      if (finite(lastT) && CH.clock() - lastT < CFG.LOG_RESUME_MS) Motion.log = s.fixes;
    },
    exportLog() {
      return JSON.stringify({ v: 1, app: CFG.VERSION, ua: navigator.userAgent, exported: new Date().toISOString(), cols: Motion.LOG_COLS, diag: Motion.diag, fixes: Motion.log });
    },
    clearLog() { Motion.log = []; Motion.logDirty = true; Motion.saveLog(); },
    calText() {
      const cal = Motion.cal, c = Compass.fresh();
      if (c == null) return Compass.attached ? 'no data' : 'off';
      const h = Motion.headHeading();
      const how = (cal.sign < 0 ? 'mirrored' : 'direct') + ' ' + (cal.offset <= 180 ? '+' : '-') + Math.round(cal.offset <= 180 ? cal.offset : 360 - cal.offset) + '°, fit ' + cal.conc.toFixed(2) + ', ' + Math.round(cal.w) + ' samples';
      return Math.round(c) + '°' + (h != null ? ' = head ' + Math.round(h) + '° (' + how + ')' : ' (calibrating: ' + how + ')');
    },
  };
  CH.Motion = Motion;
})();
