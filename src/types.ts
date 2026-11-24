import type { RiskLevel } from "./config/schema.js";

export interface Email {
  id: string;
  threadId: string;
  from: string;
  fromAddress: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  snippet: string;
  body: string;
  attachments: { filename: string; mimeType: string; size: number }[];
  /** Results of SPF / DKIM checks from the Authentication-Results header. */
  auth: { spf: "pass" | "fail" | "unknown"; dkim: "pass" | "fail" | "unknown" };
}

export interface FilterResult {
  hasAction: boolean;
  intents: string[];
  confidence: number;
  model: string;
}

/** One step the planner wants to take. `action` is a generic name resolved through the project playbook. */
export interface PlannedAction {
  action: string;
  summary: string;
  args: Record<string, unknown>;
}

export interface Plan {
  rationale: string;
  actions: PlannedAction[];
}

/** What the policy engine decided for one planned action. */
export type Decision =
  | { kind: "execute"; risk: RiskLevel; reason: string }
  | { kind: "suggest"; risk: RiskLevel; reason: string }
  | { kind: "deny"; risk: RiskLevel; reason: string };

export type ActionStatus =
  | "pending"
  | "executing"
  | "done"
  | "failed"
  | "rejected"
  | "denied";

export interface ActionRecord {
  id: number;
  emailId: string;
  projectId: string | null;
  action: string;
  summary: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  decision: Decision["kind"];
  reason: string;
  status: ActionStatus;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}
