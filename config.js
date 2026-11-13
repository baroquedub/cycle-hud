// =====================================================================
//  Cycle Hub settings — non-secret defaults only. Safe to commit.
//  Secrets (Spotify refresh token, Plex token) never live here: they are
//  sent from pair.html to the glasses over the relay and kept in the
//  glasses' localStorage.
// =====================================================================
window.CH = window.CH || {};
window.CH.CONFIG = {
  VERSION: '0.1.1',

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

  // Metres per CSS pixel for each zoom step (600 px = 1.2 / 2.4 / 4.8 km across).
  ZOOMS: [2, 4, 8],
  DEFAULT_ZOOM: 1,
  WIDE_ZOOM_INDEX: 2,       // from this zoom step, keep 5x5 tiles loaded instead of 3x3

  DEFAULT_UNITS: 'mph',     // 'mph' or 'kmh'

  // Spotify scopes needed for now-playing + transport controls.
  SPOTIFY_SCOPES: 'user-read-playback-state user-modify-playback-state user-read-currently-playing',

  MEDIA_POLL_MS: 5000,
};
