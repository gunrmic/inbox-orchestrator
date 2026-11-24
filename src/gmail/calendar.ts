import { calendar as calendarApi, type calendar_v3 } from "@googleapis/calendar";
import type { OAuth2Client } from "google-auth-library";
import { PERSONAL_DOMAINS } from "./client.js";

export interface MeetingDomain {
  domain: string;
  count: number;
  last: string;
  titles: string[];
}

/**
 * Domains of people you met with in the last `days` (primary calendar, read-only).
 * External attendees on a meeting are a strong sign of a client or project.
 */
export async function meetingStats(auth: OAuth2Client | null, days = 90, cal?: calendar_v3.Calendar): Promise<MeetingDomain[]> {
  const calendar = cal ?? calendarApi({ version: "v3", auth: auth ?? undefined });
  const byDomain = new Map<string, { count: number; last: string; titles: Set<string> }>();
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: new Date(Date.now() - days * 86_400_000).toISOString(),
      timeMax: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    });
    for (const ev of res.data.items ?? []) {
      const attendees = ev.attendees ?? [];
      const own = attendees.find((a) => a.self)?.email?.split("@")[1]?.toLowerCase();
      const when = ev.start?.dateTime ?? ev.start?.date ?? "";
      const domains = new Set<string>();
      for (const a of attendees) {
        const d = a.email?.split("@")[1]?.toLowerCase();
        if (!d || a.self || d === own || PERSONAL_DOMAINS.has(d) || d.endsWith("calendar.google.com") || a.resource) continue;
        domains.add(d);
      }
      for (const d of domains) {
        const cur = byDomain.get(d) ?? { count: 0, last: "", titles: new Set<string>() };
        cur.count += 1;
        const iso = when ? new Date(when).toISOString() : "";
        if (iso > cur.last) cur.last = iso;
        if (ev.summary && cur.titles.size < 5) cur.titles.add(ev.summary);
        byDomain.set(d, cur);
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ++pages < 5);
  return [...byDomain.entries()]
    .map(([domain, d]) => ({ domain, count: d.count, last: d.last, titles: [...d.titles] }))
    .sort((a, b) => b.count - a.count);
}
