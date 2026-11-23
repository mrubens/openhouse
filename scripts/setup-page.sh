#!/bin/bash
# The setup page: one quiet, self-contained HTML page with a release's setup code (scripts/provision-qr.sh) and how to
# use it. No scripts, no outside requests, the code inline as SVG, so it works under the cloud service's strict CSP.
#
#   scripts/setup-page.sh <qr.svg> <out.html> [version]
set -eo pipefail
SVG=$1 OUT=$2 VERSION=${3:-}
[ -f "$SVG" ] && [ -n "$OUT" ] || { sed -n '2,6p' "$0"; exit 1; }
{
cat <<'HTML'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Set up OpenHouse</title>
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  :root { --bg: #f7f5f0; --ink: #1d1c1a; --soft: #6b6862; --line: #e2ded5; --card: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1a18; --ink: #ece9e2; --soft: #a19d95; --line: #34322e; --card: #24231f; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; }
  main { max-width: 34rem; margin: 0 auto; padding: 3rem 1rem 4rem; }
  h1 { font-size: 1.5rem; font-weight: 500; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .sub { color: var(--soft); margin: 0 0 2rem; }
  .code { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 1rem; max-width: 22rem; margin: 0 auto 2rem; }
  .code svg { display: block; width: 100%; height: auto; }
  ol { padding-left: 1.25rem; margin: 0 0 2rem; }
  li { margin: 0 0 .5rem; }
  .note { color: var(--soft); font-size: .875rem; border-top: 1px solid var(--line); padding-top: 1rem; }
</style>
</head>
<body>
<main>
<h1>Set up OpenHouse</h1>
HTML
echo "<p class=\"sub\">Turn a tablet into your household's OpenHouse${VERSION:+ (version $VERSION)}.</p>"
echo '<div class="code">'; cat "$SVG"; echo '</div>'
cat <<'HTML'
<ol>
  <li>Start with a new tablet, or reset it to factory settings.</li>
  <li>On the first welcome screen, tap the same spot six times.</li>
  <li>Connect to Wi-Fi if it asks, then scan this code.</li>
  <li>Tap through Android's screens. "Belongs to an organization" means OpenHouse looks after it. It's still yours.</li>
  <li>Wait a few minutes while it gets ready, then tap Turn on Opie.</li>
</ol>
<p class="note">This sets up the whole tablet, so use one with nothing else on it.</p>
</main>
</body>
</html>
HTML
} > "$OUT"
echo "$OUT"
