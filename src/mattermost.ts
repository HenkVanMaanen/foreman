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

  async poll(
    state: string,
    destinations: { channels: string[]; humans: string[] },
  ): Promise<string[]> {
    const lines: string[] = [];
    for (const channel of destinations.channels) {
      const cursor = join(state, "wait-reply", `mm-${safeId(channel)}.json`);
      const since = readJson<number>(cursor, Date.now());
      if (!existsSync(cursor)) writeJson(cursor, since);
      const data = (await this.api(
        `/channels/${channel}/posts?since=${Math.max(0, since - 1)}`,
      )) as { posts: Record<string, Post> };
      if (!data.posts || typeof data.posts !== "object")
        throw new Error("invalid Mattermost posts response");
      let newest = since;
      for (const post of authorizedPosts(Object.values(data.posts), channel, destinations.humans)) {
        const path = receiptPath(state, channel, post.id);
        if (post.at < since) continue;
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
  try {
    const mm = new Mattermost(process.env);
    const destinations = await mm.destinations();
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
    process.exit(1);
  }
}
