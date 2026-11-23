// Tools as OpenAI's models get them, and their arguments as they come back.
//
// OpenAI's Responses API (the live voice's backend, typed turns, the heartbeat) treats a function as strict unless told
// otherwise, and a strict call fills in every part of the schema: "" and [] for what wasn't asked, false and 0 for
// booleans and numbers, the first choice of an enum. So "how are the check-ins set?" came back as level "off" and every
// 30, a chore's rename also cleared its "keep" and "every", and "delete the duplicates" added an event on 1 January.
// Two halves:
//  - forModel: every optional part may be null (and the model is told null means "not given"), so a strict call has a
//    way to leave it out. The cloud also sends the tools with strict: false (openhouse-cloud/lambda/app.ts cleanTools).
//  - fromModel: null, "" and [] are dropped, an object left empty goes, and an object inside the arguments missing a
//    part its schema requires goes too (an "add" with no title, an "update" with no id).

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** The schema with every optional part nullable. */
export function forModel(schema) {
  if (!isObj(schema)) return schema;
  const s = { ...schema };
  if (s.type === 'object' && isObj(s.properties)) {
    const req = new Set(s.required || []);
    s.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, req.has(k) ? forModel(v) : nullable(forModel(v))]));
  }
  if (s.type === 'array' && s.items) s.items = forModel(s.items);
  return s;
}
function nullable(v) {
  if (!isObj(v) || !v.type) return v;
  const types = [].concat(v.type);
  if (types.includes('null')) return v;
  return { ...v, type: [...types, 'null'], ...(v.enum ? { enum: [...v.enum, null] } : {}), description: `${v.description ? v.description + ' ' : ''}(null when not asked for)`.trim() };
}

const blank = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0) || (isObj(v) && !Object.keys(v).length);

/** The arguments with what wasn't given taken out. Top-level required parts are left for the tool to ask about. */
export function fromModel(schema, args, top = true) {
  if (Array.isArray(args)) return args.map((x) => fromModel(schema?.items, x, false)).filter((x) => !blank(x));
  if (!isObj(args)) return args;
  const props = isObj(schema?.properties) ? schema.properties : {};
  const o = {};
  for (const [k, v] of Object.entries(args)) { const y = fromModel(props[k], v, false); if (!blank(y)) o[k] = y; }
  if (!top && (schema?.required || []).some((k) => blank(o[k]))) return undefined;
  return o;
}
