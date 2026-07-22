// Shared config for the consultatie preview probe/screenshot scripts.
// Every value was previously hardcoded (and copy-pasted) in each script, which pinned them to one
// preview deployment and to one machine's absolute paths. Override per run, e.g.:
//   CONSULTATIE_BASE=https://consultatie-main.simulatie.datastelsel.nl node capture-walk.mjs
//   FOREMAN_STATE_DIR=/tmp/shots node video-walk.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BASE = process.env.CONSULTATIE_BASE
  || 'https://consultatie-feat-beheerder-workspace.simulatie.datastelsel.nl';

// The one werkbank route and the one seeded-fixture link text every walk script navigates through.
// Both were copy-pasted into each script, so a route change or a fixture rename broke all of them at
// once and each needed its own edit — they live here so that is a one-line change.
export const WERKBANK = '/beheer/werkbank/voorbeeld';
export const REACTIE_LINK = 'Het federatief datastelsel verbindt';

// Default to <repo>/state — the SAME default review-loop.sh uses ($dir/state) — resolved from this
// file's own location, not a hardcoded /home/dev path: a one-machine absolute default is exactly
// what this module was created to remove, and on any other box (CI, container, another dev) it
// would write artifacts into a stray directory outside the checkout.
const STATE = process.env.FOREMAN_STATE_DIR || fileURLToPath(new URL('../../state', import.meta.url));
export const SHOTS = `${STATE}/screenshots`;   // .png output
export const POC = `${STATE}/poc`;             // scraped css/html + the poc mockup
export const VIDEO_RAW = `${STATE}/video-raw`; // recordVideo dir + run artifacts

// Create the output dirs here, once. Importing this module IS the declaration of intent to write
// into them, and doing it centrally removes the per-script `fs.mkdirSync(OUT,{recursive:true})` —
// which two scripts had and the other seven silently omitted, so they threw ENOENT on the first run
// against a fresh FOREMAN_STATE_DIR.
for (const d of [SHOTS, POC, VIDEO_RAW]) fs.mkdirSync(d, { recursive: true });
