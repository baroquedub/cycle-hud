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
      // t = when we received it (what the app keys on); ts = the position's own timestamp, for diagnosis
      return { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed, t: Date.now(), ts: finite(pos.timestamp) ? pos.timestamp : null };
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

    // Back from a long absence (display off, dash view): make sure a fix is on its way.
    refresh() {
      if (DEMO || !Loc.started || Loc.fresh(30000)) return;
      Loc.fails = 0;
      Loc.startWatch();
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
    raw: null, rawAt: 0, rate: 0,     // deg/s the raw reading is turning, smoothed
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
      const now = Date.now();
      if (Compass.raw != null && now - Compass.rawAt > 20 && now - Compass.rawAt < 1000) {
        const r = angleDiff(Compass.raw, h) / ((now - Compass.rawAt) / 1000);
        Compass.rate += 0.3 * (r - Compass.rate);
      } else if (now - Compass.rawAt >= 1000) Compass.rate = 0;
      Compass.raw = h; Compass.rawAt = now;
      Compass.value = Compass.value == null ? h : angleLerp(Compass.value, h, 0.25);
      Compass.at = now;
      if (Compass.onChange) Compass.onChange();
    },
    fresh() { return Compass.value != null && Date.now() - Compass.at < 2500 ? Compass.value : null; },
    onChange: null,
  };
  CH.Compass = Compass;

  // ------------------------------------------------------------------ motion fusion
  // Speed: GPS speed when the phone gives one, else distance/time between
  // fixes, smoothed. Course: the direction the bike moves (GPS heading, or the
  // bearing of the track), snapped to the road, held while stopped. Heading:
  // the course, fine-tuned between fixes by the glasses' compass (see fuse()).
  const Motion = {
    mode: 'auto',          // 'auto' (facing up: map rotates) | 'north' (arrow rotates)
    speed: 0,              // m/s, smoothed
    speedAt: 0,
    slowCount: 0,
    prev: null,            // previous fix used for derived speed
    hist: [],              // recent fixes, for the track bearing
    derived: null,         // { v: bearing, t } of the track
    course: null,          // heading of the track, snapped to the road (deg) or null
    courseSrc: 'none',     // 'road' | 'gps' | 'derived' | 'held' | 'none'
    courseAt: 0,
    roadLookup: null,      // (lat, lon, radius, heading) => { bearing, dist } — set by app.js
    road: null,            // last road snap result
    state: 'NONE',         // NONE | MOVING | HELD
    // compass: sign*compass + offset ~ course. sign is learned from turns
    // (votes), offset re-learned at fixes while the compass is steady.
    sign: 1,
    votes: 0,              // +3..-3, persisted; the compass is used once |votes| >= COMPASS_MIN_VOTES
    turnRef: null,         // { course, cmp } at the last course sample, to vote on the next turn
    cmpOffset: null,
    cmpOffsetAt: 0,
    relearn: false,        // the track turned while the head was still swinging: anchor again when it settles
    heading: null,         // fused real-time heading (deg) or null
    displayed: null,       // smoothed heading used for the rotation
    lastStep: 0,

    onFix(f) {
      // --- speed
      let raw = null;
      if (finite(f.speed) && f.speed >= 0) raw = f.speed;
      else if (Motion.prev) {
        const dt = (f.t - Motion.prev.t) / 1000;
        if (dt >= 0.5 && dt <= 30 && f.accuracy < 50 && Motion.prev.accuracy < 50) {   // sparse fixes while stationary still bring the speed down
          raw = haversine([Motion.prev.lat, Motion.prev.lon], [f.lat, f.lon]) / dt;
        }
      }
      Motion.prev = f;
      if (raw != null && raw <= 25) {
        Motion.speed += 0.4 * (raw - Motion.speed);
        if (raw < 0.5) { if (++Motion.slowCount >= 2) Motion.speed = 0; } else Motion.slowCount = 0;
        Motion.speedAt = f.t;
      }
      // --- track bearing
      // GPS course when the fix carries one; otherwise the bearing from the
      // newest earlier fix that is at least `need` metres behind us (a baseline
      // comfortably longer than the position noise), so it swings within a
      // few metres of a turn.
      Motion.hist.push(f);
      while (Motion.hist.length && f.t - Motion.hist[0].t > 20000) Motion.hist.shift();
      let heading = null, src = 'gps';
      if (finite(f.heading) && f.heading >= 0 && f.accuracy < 50) heading = f.heading;
      else {
        const acc = finite(f.accuracy) ? f.accuracy : 20;
        const need = Math.max(10, Math.min(60, 1.2 * acc));
        if (acc < 100) {
          for (let i = Motion.hist.length - 2; i >= 0; i--) {
            const h = Motion.hist[i];
            if (!finite(h.accuracy) || h.accuracy >= 100) continue;
            if (haversine([h.lat, h.lon], [f.lat, f.lon]) >= need) { Motion.derived = { v: bearing([h.lat, h.lon], [f.lat, f.lon]), t: f.t }; break; }
          }
        }
        if (Motion.derived && f.t - Motion.derived.t < 10000) { heading = Motion.derived.v; src = 'derived'; }
      }
      const hasHeading = heading != null;
      if (Motion.state === 'MOVING') {
        if (Motion.speed < 1.0 || !hasHeading) { Motion.state = 'HELD'; Motion.courseSrc = Motion.course == null ? 'none' : 'held'; }
      } else if (Motion.speed >= 1.5 && hasHeading) {
        Motion.state = 'MOVING';
      }
      const before = Motion.course;
      if (Motion.state === 'MOVING') {
        Motion.course = heading; Motion.courseSrc = src;
        // Snap to the road you're on: exact alignment with the street. Oriented
        // by the track, never the compass, so the course stays ground truth.
        if (Motion.roadLookup) {
          const radius = Math.max(CFG.SNAP_RADIUS_M, Math.min(60, (finite(f.accuracy) ? f.accuracy : 0) * 1.5));
          const r = Motion.roadLookup(f.lat, f.lon, radius, heading);
          Motion.road = r;
          if (r) { Motion.course = r.bearing; Motion.courseSrc = 'road'; }
        }
        Motion.learnCompass(f, before);
      } else Motion.road = null;
      if (Motion.course != null && (before == null || Math.abs(angleDiff(before, Motion.course)) > 10)) Motion.courseAt = f.t;
    },

    // What the compass is worth, judged against the track at each fix.
    learnCompass(f, before) {
      const c = Compass.fresh();
      // Sign vote: when the track has turned by more than 30 deg since the last
      // sample, did the compass turn the same way?
      if (!Motion.turnRef) Motion.turnRef = { course: Motion.course, cmp: c };
      else {
        const dC = angleDiff(Motion.turnRef.course, Motion.course);
        if (Math.abs(dC) > 30) {
          if (c != null && Motion.turnRef.cmp != null) {
            const dM = angleDiff(Motion.turnRef.cmp, c);
            // a vote needs a clear compass swing of a size comparable to the track's
            if (Math.abs(dM) > 20 && Math.abs(dM) < 3 * Math.abs(dC) && Math.abs(dC) < 3 * Math.abs(dM)) {
              const v = (dC > 0) === (dM > 0) ? 1 : -1;
              Motion.votes = Math.max(-3, Math.min(3, Motion.votes + v));
              const sign = Motion.votes >= 0 ? 1 : -1;
              if (sign !== Motion.sign) { Motion.sign = sign; Motion.cmpOffset = null; }
              if (CH.store) CH.store.set('compassVotes', Motion.votes);
            }
          }
          Motion.turnRef = { course: Motion.course, cmp: c };
        }
      }
      // Offset: re-anchor the compass to the track whenever the compass is
      // steady and either roughly agrees already, the track has turned (the
      // track is truth; if the head is still swinging, do it at the next
      // steady fix), or the anchor is getting old.
      const turned = before != null && Math.abs(angleDiff(before, Motion.course)) > 20;
      if (turned) Motion.relearn = true;
      if (c != null && Math.abs(Compass.rate) < 40) {
        const h = Motion.cmpOffset == null ? null : (Motion.sign * c + Motion.cmpOffset + 720) % 360;
        if (h == null || Motion.relearn || Math.abs(angleDiff(Motion.course, h)) <= CFG.HEAD_TUNE_DEG || f.t - Motion.cmpOffsetAt > CFG.HEAD_ANCHOR_MS) {
          Motion.cmpOffset = angleDiff(0, Motion.course - Motion.sign * c);
          Motion.cmpOffsetAt = f.t;
          Motion.relearn = false;
        }
      }
    },

    // Course used to centre the next map box ahead of you (null when unknown).
    lookahead() { return Motion.course; },

    // Real-time heading. The track (course) is the heading; the compass only
    // fine-tunes it within HEAD_TUNE_DEG, only between fixes whose anchor is
    // fresh, and only once it has proved it turns the same way as the bike.
    // Anything further off is the head, not the bike, and is ignored.
    fuse(now) {
      const ref = Motion.course, c = Compass.fresh();
      const usable = c != null && Math.abs(Motion.votes) >= CFG.COMPASS_MIN_VOTES;
      if (ref == null) return usable ? (Motion.sign * c + 360) % 360 : null;      // not moved yet: the head, if we trust it
      if (Motion.state !== 'MOVING' || !usable || Motion.cmpOffset == null || Motion.relearn || now - Motion.cmpOffsetAt > CFG.HEAD_ANCHOR_MS) return ref;
      if (Math.abs(Compass.rate) > CFG.HEAD_FAST_DPS) return ref;             // head whipping round
      const h = (Motion.sign * c + Motion.cmpOffset + 720) % 360;
      return Math.abs(angleDiff(ref, h)) <= CFG.HEAD_TUNE_DEG ? h : ref;
    },

    // Advance the smoothed heading (map rotation in Facing up, arrow in North
    // up). Returns true when settled.
    step(now) {
      const t = Motion.heading = Motion.fuse(now);
      if (t == null) { Motion.displayed = null; Motion.lastStep = now; return true; }
      if (Motion.displayed == null) { Motion.displayed = t; Motion.lastStep = now; return true; }
      const dt = Math.min(0.5, Math.max(0, (now - Motion.lastStep) / 1000));
      Motion.lastStep = now;
      const d = Math.abs(angleDiff(Motion.displayed, t));
      const tau = d > 30 ? 0.15 : 0.3;     // short: the compass is already smoothed and the swing should feel live
      Motion.displayed = angleLerp(Motion.displayed, t, 1 - Math.exp(-dt / tau));
      return Math.abs(angleDiff(Motion.displayed, t)) < 0.5;
    },

    speedStale(ms = 5000) { return !Motion.speedAt || Date.now() - Motion.speedAt > ms; },
  };
  CH.Motion = Motion;
})();
