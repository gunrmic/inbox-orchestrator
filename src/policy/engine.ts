import type { PlaybookStep, Project, RiskLevel, Settings } from "../config/schema.js";
import type { Decision, Email, PlannedAction } from "../types.js";
import { effectiveRisk } from "./risk.js";

/** Actions every project gets without a playbook entry. */
export const BUILTIN_ACTIONS: Record<string, { step: PlaybookStep; risk: RiskLevel }> = {
  create_reminder: { step: { kind: "reminder" }, risk: 1 },
};

/** Risk of the built-in Claude Code executor: it works in a fresh worktree and never pushes. */
export const CLAUDE_CODE_RISK: RiskLevel = 1;

export interface PolicyInput {
  planned: PlannedAction;
  project: Project | null;
  needsReactivation: boolean;
  email: Email;
  settings: Settings;
  toolRisks: Record<string, RiskLevel>;
}

export interface ResolvedAction {
  step: PlaybookStep | null;
  risk: RiskLevel;
}

export function resolveAction(
  action: string,
  project: Project | null,
  toolRisks: Record<string, RiskLevel>,
): ResolvedAction {
  const step = project?.playbook[action] ?? BUILTIN_ACTIONS[action]?.step ?? null;
  if (!step) return { step: null, risk: 3 };
  switch (step.kind) {
    case "reminder":
      return { step, risk: 1 };
    case "claude-code":
      return { step, risk: CLAUDE_CODE_RISK };
    case "mcp":
      return { step, risk: effectiveRisk(`${step.server}/${step.tool}`, toolRisks) };
  }
}

const senderVerified = (email: Email) => email.auth.spf === "pass" || email.auth.dkim === "pass";

/**
 * Deterministic policy. The model proposes actions; this function alone decides
 * whether each one runs now, waits for approval, or is refused. Nothing in an
 * email can change its outcome except the sender's identity.
 */
export function decide(input: PolicyInput): Decision {
  const { planned, project, settings, toolRisks, email } = input;
  const { step, risk } = resolveAction(planned.action, project, toolRisks);

  if (!step) {
    return { kind: "deny", risk: 3, reason: `No executor for "${planned.action}" in this project.` };
  }

  // Unknown sender: never run code or touch project tools. Only a reminder suggestion.
  if (!project) {
    if (step.kind === "reminder") {
      return { kind: "suggest", risk, reason: "Sender is not mapped to a project." };
    }
    return { kind: "deny", risk, reason: "Sender is not mapped to a project; only reminders are allowed." };
  }

  // A mapped sender whose mail fails both SPF and DKIM may be spoofed.
  if (!senderVerified(email)) {
    if (step.kind === "claude-code") {
      return { kind: "deny", risk, reason: "Sender failed SPF and DKIM; code execution is blocked." };
    }
    return { kind: "suggest", risk, reason: "Sender failed SPF and DKIM; waiting for approval." };
  }

  if (settings.killSwitch) {
    return { kind: "suggest", risk, reason: "Kill switch is on: everything waits for approval." };
  }

  if (input.needsReactivation) {
    return { kind: "suggest", risk, reason: `Project is ${project.status}; confirm it is active again.` };
  }

  const override = project.autonomy[planned.action];

  switch (risk) {
    case 0:
      return { kind: "execute", risk, reason: "Read-only." };
    case 1:
      if (override === "suggest" || override === "approve") {
        return { kind: "suggest", risk, reason: `Project setting for ${planned.action} is "${override}".` };
      }
      return { kind: "execute", risk, reason: "Local and reversible." };
    case 2:
      if (override === "auto" || (settings.mode === "auto" && override !== "suggest" && override !== "approve")) {
        return { kind: "execute", risk, reason: "Visible to others; automatic by setting." };
      }
      return { kind: "suggest", risk, reason: "Visible to others; waiting for approval." };
    case 3:
      return { kind: "suggest", risk, reason: "Dangerous action; always requires approval." };
  }
}

/**
 * After `threshold` consecutive approvals without edits of the same level-2 action
 * in the same project, offer to make it automatic. Level 3 is never offered.
 */
export function shouldOfferPromotion(
  consecutiveUneditedApprovals: number,
  risk: RiskLevel,
  current: string | undefined,
  threshold: number,
): boolean {
  return risk === 2 && current !== "auto" && consecutiveUneditedApprovals >= threshold;
}
