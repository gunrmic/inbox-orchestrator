import { z } from "zod";
import type { Project, Settings } from "../config/schema.js";
import type { ModelRouter } from "../models/router.js";
import type { Email, FilterResult, Plan } from "../types.js";
import { BUILTIN_ACTIONS } from "../policy/engine.js";
import { emailAsData, FILTER_SCHEMA, FILTER_SYSTEM, planSchema, planSystem } from "./prompts.js";

const FilterOut = z.object({
  hasAction: z.boolean(),
  intents: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export async function filterEmail(models: ModelRouter, settings: Settings, email: Email): Promise<FilterResult> {
  const req = {
    system: FILTER_SYSTEM,
    user: emailAsData(email, 3000),
    name: "triage",
    description: "Triage result for one email.",
    schema: FILTER_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 300,
  };
  let res = await models.call("filter", req, FilterOut);
  const local = res.model.startsWith("ollama:");
  if (local && res.data.confidence < settings.models.minLocalConfidence) {
    res = await models.callFallback(req, FilterOut);
  }
  return { ...res.data, model: res.model };
}

/** Short descriptions shown to the planner for common generic action names. */
const ACTION_HINTS: Record<string, string> = {
  reproduce_bug: "Investigate and reproduce a reported bug without changing production. args.task describes it.",
  prepare_fix: "Prepare a fix on a branch, worktree or checkpoint. Never publishes. args.task describes the change.",
  create_task: "Create a task or ticket in the project's tracker. args.title, args.description.",
  schedule_meeting: "Create a calendar event with the sender. args.title, args.start (ISO), args.durationMinutes, args.attendees.",
  draft_reply: "Draft (not send) a reply to the email. args.body.",
  create_reminder: "Remind the user about this email. args.title, args.due (ISO, optional).",
};

export function availableActions(project: Project): { name: string; description: string }[] {
  const names = new Set([...Object.keys(project.playbook), ...Object.keys(BUILTIN_ACTIONS)]);
  return [...names].map((name) => {
    const step = project.playbook[name];
    const via = step?.kind === "mcp" ? ` (via ${step.server}/${step.tool})` : step?.kind === "claude-code" ? " (Claude Code in a git worktree)" : "";
    return { name, description: `${ACTION_HINTS[name] ?? "Project-specific action."}${via}` };
  });
}

const PlanOut = z.object({
  rationale: z.string(),
  actions: z
    .array(
      z.object({
        action: z.string(),
        summary: z.string(),
        args: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .max(5),
});

export async function planEmail(
  models: ModelRouter,
  email: Email,
  project: Project,
  summary: string,
  filter: FilterResult,
): Promise<{ plan: Plan; model: string }> {
  const actions = availableActions(project);
  const names = actions.map((a) => a.name);
  const res = await models.call(
    "plan",
    {
      system: planSystem(project.name ?? project.id, summary, actions),
      user: `Triage intents: ${filter.intents.join(", ") || "none"}\n\n${emailAsData(email)}`,
      name: "submit_plan",
      description: "Submit the plan of actions for this email.",
      schema: planSchema(names) as unknown as Record<string, unknown>,
      maxTokens: 2000,
    },
    PlanOut,
  );
  // Drop anything outside the allowed names even if the model ignored the enum.
  const plan: Plan = { rationale: res.data.rationale, actions: res.data.actions.filter((a) => names.includes(a.action)) };
  return { plan, model: res.model };
}
