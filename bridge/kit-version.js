// The kit's versions (docs/kit.md). An app's app.json says which it was made for ("kit": 1) and gets that one at
// /kit/openhouse.js; /kit/v1/openhouse.js names it outright. An app that names none gets the newest. A change that
// would break an app made for a version goes in the next one, a file of its own in bridge/kit/ (flat, so
// scripts/runtime-assets.sh ships it); the older files stay as they are.
export const KIT_VERSIONS = { 1: 'openhouse.js' };
export const KIT_LATEST = 1;

/** The file in bridge/kit/ for a path under /kit/ ('openhouse.js', 'v1/openhouse.js', 'quiet.css'), for an app made for
 *  kit [version] (its app.json "kit"; null or one there isn't: the newest). Null for a /kit/v<n>/ there isn't. */
export function kitFile(rel, version = null) {
  const v = /^v(\d{1,3})\/openhouse\.js$/.exec(rel);
  if (v) return KIT_VERSIONS[v[1]] || null;
  if (rel === 'openhouse.js') return KIT_VERSIONS[version] || KIT_VERSIONS[KIT_LATEST];
  return rel;
}
