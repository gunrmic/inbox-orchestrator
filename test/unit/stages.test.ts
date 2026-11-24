import { describe, expect, it } from "vitest";
import { ModelRouter } from "../../src/models/router.js";
import type { Provider, StructuredRequest } from "../../src/models/providers.js";
import { availableActions, filterEmail, planEmail } from "../../src/pipeline/stages.js";
import { email, project, settings } from "../helpers.js";

function providers(local: (r: StructuredRequest) => unknown, paid: (r: StructuredRequest) => unknown) {
  const calls = { local: 0, paid: 0 };
  const ollama: Provider = { id: "ollama", available: async () => true, structured: async (_m, r) => (calls.local++, local(r)) };
  const anthropic: Provider = { id: "anthropic", available: async () => true, structured: async (_m, r) => (calls.paid++, paid(r)) };
  return { calls, router: new ModelRouter({ settings: settings().models, allowLocalModels: true, providers: { ollama, anthropic } }) };
}

describe("filterEmail", () => {
  it("keeps a confident local answer", async () => {
    const { calls, router } = providers(() => ({ hasAction: true, intents: ["bug_report"], confidence: 0.9 }), () => ({}));
    const r = await filterEmail(router, settings(), email());
    expect(r).toMatchObject({ hasAction: true, intents: ["bug_report"] });
    expect(r.model).toMatch(/^ollama:/);
    expect(calls.paid).toBe(0);
  });

  it("re-asks the paid model when the local model is unsure", async () => {
    const { calls, router } = providers(
      () => ({ hasAction: true, intents: [], confidence: 0.3 }),
      () => ({ hasAction: false, intents: [], confidence: 0.95 }),
    );
    const r = await filterEmail(router, settings(), email());
    expect(r.hasAction).toBe(false);
    expect(r.model).toMatch(/^anthropic:/);
    expect(calls).toEqual({ local: 1, paid: 1 });
  });
});

describe("planning", () => {
  const p = project({
    id: "p",
    playbook: {
      prepare_fix: { kind: "claude-code", repo: "/r", baseBranch: "main" },
      create_task: { kind: "mcp", server: "jira", tool: "create_issue" },
      custom_thing: { kind: "reminder" },
    },
  });

  it("lists playbook actions plus built-ins, with how they run", () => {
    const list = availableActions(p);
    const byName = Object.fromEntries(list.map((a) => [a.name, a.description]));
    expect(Object.keys(byName).sort()).toEqual(["create_reminder", "create_task", "custom_thing", "prepare_fix"]);
    expect(byName.prepare_fix).toContain("Claude Code");
    expect(byName.create_task).toContain("jira/create_issue");
    expect(byName.custom_thing).toBe("Project-specific action.");
  });

  it("drops actions outside the allowed list even if the model ignores the enum", async () => {
    const { router } = providers(
      () => ({}),
      (r) => {
        expect(r.name).toBe("submit_plan");
        return {
          rationale: "r",
          actions: [
            { action: "prepare_fix", summary: "fix", args: { task: "t" } },
            { action: "deploy_prod", summary: "no", args: {} },
          ],
        };
      },
    );
    const { plan, model } = await planEmail(router, email(), p, "summary", { hasAction: true, intents: ["bug_report"], confidence: 1, model: "x" });
    expect(plan.actions.map((a) => a.action)).toEqual(["prepare_fix"]);
    expect(model).toMatch(/^anthropic:/);
  });
});
