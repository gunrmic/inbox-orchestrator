import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRouter } from "../src/models/router.js";
import type { Provider, StructuredRequest } from "../src/models/providers.js";
import { processEmail, type PipelineDeps } from "../src/pipeline/index.js";
import { Store } from "../src/store/db.js";
import { email, project, settings } from "./helpers.js";

/** Fake provider: triage says "action", planner returns a fixed plan. */
function fakeModels(plan: unknown, triage = { hasAction: true, intents: ["bug_report"], confidence: 0.95 }): ModelRouter {
  const provider: Provider = {
    id: "anthropic",
    available: async () => true,
    structured: async (_m: string, req: StructuredRequest) => (req.name === "triage" ? triage : plan),
  };
  return new ModelRouter({ settings: settings().models, allowLocalModels: false, providers: { anthropic: provider, ollama: provider } });
}

function deps(plan: unknown, executed: string[], triage?: Parameters<typeof fakeModels>[1]): PipelineDeps {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "ibo-db-")), "state.db"));
  const proj = project({
    id: "coleven",
    match: { senders: ["jack@coleven.com"], domains: [], keywords: [] },
    playbook: {
      reproduce_bug: { kind: "mcp", server: "base44", tool: "query_entities" },
      prepare_fix: { kind: "mcp", server: "base44", tool: "create_checkpoint" },
      schedule_meeting: { kind: "mcp", server: "gcal", tool: "create_event" },
    },
  });
  return {
    store,
    models: fakeModels(plan, triage),
    executor: {
      run: async ({ record }) => {
        executed.push(record.action);
        return `ran ${record.action}`;
      },
    },
    settings: () => settings(),
    projects: () => [proj],
    toolRisks: () => ({ "base44/query_entities": 0, "base44/create_checkpoint": 1, "gcal/create_event": 2 }),
  };
}

const PLAN = {
  rationale: "Bug report plus a meeting request.",
  actions: [
    { action: "reproduce_bug", summary: "Query entities for the date range", args: {} },
    { action: "prepare_fix", summary: "Checkpoint with a fix", args: { task: "fix date filter" } },
    { action: "schedule_meeting", summary: "Meet Jack tomorrow 10:00", args: { title: "Graph bug" } },
    { action: "deploy_everything", summary: "should be dropped", args: {} },
  ],
};

describe("processEmail", () => {
  it("executes level 0-1, suggests level 2, drops unknown actions", async () => {
    const executed: string[] = [];
    const d = deps(PLAN, executed);
    const out = await processEmail(d, email());
    expect(executed).toEqual(["reproduce_bug", "prepare_fix"]);
    expect(out.actions.map((a) => [a.action, a.decision, a.status])).toEqual([
      ["reproduce_bug", "execute", "done"],
      ["prepare_fix", "execute", "done"],
      ["schedule_meeting", "suggest", "pending"],
    ]);
  });

  it("is idempotent per email id", async () => {
    const executed: string[] = [];
    const d = deps(PLAN, executed);
    await processEmail(d, email());
    const again = await processEmail(d, email());
    expect(again.skipped).toBe("duplicate");
    expect(executed).toHaveLength(2);
  });

  it("stops when triage finds no action", async () => {
    const executed: string[] = [];
    const out = await processEmail(deps(PLAN, executed, { hasAction: false, intents: [], confidence: 0.99 }), email());
    expect(out.skipped).toBe("no_action");
    expect(executed).toHaveLength(0);
  });

  it("only suggests a reminder for an unknown sender and never plans", async () => {
    const executed: string[] = [];
    const out = await processEmail(deps(PLAN, executed), email({ id: "m2", fromAddress: "x@stranger.org", from: "x@stranger.org" }));
    expect(executed).toHaveLength(0);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]).toMatchObject({ action: "create_reminder", decision: "suggest", status: "pending" });
  });
});
