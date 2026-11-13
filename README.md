# Cycle Hub

A cycling heads-up hub for **Meta Ray-Ban Display** glasses. It shows a street map of where you are that rotates to face the way you're riding (like the built-in navigation, but with no destination needed), your speed, the time, and a mini player for Spotify or Plexamp.

Built for the glasses' 600×600 additive display (black is see-through), Neural Band / temple-swipe input (arrow keys + Enter), phone-sourced `navigator.geolocation`, and a plain static site: no build step, no framework, no server.

## On the glasses

| Where | Controls |
|---|---|
| Map | **Up / Down** zoom in / out · **Left / Right** previous / next track · **Enter** opens the menu · **Back** leaves the app |
| Menu | **Pause / Play** (when media is on) · **Units** mph / km/h · **Map** Facing up / North up / Compass · **Media** Spotify / Plex / Off · **Pair phone** · **Status** |

- The map follows your GPS course while you're moving and holds the last course when you stop, so looking around doesn't swing it. "Compass" uses the glasses' head direction instead, if you prefer.
- Speed comes from the phone's GPS. It dims after 5 s without a fix and shows `--` after 15 s.
- Road data is OpenStreetMap, delivered as [OpenFreeMap](https://openfreemap.org) vector tiles (free, no account). The 3×3 tiles around you (about 4.5 km) are kept loaded and the next ones are fetched as you cross into a new tile; the last set is cached on the glasses so the map draws immediately on the next launch. If a tile can't be fetched, the same area is asked from the Overpass API instead.

## Putting it on GitHub Pages

1. Create a new **public** repository (e.g. `cycle-hub`).
2. Push this folder to it (or upload everything, including the hidden `.well-known` folder and `.nojekyll` file).
3. **Settings → Pages → Source: Deploy from a branch → main / (root) → Save.**
4. After a minute the app is live at `https://baroquedub.github.io/cycle-hub/`.
5. Add it on the glasses the same way as other web apps (Meta AI app → Developer Mode → add the link or scan a QR code).

`.nojekyll` matters: without it GitHub Pages hides the `.well-known` folder, and the glasses won't find the app's name and icon.

## Pairing your phone (for Spotify and Plex)

Typing on a phone is far easier than on the glasses, and sign-in tokens must never be committed to a public repo. So the phone page `pair.html` does the sign-in and sends the result to the glasses through a private [ntfy.sh](https://ntfy.sh) topic named after a pairing code. The relay holds each message for up to 12 hours so the glasses can pick it up even if they were asleep; only someone who knows your pairing code could read it.

1. On the glasses: menu → **Pair phone**. You'll see the page address and an 8-character code.
2. On your phone, open `https://baroquedub.github.io/cycle-hub/pair.html` and enter the code. The glasses say "Phone paired".

Anyone who knows the code could send settings to your glasses; press **New code** on the glasses to change it any time.

### Spotify (needs Premium)

Spotify's API requires an app registration (free, 5 minutes). Do this once:

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), sign in, **Create app**.
2. Redirect URI: `https://baroquedub.github.io/cycle-hub/pair.html` (press Add). Tick **Web API**. Save.
3. Copy the app's **Client ID** into the Spotify box on `pair.html`, make sure Cycle Hub is open on the glasses, and press **Connect Spotify**.

After you approve, the glasses say "Spotify connected" and the media bar shows what's playing. Controls (Left / Right / Pause) act on whatever device Spotify is playing on. The token refreshes itself on the glasses; if the glasses' storage is wiped by a software update, just press Connect Spotify again.

### Plex / Plexamp

Your Plex Media Server must have **Remote Access** on, and you need its secure `plex.direct` address plus your token (the Plex box on `pair.html` explains where to find both). Press **Test** while Plexamp is playing: it should show the current track. Then **Send to glasses**.

Now-playing comes from the server's `/status/sessions`. Transport controls are relayed through the server to the player (`/player/playback/...`). If your server or player doesn't accept that, the bar still shows what's playing and the glasses say "Plex: control unavailable" when you try to skip.

## Testing on a laptop

Serve the folder (for example `python -m http.server 8000` inside it) and open `http://127.0.0.1:8000/index.html?demo` in Chrome with the device toolbar set to 600×600. The demo rides a 2 km loop around Trafalgar Square. Use the arrow keys and Enter for the Neural Band, Escape for Back.

- `&start=LAT,LON` starts the loop somewhere else; `&speed=10` sets the riding speed in metres per second.
- `pair.html` works from the laptop too, so you can pair, connect Spotify and watch the bar update without the glasses. For Spotify's redirect add `http://127.0.0.1:8000/pair.html` as a second redirect URI in the Spotify app settings (Spotify requires HTTPS or 127.0.0.1).

## Files

```
index.html                   glasses screens (map, menu, pair, status) + media bar
styles.css                   styles for the additive display
config.js                    non-secret settings (tile source, relay, zoom steps, units)
geo.js                       geo maths, location watch, demo rider, compass, speed/course fusion
mvt.js                       minimal Mapbox Vector Tile decoder
map.js                       tile loading/caching (OpenFreeMap, Overpass fallback) and canvas drawing
relay.js                     ntfy.sh listener for messages from pair.html
media.js                     media bar, polling, marquee, controls
media-spotify.js             Spotify Web API source (PKCE refresh)
media-plex.js                Plex Media Server source
pair.html                    phone companion page (pairing, Spotify sign-in, Plex setup)
favicon.png / manifest.webmanifest / icons/icon.svg / .well-known/meta-wearables-manifest.json
.nojekyll                    lets GitHub Pages serve .well-known
```

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, tiles by [OpenFreeMap](https://openfreemap.org) © [OpenMapTiles](https://www.openmaptiles.org/).
