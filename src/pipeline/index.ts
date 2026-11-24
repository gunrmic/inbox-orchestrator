import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Project, RiskLevel, Settings } from "../config/schema.js";
import { paths } from "../config/paths.js";
import type { ModelRouter } from "../models/router.js";
import { decide, resolveAction } from "../policy/engine.js";
import type { Store } from "../store/db.js";
import type { ActionRecord, Email } from "../types.js";
import type { Executor } from "../executors/index.js";
import { routeEmail } from "./router.js";
import { suggestAssignment } from "./assign.js";
import { filterEmail, planEmail } from "./stages.js";

export interface PipelineDeps {
  store: Store;
  models: ModelRouter;
  executor: Executor;
  settings: () => Settings;
  projects: () => Project[];
  toolRisks: () => Record<string, RiskLevel>;
  log?: (msg: string) => void;
}

export interface PipelineOutcome {
  emailId: string;
  skipped?: "duplicate" | "no_action";
  projectId: string | null;
  actions: ActionRecord[];
}

function readSummary(project: Project): string {
  if (!project.summary) return "";
  const file = isAbsolute(project.summary) ? project.summary : join(paths.home, project.summary);
  return existsSync(file) ? readFileSync(file, "utf8").slice(0, 8000) : "";
}

/** Runs one email through filter, router, planner and policy, then executes what policy allows. */
export async function processEmail(deps: PipelineDeps, email: Email, opts: { force?: boolean } = {}): Promise<PipelineOutcome> {
  const { store, models, settings } = deps;
  const log = deps.log ?? (() => {});

  if (!opts.force && store.hasEmail(email.id)) return { emailId: email.id, skipped: "duplicate", projectId: null, actions: [] };

  const s = settings();
  const filter = await filterEmail(models, s, email);
  const route = routeEmail(email, deps.projects());
  store.saveEmail(email, route.project?.id ?? null, filter);
  store.audit("filter", { from: email.fromAddress, subject: email.subject, ...filter }, { emailId: email.id });

  if (!filter.hasAction) {
    log(`skip  ${email.subject} (no action, ${filter.model})`);
    return { emailId: email.id, skipped: "no_action", projectId: route.project?.id ?? null, actions: [] };
  }

  // Unknown sender: no planning against project tools. One reminder suggestion, and the card
  // asks which project this sender belongs to, with the likeliest answers first.
  if (!route.project) {
    const assign = suggestAssignment(email, deps.projects());
    store.set(`unmapped:${assign.domain}`, new Date().toISOString());
    const planned = {
      action: "create_reminder",
      summary: `Follow up: "${email.subject}" from ${email.from}. Which project is ${assign.scope === "domain" ? assign.domain : assign.sender}?`,
      args: { title: `Follow up: ${email.subject}` },
      assign,
    };
    const decision = decide({ planned, project: null, needsReactivation: false, email, settings: s, toolRisks: deps.toolRisks() });
    const { assign: info, ...rest } = planned;
    const record = store.addAction({ emailId: email.id, projectId: null, ...rest, args: { ...rest.args, _assign: info }, decision });
    return { emailId: email.id, projectId: null, actions: [record] };
  }

  const project = route.project;
  const { plan, model } = await planEmail(models, email, project, readSummary(project), filter);
  store.audit("plan", { project: project.id, model, ...plan }, { emailId: email.id });

  const records: ActionRecord[] = [];
  for (const planned of plan.actions) {
    const decision = decide({
      planned,
      project,
      needsReactivation: route.needsReactivation,
      email,
      settings: s,
      toolRisks: deps.toolRisks(),
    });
    const record = store.addAction({ emailId: email.id, projectId: project.id, ...planned, decision });
    store.audit("decision", { action: planned.action, ...decision }, { emailId: email.id, actionId: record.id });
    records.push(record);
    log(`${decision.kind.padEnd(7)} L${decision.risk} ${project.id}/${planned.action}: ${planned.summary}`);

    if (decision.kind === "execute") {
      await runAction(deps, record.id, email, project);
    }
  }
  return { emailId: email.id, projectId: project.id, actions: records.map((r) => store.getAction(r.id)!) };
}

/** Executes one stored action. Used both for automatic execution and after the user approves a card. */
export async function runAction(deps: PipelineDeps, actionId: number, email: Email | null, project: Project | null): Promise<void> {
  const { store } = deps;
  const record = store.getAction(actionId);
  if (!record) throw new Error(`No action ${actionId}`);
  const { step } = resolveAction(record.action, project, deps.toolRisks());
  if (!step) {
    store.updateAction(actionId, { status: "failed", result: "No executor for this action." });
    return;
  }
  store.updateAction(actionId, { status: "executing" });
  try {
    const result = await deps.executor.run({ record, step, project, email });
    store.updateAction(actionId, { status: "done", result });
    store.audit("executed", { action: record.action, result: result.slice(0, 2000) }, { actionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.updateAction(actionId, { status: "failed", result: message });
    store.audit("failed", { action: record.action, error: message }, { actionId });
  }
}
