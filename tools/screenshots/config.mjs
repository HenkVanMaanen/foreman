// Shared config for the consultatie preview probe/screenshot scripts.
// Every value was previously hardcoded (and copy-pasted) in each script, which pinned them to one
// preview deployment and to one machine's absolute paths. Override per run, e.g.:
//   CONSULTATIE_BASE=https://consultatie-main.simulatie.datastelsel.nl node capture-walk.mjs
//   FOREMAN_STATE_DIR=/tmp/shots node video-walk.mjs
export const BASE = process.env.CONSULTATIE_BASE
  || 'https://consultatie-feat-beheerder-workspace.simulatie.datastelsel.nl';

const STATE = process.env.FOREMAN_STATE_DIR || '/home/dev/foreman/state';
export const SHOTS = `${STATE}/screenshots`;   // .png output
export const POC = `${STATE}/poc`;             // scraped css/html + the poc mockup
export const VIDEO_RAW = `${STATE}/video-raw`; // recordVideo dir + run artifacts
