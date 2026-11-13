/* Cycle Hub — map.js
 * MapData: keeps the road network around you as a set of z14 tiles, decoded
 *          into flat metres relative to a session origin. Primary source is
 *          OpenFreeMap vector tiles (free, no key, CDN-cached); if a tile
 *          can't be fetched, the same tile's bounding box is asked from the
 *          Overpass API instead. The 3x3 tiles around you are kept loaded,
 *          so there is always at least one tile (~1.5 km) of road ahead.
 * MapView: draws the loaded tiles on the canvas, rotated to your heading.
 */
(() => {
  'use strict';
  const CH = window.CH;
  const CFG = CH.CONFIG;
  const G = CH.geo;
  const finite = G.finite;
  const Z = CFG.TILE_ZOOM;
  const N = 1 << Z;

  // ------------------------------------------------------------------ classification
  // 0 major, 1 minor, 2 path/cycle, 3 service, -1 skip
  function classifyTile(p) {
    const c = p.class, sub = p.subclass || '';
    switch (c) {
      case 'motorway': case 'trunk': case 'primary': case 'secondary': case 'tertiary': return 0;
      case 'minor': return 1;
      case 'service': return (p.service === 'driveway' || p.service === 'parking_aisle' || p.service === 'drive-through') ? -1 : 3;
      case 'track': return 2;
      case 'path':
        if (sub === 'steps' || sub === 'corridor' || sub === 'platform') return -1;
        if (sub === 'footway' || sub === 'sidewalk' || sub === 'crossing') return (p.bicycle === 'yes' || p.bicycle === 'designated' || p.bicycle === 'permissive') ? 2 : -1;
        return 2;   // cycleway, path, pedestrian, bridleway
      default: return -1;   // rail, transit, ferry, aerialway, raceway, pier, ...
    }
  }
  const OSM_CLASS = {
    motorway: 0, trunk: 0, primary: 0, secondary: 0, tertiary: 0,
    motorway_link: 0, trunk_link: 0, primary_link: 0, secondary_link: 0, tertiary_link: 0,
    residential: 1, unclassified: 1, living_street: 1, road: 1,
    cycleway: 2, path: 2, track: 2, bridleway: 2, pedestrian: 2, footway: 2,
    service: 3,
  };
  const OSM_HIGHWAYS = Object.keys(OSM_CLASS).filter((k) => k !== 'footway').join('|');
  function overpassQL(bb) {
    return `[out:json][timeout:20][bbox:${bb.S},${bb.W},${bb.N},${bb.E}];` +
      `(way["highway"~"^(${OSM_HIGHWAYS})$"]["area"!="yes"]["service"!~"^(driveway|parking_aisle|drive-through)$"];` +
      `way["highway"="footway"]["bicycle"~"^(yes|designated|permissive)$"];);out geom qt;`;
  }

  function fetchTimeout(url, opts, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return fetch(url, Object.assign({ signal: ctl.signal }, opts)).finally(() => clearTimeout(t));
  }

  // ------------------------------------------------------------------ tile maths
  function tileOf(lat, lon) {
    const x = Math.floor((lon + 180) / 360 * N);
    const la = G.rad(lat);
    const y = Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * N);
    return [Math.max(0, Math.min(N - 1, x)), Math.max(0, Math.min(N - 1, y))];
  }
  function tileLon(x) { return x / N * 360 - 180; }
  function tileLat(y) { return G.deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * y / N)))); }
  function tileBBox(x, y) { return { W: tileLon(x), E: tileLon(x + 1), N: tileLat(y), S: tileLat(y + 1) }; }
  const key = (x, y) => x + '/' + y;

  // ------------------------------------------------------------------ data
  const MapData = {
    origin: null,          // [lat, lon] all coordinates are metres east/north of this
    tiles: new Map(),      // key → { x, y, classes:[[way]x4], count, src, at }
    pending: new Map(),    // key → promise
    failed: new Map(),     // key → { n, at }
    template: null,        // OpenFreeMap tile URL template
    templateAt: 0,
    center: null,          // [x, y] tile the rider is in
    status: 'idle',        // idle | loading | ok | error
    error: '',
    lastSrc: '',
    onChange: null,

    radius() { return CH.MapView && CH.MapView.zoom >= CFG.WIDE_ZOOM_INDEX ? 2 : 1; },
    wanted() {
      if (!MapData.center) return [];
      const [cx, cy] = MapData.center, out = [], r = MapData.radius();
      // nearest first so the centre tile is requested before the corners
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.push([cx + dx, cy + dy]);
      out.sort((a, b) => (Math.abs(a[0] - cx) + Math.abs(a[1] - cy)) - (Math.abs(b[0] - cx) + Math.abs(b[1] - cy)));
      return out;
    },

    // Called when the zoom changes: the wide view wants more tiles.
    rezoom() { if (MapData.center) { for (const [x, y] of MapData.wanted()) MapData.ensure(x, y); MapData.refreshStatus(); } },

    // Called on every fix.
    update(fix) {
      if (!MapData.origin) MapData.setOrigin([fix.lat, fix.lon]);
      else if (G.haversine(MapData.origin, [fix.lat, fix.lon]) > 60000) { MapData.reset(); MapData.setOrigin([fix.lat, fix.lon]); }
      const [tx, ty] = tileOf(fix.lat, fix.lon);
      if (!MapData.center || MapData.center[0] !== tx || MapData.center[1] !== ty) {
        MapData.center = [tx, ty];
        MapData.evict();
        MapData.saveCache();
      }
      for (const [x, y] of MapData.wanted()) MapData.ensure(x, y);
      MapData.refreshStatus();
    },

    setOrigin(ll) { MapData.origin = [Number(ll[0].toFixed(4)), Number(ll[1].toFixed(4))]; },
    reset() { MapData.tiles.clear(); MapData.failed.clear(); MapData.center = null; },

    ensure(x, y) {
      const k = key(x, y);
      if (MapData.tiles.has(k) || MapData.pending.has(k)) return;
      const f = MapData.failed.get(k);
      if (f && Date.now() < f.at + Math.min(300000, 15000 * Math.pow(2, f.n - 1))) return;
      const p = MapData.fetchTile(x, y).finally(() => { MapData.pending.delete(k); MapData.refreshStatus(); });
      MapData.pending.set(k, p);
      MapData.refreshStatus();
    },

    async fetchTile(x, y) {
      const k = key(x, y);
      let tile = null, err = '';
      try { tile = await MapData.fetchOFM(x, y); }
      catch (e) { err = 'tiles: ' + ((e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'error'); console.warn('ofm', k, err); }
      if (!tile) {
        try { tile = await MapData.fetchOverpass(x, y); }
        catch (e) { err += ' · overpass: ' + ((e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'error'); console.warn('overpass', k, err); }
      }
      if (tile) {
        MapData.tiles.set(k, tile);
        MapData.failed.delete(k);
        MapData.lastSrc = tile.src;
        MapData.error = '';
        MapData.saveCache();
      } else {
        const f = MapData.failed.get(k) || { n: 0 };
        MapData.failed.set(k, { n: f.n + 1, at: Date.now() });
        MapData.error = err;
      }
      if (MapData.onChange) MapData.onChange();
    },

    async getTemplate() {
      if (MapData.template && Date.now() - MapData.templateAt < 86400000) return MapData.template;
      const cached = CH.store.get('tileTemplate', null);
      if (cached && cached.url && Date.now() - cached.at < 86400000) { MapData.template = cached.url; MapData.templateAt = cached.at; return cached.url; }
      try {
        const res = await fetchTimeout(CFG.TILE_JSON, {}, 10000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        const url = j && Array.isArray(j.tiles) && j.tiles[0];
        if (!url) throw new Error('no tiles in tilejson');
        MapData.template = url; MapData.templateAt = Date.now();
        CH.store.set('tileTemplate', { url, at: MapData.templateAt });
        return url;
      } catch (e) {
        if (cached && cached.url) { MapData.template = cached.url; MapData.templateAt = Date.now(); return cached.url; }
        throw e;
      }
    },

    async fetchOFM(x, y) {
      const tpl = await MapData.getTemplate();
      const url = tpl.replace('{z}', Z).replace('{x}', x).replace('{y}', y);
      const res = await fetchTimeout(url, {}, CFG.TILE_TIMEOUT_MS);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const layers = CH.MVT.decode(buf, new Set(['transportation']));
      const layer = layers.transportation;
      const classes = [[], [], [], []];
      let count = 0;
      if (layer) {
        const ext = layer.extent || 4096;
        const west = tileLon(x), east = tileLon(x + 1);
        const north = y / N, south = (y + 1) / N;     // mercator fraction
        for (const f of layer.features) {
          const cls = classifyTile(f.props);
          if (cls < 0) continue;
          for (const line of f.lines) {
            const n = line.length / 2;
            const xy = new Float32Array(n * 2);
            let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
            for (let i = 0; i < n; i++) {
              const px = line[2 * i] / ext, py = line[2 * i + 1] / ext;
              const lon = west + (east - west) * px;
              const yf = north + (south - north) * py;
              const lat = G.deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * yf))));
              const [mx, my] = G.project([lat, lon], MapData.origin);
              xy[2 * i] = mx; xy[2 * i + 1] = my;
              if (mx < minx) minx = mx; if (mx > maxx) maxx = mx;
              if (my < miny) miny = my; if (my > maxy) maxy = my;
            }
            classes[cls].push({ cls, name: '', bb: [minx, miny, maxx, maxy], xy });
            count++;
          }
        }
      }
      return { x, y, classes, count, src: 'tiles', at: Date.now() };
    },

    async fetchOverpass(x, y) {
      const bb = tileBBox(x, y);
      const body = 'data=' + encodeURIComponent(overpassQL({ S: bb.S.toFixed(6), W: bb.W.toFixed(6), N: bb.N.toFixed(6), E: bb.E.toFixed(6) }));
      let lastErr = null;
      for (const url of CFG.OVERPASS) {
        try {
          const res = await fetchTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, CFG.OVERPASS_TIMEOUT_MS);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const json = await res.json();
          if (!json || !Array.isArray(json.elements)) throw new Error('bad response');
          const classes = [[], [], [], []];
          let count = 0;
          for (const el of json.elements) {
            if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
            const tags = el.tags || {};
            const cls = OSM_CLASS[tags.highway];
            if (cls == null) continue;
            const n = el.geometry.length;
            const xy = new Float32Array(n * 2);
            let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
            for (let i = 0; i < n; i++) {
              const g = el.geometry[i];
              const [mx, my] = G.project([g.lat, g.lon], MapData.origin);
              xy[2 * i] = mx; xy[2 * i + 1] = my;
              if (mx < minx) minx = mx; if (mx > maxx) maxx = mx;
              if (my < miny) miny = my; if (my > maxy) maxy = my;
            }
            classes[cls].push({ cls, name: tags.name || '', bb: [minx, miny, maxx, maxy], xy });
            count++;
          }
          return { x, y, classes, count, src: 'overpass', at: Date.now() };
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('no mirror');
    },

    // Drop tiles well behind us (one ring beyond what the current zoom wants).
    evict() {
      const [cx, cy] = MapData.center, keep = MapData.radius() + 1;
      for (const [k, t] of MapData.tiles) {
        if (Math.abs(t.x - cx) > keep || Math.abs(t.y - cy) > keep) MapData.tiles.delete(k);
      }
    },

    refreshStatus() {
      const want = MapData.wanted();
      if (!want.length) { MapData.status = 'idle'; return; }
      const [cx, cy] = MapData.center;
      const haveCenter = MapData.tiles.has(key(cx, cy));
      const loading = MapData.pending.size > 0;
      const missing = want.filter(([x, y]) => !MapData.tiles.has(key(x, y))).length;
      if (haveCenter) MapData.status = missing && !loading ? 'partial' : 'ok';
      else MapData.status = loading ? 'loading' : 'error';
    },

    loadedCount() { return MapData.tiles.size; },
    wayCount() { let n = 0; for (const t of MapData.tiles.values()) n += t.count; return n; },

    // Persist the loaded tiles (rounded to whole metres) so the next launch
    // draws before the network answers.
    saveCache() {
      clearTimeout(MapData.saveT);
      MapData.saveT = setTimeout(() => {
        try {
          const tiles = [];
          for (const t of MapData.tiles.values()) {
            const ways = [];
            for (const cls of t.classes) for (const w of cls) {
              const row = [w.cls, w.name];
              for (let i = 0; i < w.xy.length; i++) row.push(Math.round(w.xy[i]));
              ways.push(row);
            }
            tiles.push({ x: t.x, y: t.y, src: t.src, at: t.at, ways });
          }
          const s = JSON.stringify({ v: 2, z: Z, origin: MapData.origin, tiles });
          if (s.length > 3000000) { localStorage.removeItem('ch.mapCache'); return; }
          localStorage.setItem('ch.mapCache', s);
        } catch (e) { console.warn('map cache', e); }
      }, 1500);
    },

    // Called with the first fix: adopt the cached origin + tiles if we're near them.
    tryCache(fix) {
      if (MapData.origin) return false;
      try {
        const s = localStorage.getItem('ch.mapCache');
        if (!s) return false;
        const c = JSON.parse(s);
        if (!c || c.v !== 2 || c.z !== Z || !Array.isArray(c.origin) || !Array.isArray(c.tiles)) return false;
        if (G.haversine(c.origin, [fix.lat, fix.lon]) > 60000) return false;
        MapData.origin = c.origin;
        for (const t of c.tiles) {
          const classes = [[], [], [], []];
          for (const row of t.ways) {
            const cls = row[0];
            if (!classes[cls]) continue;
            const xy = new Float32Array(row.length - 2);
            let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
            for (let i = 2; i < row.length; i += 2) {
              const x = row[i], y = row[i + 1];
              xy[i - 2] = x; xy[i - 1] = y;
              if (x < minx) minx = x; if (x > maxx) maxx = x;
              if (y < miny) miny = y; if (y > maxy) maxy = y;
            }
            classes[cls].push({ cls, name: row[1], bb: [minx, miny, maxx, maxy], xy });
          }
          MapData.tiles.set(key(t.x, t.y), { x: t.x, y: t.y, classes, count: t.ways.length, src: (t.src || 'tiles') + ' (cached)', at: t.at });
        }
        return MapData.tiles.size > 0;
      } catch { return false; }
    },
  };
  CH.MapData = MapData;

  // ------------------------------------------------------------------ view
  // Line widths per zoom step (0 = hidden) and colours. Tune on-device: on the
  // additive display white is maximum brightness, so a dense city grid can
  // look busy — lower the minor/path widths before dimming the majors.
  const STYLE = [
    { w: [4, 3, 2.5], col: '#FFFFFF' },     // major
    { w: [2.5, 1.8, 1.2], col: '#B0B3B8' }, // minor
    { w: [1.5, 1, 0], col: '#8d98a3' },     // cycle / path / track
    { w: [1, 0, 0], col: '#6c7076' },       // service
  ];
  // Perspective: the map plane is tilted away from you like a car sat-nav, so
  // the road ahead reads as "ahead". The scale at the rider is unchanged;
  // roads at the top edge of the map are drawn at TOP_SCALE of it (1 = flat
  // top-down view). The far distance fades out over the top FADE_PX so the
  // compressed horizon doesn't become a bright band. RIDER_FROM_BOTTOM is how
  // much of the map is behind you.
  const TILT = { TOP_SCALE: 0.38, FADE_PX: 150, RIDER_FROM_BOTTOM: 80 };
  const SCALE_METRIC = [[50, '50 m'], [100, '100 m'], [200, '200 m'], [500, '500 m'], [1000, '1 km'], [2000, '2 km'], [5000, '5 km']];
  const SCALE_IMPERIAL = [[91.44, '100 yd'], [182.9, '200 yd'], [402.3, '¼ mi'], [804.7, '½ mi'], [1609.3, '1 mi'], [3218.7, '2 mi'], [8046.7, '5 mi']];

  const MapView = {
    canvas: null,
    zoom: CFG.DEFAULT_ZOOM,
    fix: null,
    units: 'mph',
    enabled: false,
    queued: false,
    lastDrawAt: 0,
    timer: null,
    frames: 0,
    lastFrameMs: 0,
    riderXY: [300, 320],   // recomputed from the canvas size on every draw

    init(canvas) { MapView.canvas = canvas; },
    setFix(fix) { MapView.fix = fix; MapView.requestDraw(); },

    zoomBy(delta) {
      const z = Math.max(0, Math.min(CFG.ZOOMS.length - 1, MapView.zoom + delta));
      if (z === MapView.zoom) return false;
      MapView.zoom = z;
      MapData.rezoom();
      MapView.requestDraw();
      return true;
    },
    metresPerPx() { return CFG.ZOOMS[MapView.zoom]; },
    acrossText() {
      const m = CFG.ZOOMS[MapView.zoom] * 600;
      if (MapView.units === 'mph') { const mi = m / 1609.344; return (mi < 2 ? mi.toFixed(2).replace(/0$/, '') : mi.toFixed(1)) + ' mi across'; }
      return (m / 1000).toFixed(1) + ' km across';
    },

    requestDraw() {
      if (!MapView.enabled || MapView.queued) return;
      if (document.visibilityState === 'hidden') return;
      MapView.queued = true;
      const wait = Math.max(0, 100 - (Date.now() - MapView.lastDrawAt));
      MapView.timer = setTimeout(() => requestAnimationFrame(MapView.draw), wait);
    },
    stop() { clearTimeout(MapView.timer); MapView.queued = false; },

    draw() {
      MapView.queued = false;
      const c = MapView.canvas;
      if (!c || !MapView.enabled) return;
      const t0 = performance.now();
      const now = Date.now();
      MapView.lastDrawAt = now;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth || 600, h = c.clientHeight || 600;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const fix = MapView.fix;
      const settled = CH.Motion.step(now);
      const hdg = CH.Motion.displayed;
      const th = hdg == null ? 0 : G.rad(hdg);
      const cos = Math.cos(th), sin = Math.sin(th);
      const scale = MapView.metresPerPx();
      const cx = w / 2, cy = h - TILT.RIDER_FROM_BOTTOM;
      MapView.riderXY = [cx, cy];

      // Tilted-plane projection. A point `fw` top-down px ahead of the rider and
      // `ex` px to the right lands at (cx + ex*k, cy - fw*k) with k = HD/(HD+fw):
      // k is 1 at the rider and shrinks towards the horizon HD px above it.
      const HD = cy / (1 - TILT.TOP_SCALE);
      const NEAR = -(h - cy + 40);            // clip plane just below the bottom edge
      const FAR = cy * HD / (HD - cy);        // top-down px ahead that reach the top edge
      const kNear = HD / (HD + NEAR);

      if (fix && MapData.origin && MapData.tiles.size) {
        const [rx, ry] = G.project([fix.lat, fix.lon], MapData.origin);
        const R = scale * Math.max(FAR, (w / 2) / TILT.TOP_SCALE);
        const x0 = rx - R, x1 = rx + R, y0 = ry - R, y1 = ry + R;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const tiles = [...MapData.tiles.values()];
        for (let cls = 3; cls >= 0; cls--) {
          const st = STYLE[cls];
          const lw = st.w[Math.min(MapView.zoom, st.w.length - 1)];
          if (!lw) continue;
          ctx.beginPath();
          for (const tile of tiles) {
            const ways = tile.classes[cls];
            for (let k = 0; k < ways.length; k++) {
              const wy = ways[k], bb = wy.bb;
              if (bb[2] < x0 || bb[0] > x1 || bb[3] < y0 || bb[1] > y1) continue;
              const xy = wy.xy;
              let pex = 0, pfw = 0, pin = false;
              for (let i = 0; i < xy.length; i += 2) {
                const dx = xy[i] - rx, dy = xy[i + 1] - ry;
                const ex = (dx * cos - dy * sin) / scale;
                const fw = (dx * sin + dy * cos) / scale;
                const inside = fw > NEAR;
                if (i > 0 && inside !== pin) {
                  // the segment crosses the near plane: cut it there so points
                  // behind the camera never flip over the horizon
                  const t = (NEAR - pfw) / (fw - pfw);
                  const ix = cx + (pex + (ex - pex) * t) * kNear, iy = cy - NEAR * kNear;
                  if (inside) ctx.moveTo(ix, iy); else ctx.lineTo(ix, iy);
                }
                if (inside) {
                  const kk = HD / (HD + fw);
                  const sx = cx + ex * kk, sy = cy - fw * kk;
                  if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
                }
                pex = ex; pfw = fw; pin = inside;
              }
            }
          }
          ctx.strokeStyle = st.col; ctx.lineWidth = lw; ctx.stroke();
        }

        // fade the far distance out (black is transparent on the glasses)
        const fade = ctx.createLinearGradient(0, 0, 0, TILT.FADE_PX);
        fade.addColorStop(0, 'rgba(0,0,0,0.95)');
        fade.addColorStop(0.5, 'rgba(0,0,0,0.55)');
        fade.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = fade; ctx.fillRect(0, 0, w, TILT.FADE_PX);
      }

      // accuracy halo + heading cone + rider marker
      if (fix) {
        const acc = fix.accuracy;
        if (finite(acc) && acc > 15 && acc < 200) {
          ctx.beginPath(); ctx.arc(cx, cy, acc / scale, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill();
        }
        const course = CH.Motion.course;
        const dirKnown = hdg != null || course != null;
        // on-screen direction of travel: straight up when the map is rotated to
        // the heading, otherwise (north up) the course itself
        const dir = hdg == null && course != null ? G.rad(course) : 0;
        ctx.save();
        ctx.translate(cx, cy);
        if (dirKnown) {
          ctx.rotate(dir);
          ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(12, 12); ctx.lineTo(0, 5); ctx.lineTo(-12, 12); ctx.closePath();
          ctx.fillStyle = '#FFFFFF'; ctx.fill();
          ctx.strokeStyle = '#0a0a0f'; ctx.lineWidth = 2; ctx.stroke();
        } else {
          ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fillStyle = '#FFFFFF'; ctx.fill();
          ctx.strokeStyle = '#0a0a0f'; ctx.lineWidth = 2; ctx.stroke();
        }
        ctx.restore();
      }

      // north indicator (arrow rotates, the letter stays upright)
      ctx.save();
      ctx.translate(w - 32, 112);
      ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.strokeStyle = '#3a454d'; ctx.lineWidth = 2; ctx.stroke();
      ctx.save();
      ctx.rotate(-th);
      ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(5, -4); ctx.lineTo(-5, -4); ctx.closePath();
      ctx.fillStyle = '#ff6b6b'; ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#f2f5f7'; ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('N', 0, 1);
      ctx.restore();

      // scale bar
      {
        const table = MapView.units === 'mph' ? SCALE_IMPERIAL : SCALE_METRIC;
        let pick = table[0];
        for (const row of table) { const px = row[0] / scale; if (px >= 60 && px <= 150) { pick = row; break; } if (px > 150) break; pick = row; }
        const px = pick[0] / scale;
        const y = h - 22;
        ctx.strokeStyle = '#E4E6EB'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(24, y); ctx.lineTo(24 + px, y); ctx.moveTo(24, y - 6); ctx.lineTo(24, y + 6); ctx.moveTo(24 + px, y - 6); ctx.lineTo(24 + px, y + 6); ctx.stroke();
        ctx.fillStyle = '#E4E6EB'; ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(pick[1], 26, y - 6);
      }

      MapView.frames++;
      MapView.lastFrameMs = performance.now() - t0;
      if (!settled) MapView.requestDraw();
    },
  };
  CH.MapView = MapView;
})();
