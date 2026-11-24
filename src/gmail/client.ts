import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Store } from "../store/db.js";
import type { Email } from "../types.js";
import { addressOf, parseMessage } from "./parse.js";
import type { EmailSource } from "./source.js";

export class GmailSource implements EmailSource {
  private gmail: gmail_v1.Gmail;

  /** Pass a ready Gmail API object to inject a fake in tests. */
  constructor(auth: OAuth2Client | null, gmail?: gmail_v1.Gmail) {
    if (gmail) this.gmail = gmail;
    else if (auth) this.gmail = google.gmail({ version: "v1", auth });
    else throw new Error("GmailSource needs an OAuth client or a Gmail API object.");
  }

  async getEmail(id: string): Promise<Email> {
    const res = await this.gmail.users.messages.get({ userId: "me", id, format: "full" });
    return parseMessage(res.data);
  }

  /**
   * Returns emails that arrived since the last call, using Gmail's history API.
   * The first call records the current position and returns nothing, so installing
   * the agent never replays an old inbox. If the stored position expired, it resets.
   */
  async poll(store: Store, query: string): Promise<Email[]> {
    const startHistoryId = store.get("gmail:historyId");
    if (!startHistoryId) {
      const profile = await this.gmail.users.getProfile({ userId: "me" });
      store.set("gmail:historyId", String(profile.data.historyId));
      return [];
    }

    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latest = startHistoryId;
    try {
      do {
        const res = await this.gmail.users.history.list({
          userId: "me",
          startHistoryId,
          historyTypes: ["messageAdded"],
          labelId: "INBOX",
          pageToken,
        });
        for (const h of res.data.history ?? []) {
          for (const m of h.messagesAdded ?? []) if (m.message?.id) ids.add(m.message.id);
        }
        if (res.data.historyId) latest = String(res.data.historyId);
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (err: any) {
      if (err?.code === 404) {
        const profile = await this.gmail.users.getProfile({ userId: "me" });
        store.set("gmail:historyId", String(profile.data.historyId));
        return [];
      }
      throw err;
    }

    // Apply the user's query (skip promotions etc.) by intersecting with a search.
    const allowed = new Set<string>();
    if (ids.size > 0) {
      const res = await this.gmail.users.messages.list({ userId: "me", q: `${query} newer_than:2d`, maxResults: 200 });
      for (const m of res.data.messages ?? []) if (m.id) allowed.add(m.id);
    }

    const emails: Email[] = [];
    for (const id of ids) {
      if (!allowed.has(id) || store.hasEmail(id)) continue;
      emails.push(await this.getEmail(id));
    }
    store.set("gmail:historyId", latest);
    return emails;
  }

  /** Sender statistics for discovery: who wrote to you in the last N days, grouped by domain. */
  async senderStats(days = 90, max = 1500): Promise<{ domain: string; count: number; senders: string[]; last: string }[]> {
    const byDomain = new Map<string, { count: number; senders: Set<string>; last: string }>();
    let pageToken: string | undefined;
    let seen = 0;
    do {
      const list = await this.gmail.users.messages.list({
        userId: "me",
        q: `newer_than:${days}d -category:promotions -category:social -category:updates -from:me`,
        maxResults: 500,
        pageToken,
      });
      for (const m of list.data.messages ?? []) {
        if (!m.id || seen >= max) break;
        seen += 1;
        const res = await this.gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "metadata",
          metadataHeaders: ["From", "Date"],
        });
        const from = res.data.payload?.headers?.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
        const address = addressOf(from);
        const domain = address.split("@")[1];
        if (!domain) continue;
        const date = new Date(Number(res.data.internalDate ?? 0)).toISOString();
        const d = byDomain.get(domain) ?? { count: 0, senders: new Set<string>(), last: date };
        d.count += 1;
        d.senders.add(address);
        if (date > d.last) d.last = date;
        byDomain.set(domain, d);
      }
      pageToken = seen < max ? (list.data.nextPageToken ?? undefined) : undefined;
    } while (pageToken);

    return [...byDomain.entries()]
      .map(([domain, d]) => ({ domain, count: d.count, senders: [...d.senders], last: d.last }))
      .sort((a, b) => b.count - a.count);
  }
}

/** Free mail providers are never treated as a project domain on their own. */
export const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "walla.co.il",
  "proton.me",
  "protonmail.com",
]);
