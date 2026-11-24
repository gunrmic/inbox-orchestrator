import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GmailSource, PERSONAL_DOMAINS } from "../../src/gmail/client.js";
import { FixtureSource } from "../../src/gmail/source.js";
import { parseClientJson, authorizedClient, saveClientCredentials, clientCredentials, BUILTIN_CLIENT } from "../../src/gmail/auth.js";
import { setSecret } from "../../src/util/secrets.js";
import { Store } from "../../src/store/db.js";
import { email } from "../helpers.js";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const store = () => new Store(join(mkdtempSync(join(tmpdir(), "ibo-g-")), "s.db"));

function msg(id: string, from = "Jack <jack@coleven.com>", internalDate = "1700000000000") {
  return {
    id,
    threadId: `t-${id}`,
    internalDate,
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "Subject", value: id }], body: { data: b64(`body ${id}`) } },
  };
}

function fakeGmail(opts: { history?: string[]; listed?: string[]; historyError?: unknown; byId?: Record<string, ReturnType<typeof msg>> }) {
  return {
    users: {
      getProfile: vi.fn(async () => ({ data: { historyId: "100" } })),
      history: {
        list: vi.fn(async () => {
          if (opts.historyError) throw opts.historyError;
          return { data: { historyId: "200", history: [{ messagesAdded: (opts.history ?? []).map((id) => ({ message: { id } })) }] } };
        }),
      },
      messages: {
        list: vi.fn(async () => ({ data: { messages: (opts.listed ?? []).map((id) => ({ id })) } })),
        get: vi.fn(async ({ id }: { id: string }) => ({ data: opts.byId?.[id] ?? msg(id) })),
      },
    },
  };
}

describe("GmailSource.poll", () => {
  it("records the position on first run and returns nothing", async () => {
    const s = store();
    const g = fakeGmail({});
    expect(await new GmailSource(null, g as never).poll(s, "in:inbox")).toEqual([]);
    expect(s.get("gmail:historyId")).toBe("100");
    expect(g.users.history.list).not.toHaveBeenCalled();
  });

  it("returns new inbox mail that matches the query and advances the position", async () => {
    const s = store();
    s.set("gmail:historyId", "100");
    const g = fakeGmail({ history: ["a", "b", "c"], listed: ["a", "c"] });
    const emails = await new GmailSource(null, g as never).poll(s, "in:inbox");
    expect(emails.map((e) => e.id)).toEqual(["a", "c"]);
    expect(emails[0].fromAddress).toBe("jack@coleven.com");
    expect(s.get("gmail:historyId")).toBe("200");
    expect((g.users.messages.list.mock.calls[0] as unknown as [{ q: string }])[0].q).toContain("in:inbox");
  });

  it("skips mail already processed", async () => {
    const s = store();
    s.set("gmail:historyId", "100");
    s.saveEmail(email({ id: "a" }), null, {});
    const emails = await new GmailSource(null, fakeGmail({ history: ["a"], listed: ["a"] }) as never).poll(s, "q");
    expect(emails).toEqual([]);
  });

  it("resets when Gmail says the stored position expired", async () => {
    const s = store();
    s.set("gmail:historyId", "1");
    const g = fakeGmail({ historyError: Object.assign(new Error("gone"), { code: 404 }) });
    expect(await new GmailSource(null, g as never).poll(s, "q")).toEqual([]);
    expect(s.get("gmail:historyId")).toBe("100");
  });

  it("rethrows other errors", async () => {
    const s = store();
    s.set("gmail:historyId", "1");
    const g = fakeGmail({ historyError: Object.assign(new Error("quota"), { code: 429 }) });
    await expect(new GmailSource(null, g as never).poll(s, "q")).rejects.toThrow("quota");
  });

  it("requires an auth client or a Gmail object", () => {
    expect(() => new GmailSource(null)).toThrow();
  });
});

describe("GmailSource.senderStats", () => {
  it("groups senders by domain with counts and the newest date", async () => {
    const byId = {
      a: msg("a", "Jack <jack@coleven.com>", "1700000000000"),
      b: msg("b", "Ann <ann@coleven.com>", "1800000000000"),
      c: msg("c", "x@acme.io", "1600000000000"),
      d: msg("d", "no address"),
    };
    const g = fakeGmail({ listed: ["a", "b", "c", "d"], byId });
    const stats = await new GmailSource(null, g as never).senderStats(90);
    expect(stats[0]).toMatchObject({ domain: "coleven.com", count: 2 });
    expect(stats[0].senders.sort()).toEqual(["ann@coleven.com", "jack@coleven.com"]);
    expect(stats[0].last).toBe(new Date(1800000000000).toISOString());
    expect(stats.find((s) => s.domain === "acme.io")?.count).toBe(1);
    expect(stats).toHaveLength(2);
  });

  it("knows personal mail domains", () => {
    expect(PERSONAL_DOMAINS.has("gmail.com")).toBe(true);
  });
});

describe("FixtureSource", () => {
  it("returns emails from a JSON file that were not processed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ibo-fx-"));
    const file = join(dir, "inbox.json");
    const s = store();
    expect(await new FixtureSource(file).poll(s)).toEqual([]);
    writeFileSync(file, JSON.stringify([email({ id: "1" }), email({ id: "2" })]));
    s.saveEmail(email({ id: "1" }), null, {});
    expect((await new FixtureSource(file).poll(s)).map((e) => e.id)).toEqual(["2"]);
  });
});

describe("Gmail auth", () => {
  it("accepts the JSON shapes Google gives you", () => {
    const c = { client_id: "id", client_secret: "sec" };
    expect(parseClientJson(JSON.stringify({ installed: c }))).toEqual(c);
    expect(parseClientJson(JSON.stringify({ web: c }))).toEqual(c);
    expect(parseClientJson(JSON.stringify(c))).toEqual(c);
    expect(() => parseClientJson("{}")).toThrow(/client_id/);
  });

  it("uses the built-in client unless a saved client or env vars override it", async () => {
    expect(await clientCredentials()).toMatchObject({ ...BUILTIN_CLIENT, source: "builtin" });
    await saveClientCredentials(JSON.stringify({ installed: { client_id: "mine", client_secret: "s" } }));
    expect(await clientCredentials()).toMatchObject({ client_id: "mine", source: "saved" });
    process.env.IBO_GOOGLE_CLIENT_ID = "env-id";
    process.env.IBO_GOOGLE_CLIENT_SECRET = "env-sec";
    try {
      expect(await clientCredentials()).toMatchObject({ client_id: "env-id", source: "env" });
    } finally {
      delete process.env.IBO_GOOGLE_CLIENT_ID;
      delete process.env.IBO_GOOGLE_CLIENT_SECRET;
    }
  });

  it("needs a refresh token before it can authorize", async () => {
    await expect(authorizedClient()).rejects.toThrow(/not connected/);
    await saveClientCredentials(JSON.stringify({ installed: { client_id: "id", client_secret: "sec" } }));
    await expect(authorizedClient()).rejects.toThrow(/not connected/);
    await setSecret("google-refresh-token", "rt");
    const client = await authorizedClient();
    expect(client.credentials.refresh_token).toBe("rt");
  });
});
