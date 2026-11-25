# The Opie logo

One mark everywhere: a rounded house outline in off-white (`#fbf9f5`) on a dark rounded square (`#2a2826`), no door.
Beside it, the wordmark is "Opie" in the page's own type (semibold, slightly tight), never an image of text.

| File | What it is | Where it's used |
| --- | --- | --- |
| `logo.svg` | The app icon: the house on its rounded square | Same as `chat/phone-icon.svg` (the phone page and its manifest); the iPhone app's icon is its rendering (`ios/App/Assets.xcassets/AppIcon.appiconset`) |
| `mark.svg` | The house alone, `currentColor`, cropped to the house | Inline beside the wordmark: the website's header, the cloud's pages |
| `logo-square.svg` | The house on a full-bleed square | Source for `apple-touch-icon.png` and `maskable-512.png` (the house already sits inside the maskable safe circle) |
| `favicon.svg` | The house with a heavier line | Source for the 16 and 32 px renders and `favicon.ico`, so it holds at tab size |
| `logo-16.png`, `logo-32.png`, `favicon.ico` | Browser tab icons | The website and the cloud's pages |
| `apple-touch-icon.png` (180) | Home-screen icon on iOS | The website and the cloud's pages |
| `logo-192.png`, `logo-512.png`, `maskable-512.png` | Web app manifest icons | The phone page (`/h/`) and the photo page (`/p/`) |
| `og.png` (1200x630) | Link preview: the logo and the wordmark on the site's page colour | openhouse.computer's Open Graph and Twitter image |

The Android launcher icon (`shell/app/src/main/res/drawable/ic_launcher_foreground.xml`, background
`ic_launcher_background` in `values/colors.xml`) is the same house as a vector drawable.

The cloud serves these from its own copy, made from this folder by its `scripts/brand.ts`.

To render the PNGs again after changing an SVG: `python3 brand/render.py` (needs Google Chrome and Pillow).
