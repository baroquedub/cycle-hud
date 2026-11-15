// =====================================================================
//  Cycle Hub settings — non-secret defaults only. Safe to commit.
//  Secrets (Spotify refresh token, Plex token) never live here: they are
//  sent from pair.html to the glasses over the relay and kept in the
//  glasses' localStorage.
// =====================================================================
window.CH = window.CH || {};
window.CH.CONFIG = {
  VERSION: '0.6.0',

  // Relay used by "Pair phone" (free, no account). Topic = RELAY_PREFIX + pairing code.
  RELAY_URL: 'https://ntfy.sh',
  RELAY_PREFIX: 'cyclehub-',

  // Road data: OpenFreeMap vector tiles (free, no key, CDN). The 3x3 tiles
  // around you are kept loaded; at zoom 14 a tile is about 1.5 km across.
  TILE_JSON: 'https://tiles.openfreemap.org/planet',
  TILE_ZOOM: 14,
  TILE_TIMEOUT_MS: 12000,

  // Fallback when a tile can't be fetched: the same tile's bbox from Overpass,
  // mirrors tried one at a time.
  OVERPASS: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ],
  OVERPASS_TIMEOUT_MS: 20000,

  // Metres per CSS pixel for each zoom step (600 px = 1.2 / 2.4 km across),
  // chosen from the menu's Zoom row.
  ZOOMS: [2, 4],
  ZOOM_LABELS: ['Close', 'Normal'],
  DEFAULT_ZOOM: 1,
  WIDE_ZOOM_INDEX: 2,       // from this zoom step, keep 5x5 tiles loaded instead of 3x3

  // Course snapping: lock the heading to the nearest loaded road within
  // SNAP_RADIUS_M (widened when the fix is poor) whose direction is within
  // SNAP_MAX_DEG of the way you're moving; crossing streets are ignored.
  SNAP_RADIUS_M: 30,
  SNAP_MAX_DEG: 45,

  // Heading. The direction the bike actually moves (the track between fixes,
  // snapped to the road) is the heading. The glasses' compass sits on your
  // head, so it only fine-tunes between fixes, within HEAD_TUNE_DEG of the
  // track, and is re-anchored to the track at every fix; anything further off
  // (a look over the shoulder) is ignored, as is a swing faster than
  // HEAD_FAST_DPS. The compass is only used at all once it has agreed with
  // the track's turning direction COMPASS_MIN_VOTES times (it may turn the
  // wrong way round), and never when its anchor is older than HEAD_ANCHOR_MS.
  HEAD_TUNE_DEG: 30,
  HEAD_FAST_DPS: 90,
  HEAD_ANCHOR_MS: 10000,
  COMPASS_MIN_VOTES: 2,

  // A fix older than this is suspect when we were moving at the time, or when
  // the map has just come back after being away for AWAY_MS (display off, dash
  // view): the map is drawn greyed out and pulsing until a new fix lands.
  // Stationary, an old fix is still right, so nothing changes.
  STALE_FIX_MS: 4000,
  AWAY_MS: 30000,

  MEDIA_FETCH_TIMEOUT_MS: 10000,   // a request that never answers must not stall the player

  DEFAULT_UNITS: 'mph',     // 'mph' or 'kmh'

  // Spotify scopes needed for now-playing + transport controls.
  SPOTIFY_SCOPES: 'user-read-playback-state user-modify-playback-state user-read-currently-playing',

  MEDIA_POLL_MS: 5000,
};
