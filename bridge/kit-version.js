// The kit's versions (docs/kit.md). An app's app.json says which it was made for ("kit": 2) and gets that one at
// /kit/openhouse.js; /kit/v1/openhouse.js and /kit/v2/openhouse.js name one outright. An app that names none gets
// version 1, the kit as it was before versions: apps made then expect it. One that names a version newer than this
// tablet has gets the newest here. A change that would break an app made for a version goes in the next one, a file of
// its own in bridge/kit/ (flat, so scripts/runtime-assets.sh ships it); the older files stay as they are.
export const KIT_VERSIONS = { 1: 'openhouse.js', 2: 'openhouse-v2.js' };
export const KIT_LATEST = 2;

/** The version an app gets for its app.json "kit" (missing or not a version: 1; newer than this tablet's: the newest). */
export const kitVersion = (v) => (Number.isInteger(v) && v >= 1 ? Math.min(v, KIT_LATEST) : 1);

/** The file in bridge/kit/ for a path under /kit/ ('openhouse.js', 'v1/openhouse.js', 'quiet.css'), for an app made for
 *  kit [version] (its app.json "kit"). Null for a /kit/v<n>/ there isn't. */
export function kitFile(rel, version = null) {
  const v = /^v(\d{1,3})\/openhouse\.js$/.exec(rel);
  if (v) return KIT_VERSIONS[v[1]] || null;
  if (rel === 'openhouse.js') return KIT_VERSIONS[kitVersion(version)];
  return rel;
}
