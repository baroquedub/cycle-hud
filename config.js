// =====================================================================
//  Cycle Hub settings — non-secret defaults only. Safe to commit.
//  Secrets (Spotify refresh token, Plex token) never live here: they are
//  sent from pair.html to the glasses over the relay and kept in the
//  glasses' localStorage.
// =====================================================================
window.CH = window.CH || {};
window.CH.CONFIG = {
  VERSION: '0.5.0',

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
  SNAP_MAX_DEG: 60,

  // Heading fusion: the glasses' compass gives the instant heading, the
  // road-snapped course corrects its bias. A compass reading more than
  // HEAD_GLANCE_DEG off the course is treated as a look over the shoulder and
  // ignored for HEAD_GLANCE_MS; longer than that it's a real turn.
  HEAD_GLANCE_DEG: 60,
  HEAD_GLANCE_MS: 2000,
  HEAD_FAST_DPS: 90,         // compass turning faster than this is a head movement, not the bike
  COMPASS_STEADY_DPS: 15,    // the bias is only learned while the compass turns slower than this
  COMPASS_BIAS_GAIN: 0.03,   // per draw step (~10 Hz)

  DEFAULT_UNITS: 'mph',     // 'mph' or 'kmh'

  // Spotify scopes needed for now-playing + transport controls.
  SPOTIFY_SCOPES: 'user-read-playback-state user-modify-playback-state user-read-currently-playing',

  MEDIA_POLL_MS: 5000,
};
