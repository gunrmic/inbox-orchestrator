import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProjects, saveProjects } from "../../src/config/load.js";
import { diffCandidates, listSuggestions, rediscoverDue, resolveSuggestion } from "../../src/discovery/rediscover.js";
import { findExports } from "../../src/discovery/exports.js";
import { DefaultExecutor } from "../../src/executors/index.js";
import { meetingStats } from "../../src/gmail/calendar.js";
import { GmailSource } from "../../src/gmail/client.js";
import { AnthropicProvider, ClaudeCliProvider, OllamaProvider } from "../../src/models/providers.js";
import { applyAssignment, suggestAssignment } from "../../src/pipeline/assign.js";
import { Store } from "../../src/store/db.js";
import { extractJson, hasClaude, resetClaudeCache, resultText, runClaude } from "../../src/util/claude-cli.js";
import { renderPlist } from "../../src/util/launchd.js";
import { notify } from "../../src/util/notify.js";
import { canSelfUpdate, selfUpdate } from "../../src/util/update.js";
import { email, project, settings } from "../helpers.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** Installs the fake `claude` and points IBO_CLAUDE_BIN at it. Returns the call log path. */
function fakeClaude(result: string, extra: Record<string, string> = {}): string {
  const bin = tmp("fake-claude-");
  const target = join(bin, "claude");
  copyFileSync(fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url)), target);
  chmodSync(target, 0o755);
  const log = join(bin, "calls.jsonl");
  Object.assign(process.env, { IBO_CLAUDE_BIN: target, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_RESULT: result, ...extra });
  resetClaudeCache();
  return log;
}
const calls = (log: string) => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["IBO_CLAUDE_BIN", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_RESULT", "FAKE_CLAUDE_ERROR", "IBO_NO_AUTO_UPDATE"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetClaudeCache();
});

describe("Claude through the Claude Code login", () => {
  it("parses answers with fences or prose around the JSON", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json")).toThrow(/No JSON/);
    expect(resultText(JSON.stringify({ result: "hi" }))).toBe("hi");
    expect(resultText("plain")).toBe("plain");
    expect(() => resultText(JSON.stringify({ is_error: true, result: "quota" }))).toThrow(/quota/);
  });

  it("is used when there is no API key, with every tool off and the system prompt passed", async () => {
    const log = fakeClaude('```json\n{"hasAction":true}\n```');
    expect(await hasClaude()).toBe(true);
    const provider = new AnthropicProvider(async () => null);
    expect(await provider.route()).toBe("claude-code");
    const out = await provider.structured("claude-sonnet-5-5", { system: "SYS", user: "EMAIL", name: "triage", description: "d", schema: { type: "object" } });
    expect(out).toEqual({ hasAction: true });
    const [call] = calls(log).filter((c) => c.args[0] === "-p");
    expect(call.args).toEqual(expect.arrayContaining(["--system-prompt", "SYS", "--model", "claude-sonnet-5-5", "--max-turns", "1", "--strict-mcp-config"]));
    expect(call.args[call.args.indexOf("--disallowedTools") + 1]).toMatch(/Bash.*WebFetch/);
    expect(call.stdin).toContain("EMAIL");
    expect(call.stdin).toContain('"type":"object"');
  });

  it("prefers the API key, and reports nothing when neither exists", async () => {
    expect(await new AnthropicProvider(async () => "k").route()).toBe("api");
    process.env.IBO_CLAUDE_BIN = join(tmpdir(), "missing-claude");
    resetClaudeCache();
    expect(await new AnthropicProvider(async () => null).route()).toBeNull();
    expect(await new ClaudeCliProvider().available()).toBe(false);
    await expect(runClaude(["-p"])).rejects.toThrow(/Could not start Claude Code/);
  });

  it("surfaces a failing claude run", async () => {
    fakeClaude("", { FAKE_CLAUDE_ERROR: "1" });
    await expect(new ClaudeCliProvider().structured("m", { system: "s", user: "u", name: "n", description: "d", schema: {} })).rejects.toThrow();
  });
});

describe("claude.ai connectors through Claude Code", () => {
  it("calls a claude_ai_ tool through Claude Code, allowing only that tool", async () => {
    const log = fakeClaude("Task created: #12");
    const hub = { names: () => ["local"], callTool: vi.fn() };
    const ex = new DefaultExecutor(hub as never);
    const record = { id: 1, args: { title: "Fix date filter", _assign: { x: 1 } }, summary: "s" } as never;
    const out = await ex.run({ record, step: { kind: "mcp", server: "claude_ai_Base44", tool: "create_task" }, project: null, email: null });
    expect(out).toBe("Task created: #12");
    expect(hub.callTool).not.toHaveBeenCalled();
    const [call] = calls(log);
    expect(call.args[call.args.indexOf("--allowedTools") + 1]).toBe("mcp__claude_ai_Base44__create_task");
    expect(call.stdin).toContain('"title": "Fix date filter"');
    expect(call.stdin).not.toContain("_assign");
  });

  it("uses the local server when one with that name is configured", async () => {
    const hub = { names: () => ["claude_ai_Base44"], callTool: vi.fn(async () => "local ok") };
    const ex = new DefaultExecutor(hub as never);
    const record = { id: 1, args: {}, summary: "s" } as never;
    expect(await ex.run({ record, step: { kind: "mcp", server: "claude_ai_Base44", tool: "t" }, project: null, email: null })).toBe("local ok");
  });
});

describe("sent mail and calendar", () => {
  it("counts the domains you write to, skipping your own and personal ones", async () => {
    const headers = (to: string, cc = "") => ({ data: { internalDate: "1763000000000", payload: { headers: [{ name: "To", value: to }, { name: "Cc", value: cc }] } } });
    const byId: Record<string, unknown> = {
      a: headers("Jack <jack@coleven.com>, me2@pele.ai", "x@gmail.com"),
      b: headers("ann@coleven.com"),
      c: headers("ceo@acme.io"),
    };
    const g = {
      users: {
        getProfile: vi.fn(async () => ({ data: { emailAddress: "omer@pele.ai" } })),
        messages: { list: vi.fn(async () => ({ data: { messages: [{ id: "a" }, { id: "b" }, { id: "c" }] } })), get: vi.fn(async ({ id }: { id: string }) => byId[id]) },
      },
    };
    const stats = await new GmailSource(null, g as never).recipientStats(90);
    expect(stats).toEqual([
      { domain: "coleven.com", count: 2, last: new Date(1763000000000).toISOString() },
      { domain: "acme.io", count: 1, last: new Date(1763000000000).toISOString() },
    ]);
    expect((g.users.messages.list.mock.calls[0] as unknown as [{ q: string }])[0].q).toContain("in:sent");
  });

  it("counts external meeting attendees by domain", async () => {
    const events = [
      { summary: "KOL sync", start: { dateTime: "2026-11-20T10:00:00Z" }, attendees: [{ email: "omer@pele.ai", self: true }, { email: "r@admetec.com" }, { email: "room@resource.calendar.google.com", resource: true }] },
      { summary: "Weekly", start: { date: "2026-11-21" }, attendees: [{ email: "omer@pele.ai", self: true }, { email: "l@admetec.com" }, { email: "mom@gmail.com" }, { email: "shachar@pele.ai" }] },
      { summary: "Solo" },
    ];
    const cal = { events: { list: vi.fn(async () => ({ data: { items: events } })) } };
    const stats = await meetingStats(null, 90, cal as never);
    expect(stats).toEqual([{ domain: "admetec.com", count: 2, last: "2026-11-21T00:00:00.000Z", titles: ["KOL sync", "Weekly"] }]);
  });
});

describe("which project is this sender?", () => {
  beforeEach(() => {
    saveProjects({ projects: [project({ id: "hawk-graph", name: "Hawk Graph", match: { senders: [], domains: [], keywords: ["coleven"] } }), project({ id: "shamir" })] });
  });

  it("suggests the project whose name matches the sender's organisation", () => {
    const a = suggestAssignment(email({ from: "Jack <jack@coleven.com>", fromAddress: "jack@coleven.com" }), loadProjects().projects);
    expect(a).toMatchObject({ domain: "coleven.com", scope: "domain", suggestions: ["hawk-graph"], newName: "coleven" });
    const p = suggestAssignment(email({ from: "Dana Levi <dana@gmail.com>", fromAddress: "dana@gmail.com", subject: "hi" }), loadProjects().projects);
    expect(p).toMatchObject({ scope: "sender", suggestions: [], newName: "Dana Levi" });
  });

  it("adds the domain or sender to a project, or creates one", () => {
    expect(applyAssignment({ project: "hawk-graph", scope: "domain", domain: "coleven.com", sender: "jack@coleven.com" })).toBe("hawk-graph");
    expect(applyAssignment({ project: "hawk-graph", scope: "domain", domain: "coleven.com", sender: "jack@coleven.com" })).toBe("hawk-graph");
    expect(applyAssignment({ project: "new", name: "Shamir", scope: "sender", domain: "gmail.com", sender: "dana@gmail.com" })).toBe("shamir-2");
    const byId = Object.fromEntries(loadProjects().projects.map((p) => [p.id, p]));
    expect(byId["hawk-graph"].match.domains).toEqual(["coleven.com"]);
    expect(byId["shamir-2"].match.senders).toEqual(["dana@gmail.com"]);
    expect(byId["shamir-2"].playbook.create_reminder).toEqual({ kind: "reminder" });
    expect(() => applyAssignment({ project: "nope", scope: "domain", domain: "x", sender: "y" })).toThrow(/Unknown project/);
  });
});

describe("weekly rediscovery", () => {
  const cand = (id: string, status: "live" | "dormant" | "dead", domains: string[] = [], confidence = 0.6) => ({
    project: project({ id, status, lastActivity: "2026-11-01T00:00:00Z", match: { senders: [], domains, keywords: [] } }),
    evidence: [`e-${id}`],
    confidence,
    summary: "",
  });

  it("suggests new live projects and status changes, not known or dismissed ones", () => {
    const existing = [project({ id: "hawk", status: "live" }), project({ id: "old", status: "dormant" }), project({ id: "acme", match: { senders: [], domains: ["acme.io"], keywords: [] } })];
    const out = diffCandidates(
      [cand("hawk", "dead"), cand("old", "live"), cand("fresh", "live"), cand("weak", "live", [], 0.4), cand("gone", "dead"), cand("acme-co", "live", ["acme.io"]), cand("nope", "live")],
      existing,
      (id) => id === "new:nope",
    );
    expect(out.map((s) => s.id)).toEqual(["status:hawk:dead", "status:old:live", "new:fresh"]);
  });

  it("accepting adds or updates the project; dismissing remembers the answer", () => {
    const store = new Store(join(process.env.IBO_HOME!, "s.db"));
    saveProjects({ projects: [project({ id: "hawk" })] });
    store.set(
      "suggestions",
      JSON.stringify([
        { id: "new:fresh", kind: "new", text: "t", evidence: [], project: project({ id: "fresh" }) },
        { id: "status:hawk:dead", kind: "status", text: "t", evidence: [], projectId: "hawk", status: "dead" },
        { id: "new:x", kind: "new", text: "t", evidence: [], project: project({ id: "x" }) },
      ]),
    );
    expect(resolveSuggestion(store, "new:fresh", true)).toEqual({ ok: true });
    expect(resolveSuggestion(store, "status:hawk:dead", true)).toEqual({ ok: true });
    expect(resolveSuggestion(store, "new:x", false)).toEqual({ ok: true });
    expect(resolveSuggestion(store, "missing", true)).toEqual({ error: "not found" });
    expect(listSuggestions(store)).toEqual([]);
    expect(store.get("suggestion:dismissed:new:x")).not.toBeNull();
    const byId = Object.fromEntries(loadProjects().projects.map((p) => [p.id, p]));
    expect(byId.fresh).toBeDefined();
    expect(byId.hawk.status).toBe("dead");
    expect(rediscoverDue(store, 7)).toBe(true);
    store.set("rediscover:last", new Date().toISOString());
    expect(rediscoverDue(store, 7)).toBe(false);
    expect(rediscoverDue(store, 7, Date.now() + 8 * 86_400_000)).toBe(true);
    expect(rediscoverDue(store, 0)).toBe(false);
    store.close();
  });
});

describe("self update", () => {
  const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd }).toString().trim();

  it("only updates installer checkouts, and goes back when the new version does not build", async () => {
    const remote = tmp("remote-");
    git(remote, "init", "-q", "-b", "main");
    writeFileSync(join(remote, "a.txt"), "1");
    git(remote, "add", ".");
    git(remote, "commit", "-qm", "one");
    const app = join(tmp("app-"), "app");
    execFileSync("git", ["clone", "-q", remote, app]);
    delete process.env.IBO_NO_AUTO_UPDATE;
    expect(canSelfUpdate(app)).toBe(false);
    writeFileSync(join(app, ".ibo-installed"), "");
    expect(canSelfUpdate(app)).toBe(true);
    process.env.IBO_NO_AUTO_UPDATE = "1";
    expect(canSelfUpdate(app)).toBe(false);

    const from = git(app, "rev-parse", "HEAD");
    expect(await selfUpdate(app)).toEqual({ updated: false, from, to: from });
    writeFileSync(join(remote, "a.txt"), "2");
    git(remote, "commit", "-qam", "two");
    const res = await selfUpdate(app);
    expect(res.updated).toBe(false);
    expect(res.error).toBeTruthy();
    expect(git(app, "rev-parse", "HEAD")).toBe(from);
    expect(await selfUpdate(tmp("not-git-"))).toEqual({ updated: false, error: "not a git install" });
  }, 120_000);
});

describe("small pieces", () => {
  it("adds extra environment variables to the launchd plist", () => {
    expect(renderPlist("/e", "/c", "/bin", { ELECTRON_RUN_AS_NODE: "1" })).toContain("<key>ELECTRON_RUN_AS_NODE</key><string>1</string>");
  });

  it("does not notify in tests", () => {
    expect(() => notify("t", "b")).not.toThrow();
  });

  it("finds Claude and ChatGPT exports among recent zips", () => {
    const dir = tmp("downloads-");
    const src = tmp("export-src-");
    writeFileSync(join(src, "conversations.json"), "[]");
    writeFileSync(join(src, "other.txt"), "x");
    execFileSync("zip", ["-q", "-j", join(dir, "data-2026.zip"), join(src, "conversations.json")]);
    execFileSync("zip", ["-q", "-j", join(dir, "photos.zip"), join(src, "other.txt")]);
    execFileSync("zip", ["-q", "-j", join(dir, "old.zip"), join(src, "conversations.json")]);
    const old = new Date(Date.now() - 90 * 86_400_000);
    utimesSync(join(dir, "old.zip"), old, old);
    writeFileSync(join(dir, "broken.zip"), "nope");
    expect(findExports(dir)).toEqual([join(dir, "data-2026.zip")]);
    expect(findExports(join(dir, "missing"))).toEqual([]);
  });

  it("pulls a missing local model", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
      return new Response("{}");
    });
    const o = new OllamaProvider("http://x", fetchImpl as never);
    expect(await o.hasModel("qwen3:8b")).toBe(true);
    expect(await o.hasModel("llama3")).toBe(false);
    await o.pull("llama3");
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("http://x/api/pull");
    const bad = new OllamaProvider("http://x", (async () => new Response("", { status: 500 })) as never);
    await expect(bad.pull("m")).rejects.toThrow(/could not pull/);
    expect(existsSync).toBeDefined();
    expect(settings().maintenance).toEqual({ rediscoverDays: 7, autoUpdate: true, notify: true });
  });
});
