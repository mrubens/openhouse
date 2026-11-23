// The cloud service's own code, for the tests that run it locally (lambda/local.ts): it lives in its own private repo,
// mrubens/openhouse-cloud. Found through OPENHOUSE_CLOUD, else an openhouse-cloud folder next to this repo, else
// ~/Code/openhouse-cloud; it needs its packages (npm ci there). Without it, those tests are skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CLOUD = [process.env.OPENHOUSE_CLOUD, path.join(ROOT, '../openhouse-cloud'), path.join(os.homedir(), 'Code/openhouse-cloud')]
  .filter(Boolean).map((d) => path.resolve(d)).find((d) => fs.existsSync(path.join(d, 'lambda/local.ts'))) || null;
export const localCloud = () => (CLOUD ? import(pathToFileURL(path.join(CLOUD, 'lambda/local.ts')).href).catch(() => null) : Promise.resolve(null));
export const SKIP = 'no openhouse-cloud checkout with its packages (OPENHOUSE_CLOUD)';
