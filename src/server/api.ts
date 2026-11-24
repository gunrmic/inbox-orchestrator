import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { loadProjects, loadSettings, saveProjects, saveSettings } from "../config/load.js";
import { paths } from "../config/paths.js";
import { shouldOfferPromotion } from "../policy/engine.js";
import { processEmail, runAction } from "../pipeline/index.js";
import { applyAssignment, type AssignInfo } from "../pipeline/assign.js";
import { listSuggestions, resolveSuggestion } from "../discovery/rediscover.js";
import { registerSetupApi } from "./setup-api.js";
import type { Runtime } from "../runtime.js";

/** Token the menu bar app uses. Created once, readable only by the user. */
export function apiToken(): string {
  if (existsSync(paths.token)) return readFileSync(paths.token, "utf8").trim();
  const token = randomBytes(24).toString("hex");
  writeFileSync(paths.token, token, { mode: 0o600 });
  return token;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Local API for the menu bar app. Binds to 127.0.0.1 only and requires the token. */
export function buildApi(rt: Runtime): FastifyInstance {
  const app = Fastify({ logger: false });
  const token = apiToken();

  app.addHook("onRequest", async (req, reply) => {
    const auth = req.headers.authorization ?? "";
    if (!same(auth, `Bearer ${token}`)) return reply.code(401).send({ error: "unauthorized" });
  });

  app.get("/status", async (req) => {
    if (req.headers["x-ibo-client"] === "menubar") rt.store.set("menubar:lastSeen", new Date().toISOString());
    const s = rt.settings();
    return {
      mode: s.mode,
      killSwitch: s.killSwitch,
      pending: rt.store.listActions("pending").length,
      projects: rt.projects().map((p) => ({ id: p.id, name: p.name ?? p.id, status: p.status })),
      lastPoll: rt.store.get("gmail:lastPoll"),
      suggestions: listSuggestions(rt.store).length,
    };
  });

  app.get("/suggestions", async () => listSuggestions(rt.store));

  app.post<{ Params: { id: string }; Body: { accept: boolean } }>("/suggestions/:id", async (req) => {
    const res = resolveSuggestion(rt.store, decodeURIComponent(req.params.id), !!req.body?.accept);
    rt.reload();
    return res;
  });

  app.get<{ Querystring: { status?: string } }>("/actions", async (req) => {
    const status = req.query.status as Parameters<typeof rt.store.listActions>[0];
    return rt.store.listActions(status, 100).map((a) => {
      const email = rt.store.getEmail(a.emailId);
      return { ...a, email: email ? { from: email.from, subject: email.subject, date: email.date, threadId: email.threadId } : null };
    });
  });

  async function approve(id: number, args?: Record<string, unknown>) {
    const record = rt.store.getAction(id);
    if (!record) return { error: "not found" };
    if (record.status !== "pending") return { error: `action is ${record.status}` };
    if (args) rt.store.updateAction(id, { args });
    const project = rt.projects().find((p) => p.id === record.projectId) ?? null;
    rt.store.audit("approved", { action: record.action, edited: !!args }, { actionId: id });
    await runAction(rt, id, rt.store.getEmail(record.emailId), project);

    let offerPromotion = false;
    if (project) {
      const streak = rt.store.recordApproval(project.id, record.action, !!args);
      offerPromotion = shouldOfferPromotion(streak, record.risk, project.autonomy[record.action], rt.settings().promotion.threshold);
    }
    return { action: rt.store.getAction(id), offerPromotion };
  }

  app.post<{ Params: { id: string } }>("/actions/:id/approve", async (req) => approve(Number(req.params.id)));

  app.post<{ Params: { id: string }; Body: { args: Record<string, unknown> } }>("/actions/:id/edit", async (req) =>
    approve(Number(req.params.id), req.body?.args ?? {}),
  );

  app.post<{ Params: { id: string } }>("/actions/:id/reject", async (req) => {
    const id = Number(req.params.id);
    const record = rt.store.getAction(id);
    if (!record) return { error: "not found" };
    rt.store.updateAction(id, { status: "rejected" });
    if (record.projectId) rt.store.resetStreak(record.projectId, record.action);
    rt.store.audit("rejected", { action: record.action }, { actionId: id });
    return { ok: true };
  });

  /**
   * Answer "which project is this sender?" on a card. Saves the sender or domain to the
   * project (or a new one), then runs the email again so it is planned with that project's tools.
   */
  app.post<{ Params: { id: string }; Body: { project: string; name?: string; scope?: "domain" | "sender" } }>("/actions/:id/assign", async (req) => {
    const id = Number(req.params.id);
    const record = rt.store.getAction(id);
    if (!record) return { error: "not found" };
    const info = record.args._assign as AssignInfo | undefined;
    if (!info) return { error: "this card has no sender to assign" };
    if (!req.body?.project) return { error: "project is required" };
    let projectId: string;
    try {
      projectId = applyAssignment({ project: req.body.project, name: req.body.name ?? info.newName, scope: req.body.scope ?? info.scope, domain: info.domain, sender: info.sender });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    rt.reload();
    rt.store.updateAction(id, { status: "rejected", result: `Assigned to ${projectId}` });
    rt.store.audit("assigned", { projectId, scope: req.body.scope ?? info.scope, domain: info.domain, sender: info.sender }, { actionId: id });
    const email = rt.store.getEmail(record.emailId);
    const outcome = email ? await processEmail(rt, email, { force: true }) : null;
    return { projectId, actions: outcome?.actions ?? [] };
  });

  /** Make an action automatic for a project. Only level-2 actions can be promoted. */
  app.post<{ Body: { projectId: string; action: string } }>("/promote", async (req) => {
    const { projectId, action } = req.body;
    const file = loadProjects();
    const p = file.projects.find((x) => x.id === projectId);
    if (!p) return { error: "unknown project" };
    p.autonomy[action] = "auto";
    saveProjects(file);
    rt.reload();
    rt.store.audit("promoted", { projectId, action });
    return { ok: true };
  });

  app.post<{ Body: { on: boolean } }>("/killswitch", async (req) => {
    const s = loadSettings();
    s.killSwitch = !!req.body?.on;
    saveSettings(s);
    rt.reload();
    rt.store.audit("killswitch", { on: s.killSwitch });
    return { killSwitch: s.killSwitch };
  });

  app.get("/audit", async () => rt.store.recentAudit(100));

  registerSetupApi(app, rt);

  return app;
}
