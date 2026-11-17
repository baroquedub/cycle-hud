// =====================================================================
//  Cycle Hub settings — non-secret defaults only. Safe to commit.
//  Secrets (Spotify refresh token, Plex token) never live here: they are
//  sent from pair.html to the glasses over the relay and kept in the
//  glasses' localStorage.
// =====================================================================
window.CH = window.CH || {};
window.CH.CONFIG = {
  VERSION: '0.7.0',

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

  // Heading = the direction the bike has just moved (the track), refined to
  // the exact bearing of the road that movement runs along. Nothing else
  // rotates the map (geo.js, Motion). The track bearing is measured from the
  // newest earlier fix at least `base` metres behind, base = TRACK_BASE_K x
  // the fix accuracy or TRACK_JITTER_K x the jitter measured in the fixes,
  // clamped to [MIN, MAX]: long enough to beat position noise, short enough
  // to swing within a couple of fixes of a turn.
  TRACK_BASE_MIN_M: 12,
  TRACK_BASE_MAX_M: 50,
  TRACK_BASE_K: 1.5,
  TRACK_JITTER_K: 8,         // ...or this many times the measured fix jitter (median scatter), whichever is longer
  TRACK_STILL_K: 3,          // progress over TRACK_SPEED_MS below this many times the jitter = standing still: heading held, speed 0
  TRACK_WINDOW_MS: 15000,    // covering the baseline took longer than this = standing still: hold the heading
  TRACK_WIGGLE: 2.5,         // path length / straight-line distance above this = jitter at a standstill, not travel
  TRACK_START_DEG: 45,       // from a standstill, two consecutive track bearings must agree this well before the map turns
  TRACK_SPEED_MS: 3000,      // derived speed = distance over at least this long
  TRACK_MAX_ACC_M: 100,      // fixes less accurate than this don't enter the track
  TRACK_JUMP_MPS: 30,        // an implied speed above this is a position jump: only believed once the next fix agrees
  TRACK_REPEAT_STOP_MS: 4000, // the phone repeating the same position for this long = stopped (speed shows 0)
  TRACK_TS_SANE_MS: 600000,  // a fix timestamp further than this from the clock is nonsense: receipt time is used instead
  TRACK_GPS_COURSE_MPS: 1.5, // a course field in the fix is trusted only at or above this speed (at rest it's noise or a stray 0 = north)
  TRACK_KEEP_MS: 60000,      // track history kept

  // Road refinement: among roads within SNAP_RADIUS_M (widened to 2 x the fix
  // accuracy, up to 60 m), the one running within SNAP_MAX_DEG of the track
  // with the lowest score (distance + SNAP_DEG_M per degree off) gives the
  // heading. The road we were already on gets SNAP_STICK_M off its score
  // while its bearing is within SNAP_STICK_DEG, so junctions don't flicker.
  // Roads crossing the track are never candidates.
  SNAP_RADIUS_M: 30,
  SNAP_MAX_DEG: 60,
  SNAP_DEG_M: 0.25,
  SNAP_STICK_M: 8,
  SNAP_STICK_DEG: 25,

  // Self-check: in Facing up the track must point up the screen. When the
  // drawn rotation is further than this from the track for two fixes running,
  // it is snapped to the track and the event counted (Status -> Fix stream).
  SIDEWAYS_DEG: 70,

  // Ride log: every fix with what the heading made of it, kept in memory and
  // localStorage (ch.rideLog) so a ride can be sent to the phone from
  // Status -> Send ride log and replayed in the browser with ?replay=URL.
  LOG_MAX: 3600,             // entries (an hour at one fix a second)
  LOG_RESUME_MS: 7200000,    // a stored log newer than this is continued at launch, older starts afresh

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
