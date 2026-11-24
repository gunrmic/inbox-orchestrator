import type { RiskLevel } from "../config/schema.js";

/** MCP tool annotations as defined by the MCP spec. All optional hints. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Names that are dangerous no matter what config says. A tool whose name matches
 * one of these can never be classified below level 3, even by the user.
 */
const DANGEROUS = [
  /publish/i,
  /deploy/i,
  /\bmerge/i,
  /merge_/i,
  /delete|remove|destroy|drop|purge|trash/i,
  /force/i,
  /transfer|payment|charge|refund|buy|purchase/i,
  /rollback|promote|restore/i,
  /send_?email|send_?message|forward|reply/i,
  /pause_project|unpause|update_environment|secret|api_?key/i,
];

const READ_PREFIX = /^(get|list|search|query|read|describe|fetch|find|count|aggregate|show|inspect|view)[_-]?/i;
const WRITE_LOCAL = /^(create_checkpoint|create_branch|create_draft|draft)/i;
const VISIBLE = /^(create|update|add|edit|write|insert|upsert|set|label|assign|comment|invite|respond|share|post)/i;

/** The floor no configuration can go below. */
export function riskFloor(toolName: string): RiskLevel {
  return DANGEROUS.some((r) => r.test(toolName)) ? 3 : 0;
}

/**
 * Suggest a risk level for an MCP tool from its name and annotations.
 * This is only a suggestion shown during onboarding; the confirmed value lives in tools.yaml.
 */
export function suggestRisk(toolName: string, annotations: ToolAnnotations = {}): RiskLevel {
  if (riskFloor(toolName) === 3) return 3;
  if (annotations.destructiveHint === true) return 3;
  if (annotations.readOnlyHint === true || READ_PREFIX.test(toolName)) return 0;
  if (WRITE_LOCAL.test(toolName)) return 1;
  if (VISIBLE.test(toolName)) return annotations.openWorldHint === false ? 1 : 2;
  // Unknown verbs: be conservative.
  return 3;
}

/** True when a tool is safe to call during discovery (read-only). */
export function isDiscoverySafe(toolName: string, annotations: ToolAnnotations = {}): boolean {
  if (riskFloor(toolName) === 3) return false;
  if (annotations.destructiveHint === true) return false;
  return annotations.readOnlyHint === true || READ_PREFIX.test(toolName);
}

/** Effective risk: the confirmed level, never below the hard floor, unknown tools at 3. */
export function effectiveRisk(toolKey: string, confirmed: Record<string, RiskLevel>): RiskLevel {
  const toolName = toolKey.split("/").pop() ?? toolKey;
  const floor = riskFloor(toolName);
  const level = confirmed[toolKey];
  if (level === undefined) return 3;
  return (Math.max(level, floor) as RiskLevel);
}
