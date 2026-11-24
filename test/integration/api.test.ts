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
