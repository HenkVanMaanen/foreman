// Observability: a read-only local dashboard + the event/status persistence the supervisor
// feeds it. This is the harness-observable tier only — signals the harness can see on its
// own, with NO dependency on agent behaviour: orchestrator health (alive/working/quiet/
// recycling/dead via a pid liveness check + heartbeat freshness), live context %, an
// activity feed of orchestrator turns/marks/recycles, and a workers panel that lists the
// notes/tasks/*.md files the agent writes. Agent-reported states (idle vs waiting-on-human,
// rate-limited) are deferred until a real run shows how they actually manifest.
//
// Read-only and bound to 127.0.0.1 — it surfaces notes/task content (never secrets, which
// by design never reach notes). For remote viewing, SSH-tunnel the port.

import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";

export interface ForemanEvent {
  ts: string; // ISO timestamp
  who: string; // "supervisor" or a worker task id
  // launch | turn | soft-mark | hard-mark | recycle | clear | watchdog | auth-required |
  // relogin | exit
  kind: string;
  detail?: string;
  ctx?: number; // context tokens in use, when relevant
}

/**
 * What the supervisor is doing. Named here — next to the `Status` that carries it and the
 * `healthOf()` that reads it — rather than left as bare strings at each `stat(…)` call site, so a
 * new state is a compile error at the writer instead of a value the dashboard silently fails to
 * recognise. (`wedged` is written on a watchdog stall and has no `healthOf` arm; it is in the union
 * because it is a real state, not because the display handles it.)
 */
export type SupervisorState = "working" | "idle" | "recycling" | "auth-required" | "wedged";

export interface Status {
  pid: number; // the harness process, for a liveness check
  state: SupervisorState;
  ctxUsed: number;
  ctxWindow: number;
  ctxPct: number;
  life: number; // fresh agent lifetimes so far (recycle count + 1)
  softMark: number; // fraction
  hardMark: number; // fraction
  updatedAt: string;
}

interface Worker {
  id: string;
  status: string;
  updatedAt: string;
}

type Health = "working" | "quiet" | "recycling" | "auth-required" | "dead" | "offline";

const EVENTS_MAX_BYTES = 1_000_000; // bound the log on long runs
const QUIET_AFTER_MS = 90_000; // no heartbeat this long (but alive) → "quiet"

const eventsPath = (cfg: Config) => join(resolve(cfg.stateDir), "events.jsonl");
const statusPath = (cfg: Config) => join(resolve(cfg.stateDir), "status.json");

/** Append one orchestrator event to the durable feed. Never throws — observability must
 *  not be able to crash the harness. */
export async function recordEvent(cfg: Config, ev: Omit<ForemanEvent, "ts">): Promise<void> {
  try {
    await mkdir(resolve(cfg.stateDir), { recursive: true });
    const p = eventsPath(cfg);
    const s = await stat(p).catch(() => null);
    if (s && s.size > EVENTS_MAX_BYTES) {
      const lines = (await readFile(p, "utf8")).split("\n").filter(Boolean);
      await writeFile(p, `${lines.slice(-2000).join("\n")}\n`);
    }
    await appendFile(p, `${JSON.stringify({ ts: new Date().toISOString(), ...ev })}\n`);
  } catch {
    /* ignore */
  }
}

/** Snapshot the orchestrator's live status for the dashboard header. */
export async function writeStatus(cfg: Config, s: Omit<Status, "updatedAt">): Promise<void> {
  try {
    await mkdir(resolve(cfg.stateDir), { recursive: true });
    const full: Status = { ...s, updatedAt: new Date().toISOString() };
    // Write-then-rename so a concurrent dashboard read never sees a torn/partial status.json:
    // rename() is atomic within a filesystem, so the reader gets either the old file or the
    // complete new one. The temp name is pid-scoped to avoid clobbering a parallel writer's temp.
    const dest = statusPath(cfg);
    const tmp = `${dest}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(full, null, 2));
    await rename(tmp, dest);
  } catch {
    /* ignore */
  }
}

async function readStatus(cfg: Config): Promise<Status | null> {
  try {
    return JSON.parse(await readFile(statusPath(cfg), "utf8")) as Status;
  } catch {
    return null;
  }
}

/** Is a process still alive? ESRCH → gone; EPERM → exists but not ours (still alive). */
function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/** Derive display health from harness-observable signals only — no agent cooperation. */
function healthOf(status: Status | null): Health {
  if (!status) return "offline";
  if (!pidAlive(status.pid)) return "dead";
  if (status.state === "recycling") return "recycling";
  // The re-login relay blocks on the human for up to half an hour while re-stamping the status
  // between inbox polls (so it never reads "quiet"). Without this arm that block renders as plain
  // "working" green — the dashboard would look healthiest at the one moment the human watching it
  // is the only thing that can unwedge the harness.
  if (status.state === "auth-required") return "auth-required";
  const stale = Date.now() - new Date(status.updatedAt).getTime() > QUIET_AFTER_MS;
  return stale ? "quiet" : "working";
}

async function tailEvents(cfg: Config, n: number): Promise<ForemanEvent[]> {
  let lines: string[];
  try {
    lines = (await readFile(eventsPath(cfg), "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const out: ForemanEvent[] = [];
  for (const l of lines.slice(-n)) {
    try {
      out.push(JSON.parse(l) as ForemanEvent);
    } catch {
      // Skip a malformed/interleaved line — one bad line must not blank the whole feed.
    }
  }
  return out.reverse();
}

async function readWorkers(cfg: Config): Promise<Worker[]> {
  const dir = join(resolve(cfg.notesDir), "tasks");
  if (!existsSync(dir)) return [];
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    const out: Worker[] = [];
    for (const f of files) {
      const p = join(dir, f);
      const [body, s] = await Promise.all([readFile(p, "utf8"), stat(p)]);
      out.push({
        id: f.replace(/\.md$/, ""),
        status: parseStatus(body),
        updatedAt: s.mtime.toISOString(),
      });
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  } catch {
    return [];
  }
}

/** Best-effort worker status hint from its notes file: an explicit `status:` line wins,
 *  else a light keyword heuristic. Purely derived — not an authoritative state. */
export function parseStatus(md: string): string {
  const m = md.match(/^\s*status\s*[:=]\s*(.+)$/im);
  if (m?.[1]) return m[1].trim().toLowerCase();
  if (/\b(done|complete|completed|merged|finished)\b/i.test(md)) return "done";
  if (/\b(waiting|blocked|awaiting|ask-human)\b/i.test(md)) return "waiting";
  return "running";
}

async function snapshot(cfg: Config): Promise<{
  status: Status | null;
  health: Health;
  workers: Worker[];
  events: ForemanEvent[];
}> {
  const [status, workers, events] = await Promise.all([
    readStatus(cfg),
    readWorkers(cfg),
    tailEvents(cfg, 80),
  ]);
  return { status, health: healthOf(status), workers, events };
}

function sse(cfg: Config): Response {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const push = async () => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(await snapshot(cfg))}\n\n`));
        } catch {
          // Client gone (or the stream errored): stop the heartbeat so we don't leak the
          // interval if cancel() isn't also invoked for this teardown.
          if (timer) clearInterval(timer);
        }
      };
      void push();
      timer = setInterval(() => void push(), 1500);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** Run the dashboard server. Blocks forever (until the process is killed). */
export async function runDashboard(cfg: Config): Promise<void> {
  const server = Bun.serve({
    port: cfg.dashboardPort,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
      if (pathname === "/api/state") return Response.json(await snapshot(cfg));
      if (pathname === "/events") return sse(cfg);
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`[dashboard] http://127.0.0.1:${server.port}  (read-only)`);
  await new Promise<void>(() => {}); // keep the process alive until killed
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>foreman</title>
<style>
  :root{color-scheme:dark light}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    background:#0e1116;color:#d6dbe3}
  header{padding:16px 20px;border-bottom:1px solid #232a35;position:sticky;top:0;background:#0e1116;z-index:2}
  .row{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  h1{font-size:15px;margin:0;letter-spacing:.5px;color:#8ea0b6;font-weight:600}
  .dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:7px;vertical-align:middle}
  .health{font-weight:600}
  .working .dot{background:#3fb950;box-shadow:0 0 7px #3fb950}.working .health{color:#3fb950}
  .quiet .dot{background:#8b949e}.quiet .health{color:#8b949e}
  .recycling .dot{background:#58a6ff;box-shadow:0 0 7px #58a6ff}.recycling .health{color:#58a6ff}
  .auth-required .dot{background:#d29922;box-shadow:0 0 7px #d29922}.auth-required .health{color:#d29922}
  .dead .dot{background:#f85149;box-shadow:0 0 7px #f85149}.dead .health{color:#f85149}
  .offline .dot{background:#6b7686}.offline .health{color:#6b7686}
  .bar{flex:1;min-width:180px;height:10px;background:#1b222c;border-radius:6px;overflow:hidden}
  .fill{height:100%;background:linear-gradient(90deg,#2f81f7,#3fb950);transition:width .4s}
  .fill.warn{background:linear-gradient(90deg,#d29922,#f0883e)}
  .fill.hot{background:linear-gradient(90deg,#f0883e,#f85149)}
  .muted{color:#6b7686}
  main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);gap:16px;padding:16px 20px}
  @media(max-width:820px){main{grid-template-columns:1fr}}
  section{background:#141a22;border:1px solid #232a35;border-radius:10px;overflow:hidden}
  section h2{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6b7686;
    margin:0;padding:10px 14px;border-bottom:1px solid #232a35}
  .item{padding:9px 14px;border-bottom:1px solid #1b222c;display:flex;gap:10px;align-items:baseline}
  .item:last-child{border-bottom:0}
  .badge{font-size:11px;padding:1px 8px;border-radius:20px;white-space:nowrap}
  .running{background:#132a1a;color:#3fb950}.done{background:#12213a;color:#58a6ff}
  .waiting{background:#3a2a12;color:#e3b341}.blocked{background:#3a1414;color:#f85149}
  .wid{font-weight:600;color:#c9d3e0}.ago{margin-left:auto;color:#6b7686;font-size:12px}
  .kind{color:#8ea0b6;min-width:82px}.who{color:#6b7686;min-width:78px}
  .empty{padding:16px 14px;color:#6b7686}
  code{color:#adbac7}
</style></head><body>
<header>
  <div class="row" id="hrow">
    <h1>◧ FOREMAN</h1>
    <span id="conn"><span class="dot"></span><span class="health">connecting…</span></span>
    <span class="muted">life <b id="life">–</b></span>
    <div class="bar"><div class="fill" id="fill" style="width:0"></div></div>
    <span id="ctx" class="muted">ctx –</span>
    <span id="upd" class="muted"></span>
  </div>
</header>
<main>
  <section><h2>Workers</h2><div id="workers"><div class="empty">no worker task files yet</div></div></section>
  <section><h2>Activity</h2><div id="events"><div class="empty">no events yet</div></div></section>
</main>
<script>
const $=s=>document.querySelector(s);
const LABEL={working:"working",quiet:"quiet — no recent turns",recycling:"recycling context","auth-required":"waiting for you to re-authenticate",dead:"not responding",offline:"offline"};
function ago(iso){if(!iso)return"";const d=(Date.now()-new Date(iso))/1000;
  if(d<60)return Math.floor(d)+"s ago";if(d<3600)return Math.floor(d/60)+"m ago";
  if(d<86400)return Math.floor(d/3600)+"h ago";return Math.floor(d/86400)+"d ago"}
function esc(s){return(s??"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}
function render(d){
  const h=d.health||"offline";
  $("#hrow").className="row "+h;
  $("#conn").innerHTML='<span class="dot"></span><span class="health">'+(LABEL[h]||h)+'</span>';
  const st=d.status;
  if(st){
    $("#life").textContent="#"+st.life;
    $("#ctx").textContent="ctx "+st.ctxPct+"%  ("+(st.ctxUsed/1000|0)+"k/"+(st.ctxWindow/1000|0)+"k)";
    const f=$("#fill");f.style.width=Math.min(100,st.ctxPct)+"%";
    f.className="fill"+(st.ctxPct>=st.hardMark*100?" hot":st.ctxPct>=st.softMark*100?" warn":"");
    $("#upd").textContent=st.updatedAt?"heartbeat "+ago(st.updatedAt):"";
  }else{$("#ctx").textContent="ctx –";$("#upd").textContent="no status file yet"}
  const w=d.workers||[];
  $("#workers").innerHTML=w.length?w.map(x=>{
    const cls=({done:"done",waiting:"waiting",blocked:"blocked"})[x.status]||"running";
    return '<div class="item"><span class="badge '+cls+'">'+esc(x.status)+'</span>'+
      '<span class="wid">'+esc(x.id)+'</span><span class="ago">'+ago(x.updatedAt)+'</span></div>';
  }).join(""):'<div class="empty">no worker task files yet</div>';
  const ev=d.events||[];
  $("#events").innerHTML=ev.length?ev.map(e=>{
    const extra=e.ctx!=null?' <code>≈'+(e.ctx/1000|0)+'k</code>':(e.detail?' <code>'+esc(e.detail)+'</code>':'');
    return '<div class="item"><span class="who">'+esc(e.who)+'</span><span class="kind">'+esc(e.kind)+'</span>'+
      extra+'<span class="ago">'+ago(e.ts)+'</span></div>';
  }).join(""):'<div class="empty">no events yet</div>';
}
const es=new EventSource("/events");
es.onmessage=e=>render(JSON.parse(e.data));
es.onerror=()=>{$("#conn").innerHTML='<span class="dot"></span><span class="health muted">reconnecting…</span>'};
</script></body></html>`;
