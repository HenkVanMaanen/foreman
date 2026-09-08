// Feature-on transport, called by the existing wait-reply poller. No second inbox consumer.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, safeId, writeJson } from "./thread-store.ts";

export interface HumanPost {
  id: string;
  channel: string;
  root: string;
  sender: string;
  text: string;
  at: number;
}
interface Post {
  id: string;
  channel_id: string;
  root_id: string;
  user_id: string;
  message: string;
  create_at: number;
  delete_at?: number;
  type?: string;
  props?: { from_webhook?: string | boolean };
}
export const receiptPath = (state: string, channel: string, id: string) =>
  join(state, "thread-inbox", `${safeId(channel)}.${safeId(id)}.json`);
export const postLine = (post: HumanPost) =>
  `MSG mm:${post.channel}:${post.id} ${post.root} ${post.text.replace(/[\r\n\t]+/g, " ")}`;

/** Validate provenance even when the server unexpectedly returns posts from another channel. */
export function authorizedPosts(posts: Post[], channel: string, humans: string[]): HumanPost[] {
  return posts
    .filter(
      (p) =>
        p.channel_id === channel &&
        humans.includes(p.user_id) &&
        // Webhooks inherit their owner's user_id without authenticating that human.
        !p.props?.from_webhook &&
        !p.delete_at &&
        !p.type &&
        typeof p.message === "string",
    )
    .sort((a, b) => a.create_at - b.create_at || a.id.localeCompare(b.id))
    .map((p) => ({
      id: safeId(p.id),
      channel: safeId(channel),
      root: safeId(p.root_id || p.id),
      sender: safeId(p.user_id),
      text: p.message,
      at: p.create_at,
    }));
}

/** Pick a window crossing the last read index using Mattermost's page * per_page offset.
 * E.g. after [0, 200), page=1/per_page=199 reads [199, 398), retaining a boundary witness.
 */
function overlappingPage(end: number): { page: number; perPage: number } {
  let next: { page: number; perPage: number } | undefined;
  let nextEnd = end;
  for (let perPage = 200; perPage >= 2; perPage--) {
    const page = Math.floor((end - 1) / perPage);
    const candidateEnd = (page + 1) * perPage;
    if (candidateEnd > nextEnd) {
      next = { page, perPage };
      nextEnd = candidateEnd;
    }
  }
  if (!next) throw new Error("cannot overlap Mattermost posts page");
  return next;
}

export class Mattermost {
  constructor(
    private env: Record<string, string | undefined>,
    private request: typeof fetch = fetch,
  ) {}

  async api(path: string, body?: unknown): Promise<unknown> {
    const base = this.env["MATTERMOST_BASE_URL"];
    const token = this.env["MATTERMOST_BOT_TOKEN"];
    if (!base || !token) throw new Error("Mattermost credentials are not configured");
    const response = await this.request(`${base.replace(/\/$/, "")}/api/v4${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Mattermost HTTP ${response.status}`);
    return response.json();
  }

  async destinations(): Promise<{ channels: string[]; humans: string[] }> {
    const names = (this.env["MATTERMOST_ALLOWED_USERS"] || this.env["MATTERMOST_TARGET_USER"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) throw new Error("Mattermost requires MATTERMOST_ALLOWED_USERS (usernames)");
    const humans: string[] = [];
    for (const name of names) {
      const user = (await this.api(`/users/username/${encodeURIComponent(name)}`)) as {
        id: string;
      };
      humans.push(safeId(user.id));
    }
    const channels: string[] = [];
    const team = this.env["MATTERMOST_TEAM"];
    const channelNames = this.env["MATTERMOST_CHANNELS"];
    if (team && channelNames) {
      for (const name of channelNames
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        const channel = (await this.api(
          `/teams/name/${encodeURIComponent(team)}/channels/name/${encodeURIComponent(name)}`,
        )) as { id: string };
        channels.push(safeId(channel.id));
      }
    } else if (this.env["MATTERMOST_CHANNEL_ID"]) {
      channels.push(safeId(this.env["MATTERMOST_CHANNEL_ID"]));
    }
    if (!channels.length)
      throw new Error("Set MATTERMOST_TEAM and MATTERMOST_CHANNELS, or MATTERMOST_CHANNEL_ID");
    return { channels, humans };
  }

  /** Reordering ties can hide rows even when the overlap witness survives. The final
   * page's offset plus its rows at/after `since` bounds the number of unread rows.
   * Re-fetch the collected IDs AFTER that page: IDs observed before it and still live
   * afterwards belonged to that set. Matching its size proves coverage; counting stale
   * IDs alone would let an already-read deletion conceal a missing, reordered tie.
   */
  private async verifyCoverage(
    posts: Map<string, Post>,
    channel: string,
    since: number,
    expected: number,
  ): Promise<boolean> {
    const ids = [...posts.values()].filter((p) => p.create_at >= since).map((p) => p.id);
    if (ids.length < expected) return false;
    const live = new Map<string, Post>();
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const requested = ids.slice(offset, offset + 1000);
      const current = (await this.api("/posts/ids", requested)) as Post[];
      if (!Array.isArray(current) || current.some((p) => !p || !Number.isFinite(p.create_at)))
        throw new Error("invalid Mattermost posts verification response");
      for (const post of current) {
        if (
          requested.includes(post.id) &&
          post.channel_id === channel &&
          !post.delete_at &&
          post.create_at === posts.get(post.id)?.create_at
        )
          live.set(post.id, post);
      }
    }
    if (live.size !== expected) return false;
    posts.clear();
    for (const [id, post] of live) posts.set(id, post);
    return true;
  }

  async poll(
    state: string,
    destinations: { channels: string[]; humans: string[] },
  ): Promise<string[]> {
    const lines: string[] = [];
    const startedAt = Date.now();
    // Persist every initial cursor before a polling failure can interrupt activation.
    const cursors = destinations.channels.map((channel) => {
      const cursor = join(state, "wait-reply", `mm-${safeId(channel)}.json`);
      const since = readJson<number>(cursor, startedAt);
      if (!existsSync(cursor)) writeJson(cursor, since);
      return { channel, cursor, since };
    });
    for (const { channel, cursor, since } of cursors) {
      const posts = new Map<string, Post>();
      // `since` is capped at 1,000 and `before` excludes equal-timestamp posts. Read
      // overlapping ordinary pages, verifying both continuity and live ID coverage.
      let window = { page: 0, perPage: 200 };
      let boundary: string | undefined;
      let restarts = 0;
      for (;;) {
        const { page, perPage } = window;
        const data = (await this.api(
          `/channels/${channel}/posts?page=${page}&per_page=${perPage}`,
        )) as {
          posts: Record<string, Post>;
          order?: string[];
        };
        if (!data.posts || typeof data.posts !== "object")
          throw new Error("invalid Mattermost posts response");
        // The map can also contain old thread roots that are not part of this page.
        const batch = data.order
          ? data.order.map((id) => data.posts[id])
          : Object.values(data.posts);
        if (
          batch.some(
            (post, i) =>
              !post ||
              !Number.isFinite(post.create_at) ||
              (data.order && i > 0 && post.create_at > (batch[i - 1]?.create_at ?? 0)),
          )
        )
          throw new Error("invalid Mattermost posts response");
        if (boundary && !data.order)
          throw new Error("Mattermost pagination requires ordered posts");
        const continuous = !boundary || batch.some((post) => post?.id === boundary);
        for (const post of batch) {
          if (post && post.channel_id === channel) posts.set(post.id, post);
        }
        const complete =
          batch.length < perPage ||
          batch.some((post) => post?.channel_id === channel && post.create_at < since);
        if (
          !continuous ||
          (complete &&
            page > 0 &&
            !(await this.verifyCoverage(
              posts,
              channel,
              since,
              page * perPage + batch.filter((post) => post && post.create_at >= since).length,
            )))
        ) {
          // Deletion can move the boundary before this offset (or delete it). A short
          // page or surviving witness is not proof of completion without full coverage.
          if (++restarts >= 3) throw new Error("Mattermost posts changed during pagination; retry");
          posts.clear();
          window = { page: 0, perPage: 200 };
          boundary = undefined;
          continue;
        }
        if (complete) break;
        // Only the ordered page identifies its final row; map entries may be thread roots.
        if (!data.order) throw new Error("Mattermost pagination requires ordered posts");
        boundary = batch.at(-1)?.id;
        window = overlappingPage((page + 1) * perPage);
      }
      let newest = since;
      for (const post of authorizedPosts([...posts.values()], channel, destinations.humans)) {
        if (post.at < since) continue;
        const path = receiptPath(state, channel, post.id);
        if (!existsSync(path)) {
          // Commit the receipt BEFORE the cursor. Supervisor scans these after a crash even if
          // stdout never reached it. The timestamp overlap + receipt id handles equal timestamps.
          writeJson(path, post);
          lines.push(postLine(post));
        }
        newest = Math.max(newest, post.at);
      }
      writeJson(cursor, newest);
    }
    return lines;
  }

  async reply(channel: string, root: string, text: string): Promise<string> {
    const post = (await this.api("/posts", {
      channel_id: safeId(channel),
      root_id: safeId(root),
      message: text,
    })) as { id: string };
    return safeId(post.id);
  }
}

if (import.meta.main) {
  let setupComplete = false;
  try {
    const mm = new Mattermost(process.env);
    const destinations = await mm.destinations();
    setupComplete = true;
    const state = process.env["FOREMAN_STATE_DIR"] || "state";
    const deadline = Date.now() + Number(process.env["FOREMAN_WAIT_TIMEOUT"] || 250) * 1000;
    do {
      const lines = await mm.poll(state, destinations);
      if (lines.length) {
        console.log(lines.join("\n"));
        process.exit(0);
      }
      await Bun.sleep(1000);
    } while (Date.now() < deadline);
    process.exit(3);
  } catch (error) {
    console.error(`wait-reply: ${error instanceof Error ? error.message : "Mattermost failed"}`);
    // The shell may use Telegram in auto mode only when Mattermost setup failed.
    process.exit(setupComplete ? 1 : 2);
  }
}
