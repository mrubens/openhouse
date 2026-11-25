# Air quality

The air outside by the US Air Quality Index: now, the worst of today and tomorrow, and the EPA's bands.

- **Today:** nothing on a good day. When the day's worst is over the household's line (over 100, "unhealthy for
  sensitive groups", unless they choose otherwise), one line: "Air quality: unhealthy for sensitive groups this
  afternoon (112)".
- **The voice:** "how's the air today?"
- **Set up:** none. Where home is comes from the tablet's weather.
- **Pollen:** not for the US. The only free forecast it can use (Open-Meteo's, from the EU's Copernicus service)
  has pollen for Europe only; the US ones (pollen.com, Google, Tomorrow.io) need a developer key or aren't meant for
  apps. Where it does have pollen, the page shows it.

What's sent: the town's name, once, to Open-Meteo's place finder, and then its latitude and longitude, rounded to
about a kilometer, to Open-Meteo's air-quality forecast every half hour while the tablet's home screen is up.

## What it asks for

- the weather (for where home is)
- a line of its own on Home
- reaching `air-quality-api.open-meteo.com` and `geocoding-api.open-meteo.com`
