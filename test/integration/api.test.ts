import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { saveProjects, saveSettings, saveTools, loadProjects, loadSettings } from "../../src/config/load.js";
import { paths } from "../../src/config/paths.js";
import { Settings } from "../../src/config/schema.js";
import { buildRuntime, type Runtime } from "../../src/runtime.js";
import { apiToken, buildApi } from "../../src/server/api.js";
import { email, project } from "../helpers.js";

let rt: Runtime;
let app: FastifyInstance;
let auth: Record<string, string>;
const executed: string[] = [];

beforeEach(() => {
  executed.length = 0;
  saveSettings(Settings.parse({ promotion: { threshold: 3 } }));
  saveProjects({
    projects: [
      project({
        id: "hawk",
        playbook: { schedule_meeting: { kind: "mcp", server: "gcal", tool: "create_event" } },
      }),
    ],
  });
  saveTools({ tools: { "gcal/create_event": 2 } });
  rt = buildRuntime(() => {});
  rt.executor = {
    run: async ({ record }) => {
      executed.push(`${record.action}:${JSON.stringify(record.args)}`);
      if (record.args.fail) throw new Error("tool exploded");
      return "ok";
    },
  };
  app = buildApi(rt);
  auth = { authorization: `Bearer ${apiToken()}` };
});

afterEach(async () => {
  await app.close();
  await rt.close();
});

function pendingCard(args: Record<string, unknown> = { title: "Meet" }) {
  rt.store.saveEmail(email({ id: `e-${Math.random()}` }), "hawk", {});
  const e = rt.store.db.prepare("SELECT id FROM emails ORDER BY rowid DESC LIMIT 1").get() as unknown as { id: string };
  return rt.store.addAction({
    emailId: e.id,
    projectId: "hawk",
    action: "schedule_meeting",
    summary: "Meet Jack",
    args,
    decision: { kind: "suggest", risk: 2, reason: "Visible to others" },
  });
}

describe("local API", () => {
  it("rejects requests without the token, and the token file is private", async () => {
    expect((await app.inject({ url: "/status" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/status", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect(statSync(paths.token).mode & 0o777).toBe(0o600);
    expect(apiToken()).toBe(apiToken());
  });

  it("reports status and lists pending cards with their email", async () => {
    pendingCard();
    const status = (await app.inject({ url: "/status", headers: auth })).json();
    expect(status).toMatchObject({ mode: "suggest", killSwitch: false, pending: 1, projects: [{ id: "hawk", status: "live" }] });
    const list = (await app.inject({ url: "/actions?status=pending", headers: auth })).json();
    expect(list[0]).toMatchObject({ action: "schedule_meeting", email: { subject: "Graph does not load when filtering by date" } });
  });

  it("approves: runs the executor, stores the result, counts the streak", async () => {
    const card = pendingCard();
    const res = (await app.inject({ method: "POST", url: `/actions/${card.id}/approve`, headers: auth })).json();
    expect(res.action).toMatchObject({ status: "done", result: "ok" });
    expect(executed).toEqual(['schedule_meeting:{"title":"Meet"}']);
    expect(res.offerPromotion).toBe(false);
    // Approving twice is refused
    expect((await app.inject({ method: "POST", url: `/actions/${card.id}/approve`, headers: auth })).json().error).toMatch(/done/);
  });

  it("offers promotion after the threshold of unedited approvals; an edit resets it", async () => {
    let last: { offerPromotion: boolean } = { offerPromotion: false };
    for (let i = 0; i < 3; i++) {
      last = (await app.inject({ method: "POST", url: `/actions/${pendingCard().id}/approve`, headers: auth })).json();
    }
    expect(last.offerPromotion).toBe(true);
    const edited = (
      await app.inject({ method: "POST", url: `/actions/${pendingCard().id}/edit`, headers: auth, payload: { args: { title: "Changed" } } })
    ).json();
    expect(edited.offerPromotion).toBe(false);
    expect(executed.at(-1)).toBe('schedule_meeting:{"title":"Changed"}');
  });

  it("records failures from the executor", async () => {
    const card = pendingCard({ fail: true });
    const res = (await app.inject({ method: "POST", url: `/actions/${card.id}/approve`, headers: auth })).json();
    expect(res.action).toMatchObject({ status: "failed", result: "tool exploded" });
  });

  it("rejects a card without running it", async () => {
    const card = pendingCard();
    expect((await app.inject({ method: "POST", url: `/actions/${card.id}/reject`, headers: auth })).json()).toEqual({ ok: true });
    expect(rt.store.getAction(card.id)?.status).toBe("rejected");
    expect(executed).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/actions/9999/reject", headers: auth })).json().error).toBe("not found");
  });

  it("promotes an action in projects.yaml and reloads it", async () => {
    await app.inject({ method: "POST", url: "/promote", headers: auth, payload: { projectId: "hawk", action: "schedule_meeting" } });
    expect(loadProjects().projects[0].autonomy.schedule_meeting).toBe("auto");
    expect(rt.projects()[0].autonomy.schedule_meeting).toBe("auto");
    expect((await app.inject({ method: "POST", url: "/promote", headers: auth, payload: { projectId: "nope", action: "x" } })).json().error).toBeTruthy();
  });

  it("persists the kill switch and writes the audit log", async () => {
    const r = (await app.inject({ method: "POST", url: "/killswitch", headers: auth, payload: { on: true } })).json();
    expect(r.killSwitch).toBe(true);
    expect(loadSettings().killSwitch).toBe(true);
    expect(rt.settings().killSwitch).toBe(true);
    const audit = (await app.inject({ url: "/audit", headers: auth })).json();
    expect(audit[0].kind).toBe("killswitch");
  });
});

describe("assigning an unknown sender from a card", () => {
  it("saves the domain to the chosen project and re-plans the email with its tools", async () => {
    const plans: string[] = [];
    rt.models = {
      call: async (_stage: string, req: { name: string; user: string }) => {
        if (req.name === "triage") return { data: { hasAction: true, intents: ["meeting"], confidence: 0.95 }, model: "fake", fellBack: false };
        plans.push(req.user);
        return { data: { rationale: "r", actions: [{ action: "schedule_meeting", summary: "Meet Dana", args: { title: "Meet" } }] }, model: "fake", fellBack: false };
      },
      callFallback: async () => {
        throw new Error("no");
      },
    } as never;
    const { processEmail } = await import("../../src/pipeline/index.js");
    const out = await processEmail(rt, email({ id: "u1", from: "Dana <dana@acme.io>", fromAddress: "dana@acme.io", subject: "hawk meeting" }));
    const card = out.actions[0];
    expect(card.summary).toMatch(/Which project is acme.io/);
    expect(card.args._assign).toMatchObject({ domain: "acme.io", scope: "domain", suggestions: ["hawk"] });

    const res = await app.inject({ method: "POST", url: `/actions/${card.id}/assign`, headers: auth, payload: { project: "hawk" } });
    const body = res.json();
    expect(body.projectId).toBe("hawk");
    expect(body.actions.map((a: { action: string; status: string }) => `${a.action}:${a.status}`)).toEqual(["schedule_meeting:pending"]);
    expect(plans).toHaveLength(1);
    expect(loadProjects().projects.find((p) => p.id === "hawk")!.match.domains).toEqual(["acme.io"]);
    expect(rt.store.getAction(card.id)!.status).toBe("rejected");

    expect((await app.inject({ method: "POST", url: `/actions/${body.actions[0].id}/assign`, headers: auth, payload: { project: "hawk" } })).json().error).toMatch(/no sender/);
    expect((await app.inject({ method: "POST", url: `/actions/99999/assign`, headers: auth, payload: { project: "hawk" } })).json().error).toBe("not found");
  });

  it("validates the request", async () => {
    rt.store.saveEmail(email({ id: "u2" }), null, {});
    const card = rt.store.addAction({
      emailId: "u2",
      projectId: null,
      action: "create_reminder",
      summary: "s",
      args: { _assign: { domain: "acme.io", sender: "d@acme.io", scope: "domain", suggestions: [], newName: "acme" } },
      decision: { kind: "suggest", risk: 1, reason: "r" },
    });
    expect((await app.inject({ method: "POST", url: `/actions/${card.id}/assign`, headers: auth, payload: {} })).json().error).toMatch(/required/);
    expect((await app.inject({ method: "POST", url: `/actions/${card.id}/assign`, headers: auth, payload: { project: "ghost" } })).json().error).toMatch(/Unknown project/);
  });
});

describe("suggestions from weekly discovery", () => {
  it("lists them, counts them in /status, and accepts or dismisses them", async () => {
    rt.store.set("suggestions", JSON.stringify([{ id: "new:fresh", kind: "new", text: "New project found: fresh.", evidence: [], project: { id: "fresh" } }]));
    const status = (await app.inject({ url: "/status", headers: { ...auth, "x-ibo-client": "menubar" } })).json();
    expect(status.suggestions).toBe(1);
    expect(rt.store.get("menubar:lastSeen")).not.toBeNull();
    expect((await app.inject({ url: "/suggestions", headers: auth })).json()).toHaveLength(1);
    const res = await app.inject({ method: "POST", url: `/suggestions/${encodeURIComponent("new:fresh")}`, headers: auth, payload: { accept: true } });
    expect(res.json()).toEqual({ ok: true });
    expect(rt.projects().map((p) => p.id)).toContain("fresh");
  });
});

describe("activity feed", () => {
  it("tells what happened in words, newest first, and leaves internal steps out", async () => {
    rt.store.saveEmail(email({ id: "a1" }), "hawk", {});
    rt.store.audit("filter", { from: "x@news.com", subject: "Weekly digest", hasAction: false, model: "ollama:qwen3:8b" }, { emailId: "a1" });
    rt.store.audit("plan", { project: "hawk" });
    const card = pendingCard();
    rt.store.audit("decision", { action: "schedule_meeting", kind: "suggest", reason: "Visible to others" }, { actionId: card.id });
    rt.store.audit("failed", { action: "x", error: "boom" });
    rt.store.audit("killswitch", { on: true });
    rt.store.audit("unknown_kind", {});
    const items = (await app.inject({ url: "/activity", headers: auth })).json();
    expect(items.map((i: { tone: string; title: string }) => `${i.tone}: ${i.title}`)).toEqual([
      "info: Paused: nothing runs, everything becomes a card",
      "error: Failed: x",
      "wait: Waiting for you: Meet Jack",
      "skip: Skipped: “Weekly digest”",
    ]);
    expect(items[3].detail).toMatch(/sorted on this Mac/);
    const status = (await app.inject({ url: "/status", headers: auth })).json();
    expect(status.agent).toBe("starting");
  });
});
