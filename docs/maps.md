# Map

A built-in Map app (`defaults/apps/map`): home and the household's saved places (school, practice, grandparents),
today's calendar events that have a place, with a rough "leave by", and whatever Opie last showed on it ("how do I
get to the library?" → the live voice calls `show_on_map`, the Map opens on the library with the drive from home).

It is a starting tab, after Weather. Tablets that already chose their tabs keep
them; the Map is in their Apps.

## What it sends where

Maps are a new service for the household's data, so the Map does nothing until someone on the tablet taps
**Turn on the map** (household.json `maps: true`). The page says, in one line, what goes where. Until then
`show_on_map` answers that the map isn't on yet.

| What | Service | What it learns | Key, cost |
| --- | --- | --- | --- |
| Map tiles (the picture) | [OpenFreeMap](https://openfreemap.org), `tiles.openfreemap.org`, OpenStreetMap data | the tablet's IP and which area is being looked at | none, free, commercial use allowed |
| Finding a place (an address, "Lincoln Elementary") | [Nominatim](https://nominatim.org), `nominatim.openstreetmap.org` | the text looked up, plus a box around home to search near | none; usage policy: 1 request a second at most, identify the app, cache results |
| The drive and its time | [FOSSGIS OSRM](https://routing.openstreetmap.de), `routing.openstreetmap.de` | the two points (home and the place) | none; fair use, light traffic only |

- The tiles load in the Map's own page; finding places and drives go through the bridge (`bridge/maps.js`), which
  sends one request at a time, a second apart, with `User-Agent: OpenHouse/1 (+https://openhouse.computer)` (no
  household detail in it).
- Every place found is kept (`chats/maps.json` for lookups, `household.json` `places` for saved places), so each
  is looked up once. Drives are kept for a day.
- Today's events: only an event's `place` text is looked up, and only while the Map is on and someone opens it. A
  place that is a saved place's name ("School") isn't sent anywhere. Places like "Zoom" or a link are skipped.
- Home is the place set for the weather (a ZIP code or town) until someone gives the Map a street address for
  Home. A street address then goes to Nominatim once.
- Drive times are typical ones with no live traffic, and the Map says so.

## Options

The keyless services above are run by volunteers and foundations for light use. One tablet is light; thousands of
households on the same servers would not be, and Nominatim's and FOSSGIS's policies ask heavier users to run their own.

1. **Keep the open services, move them to the cloud at scale** (recommended): the same OpenStreetMap data, with
   geocoding (Nominatim or Photon) and routing (OSRM or Valhalla) run on our AWS account, and tiles from
   OpenFreeMap or a self-hosted copy (Protomaps). No new company sees the household's places. Costs one server.
2. **Apple Maps Server API** (MapKit JS for the picture): live traffic, very good geocoding, an Apple developer
   account and a key in the cloud; free tier generous. Apple sees looked-up places and routes.
3. **Google Maps Platform**: best place search and live traffic; paid per request after a monthly credit; Google
   sees looked-up places and routes.
4. **Mapbox**: good tiles, search and traffic; paid after a free tier; Mapbox sees them.

Live traffic ("leave now, there's a slowdown") needs 2, 3 or 4. The live voice's own directions come from OpenAI's
web search (the service the household already chose), so its spoken times are typical ones too.

## Pieces

- `bridge/maps.js`: `GET /map`, `GET /map/route`, `POST /map/on`, `/map/place`, `/map/place/remove`,
  `/map/clear` (the family's own apps only), and the tools `show_on_map`, `save_place`, `forget_place` (the live
  voice and typed turns have them).
- `bridge/kit/maplibre-gl.js`, `.css`: MapLibre GL JS 5.6.0 (BSD-3-Clause), served with the kit, nothing fetched
  from a CDN.
- `defaults/apps/map`: the page. `"tabIcon": "map-pin"`.
- When Opie shows something the home screen goes to the Map tab, or opens the Map full screen where it isn't a tab
  (`homeScreen.showApp`).
