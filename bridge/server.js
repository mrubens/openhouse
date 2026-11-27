// The bridge's start: the household's brain (brain.js) on a tablet or hub that keeps the household's things, or a
// satellite (satellite-server.js) on another tablet in the same household, which keeps none of them and asks the brain
// for everything (docs/multi-tablet.md). Which one is this tablet's pairing with another (.satellite/pairing.json in the
// display folder): only one of them ever loads, so a satellite never opens, changes or sends on the household's
// things it may still have from before it joined (they wait, untouched, for it to leave).
import './pid-file.js'; // first: the process id, before anything else loads
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPairing } from './satellite.js';

const DISPLAY = process.env.CLOUD_DISPLAY || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (readPairing(DISPLAY)) await import('./satellite-server.js');
else await import('./brain.js');
