import { z } from "zod";

/** Risk levels. Fixed in code and config, never decided by a model at run time. */
export const RiskLevel = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const RISK_LABELS: Record<RiskLevel, string> = {
  0: "read",
  1: "local and reversible",
  2: "visible to others",
  3: "dangerous",
};

export const AutonomySetting = z.enum(["auto", "suggest", "approve"]);
export type AutonomySetting = z.infer<typeof AutonomySetting>;

export const ProjectStatus = z.enum(["live", "dormant", "dead"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/**
 * How one generic action (prepare_fix, create_task, ...) is carried out in a project.
 * Either a tool on one of the user's MCP servers, or a built-in executor.
 */
export const PlaybookStep = z.union([
  z.object({
    kind: z.literal("mcp"),
    server: z.string(),
    tool: z.string(),
    /** Optional fixed arguments merged under the planner's arguments. */
    defaults: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("claude-code"),
    repo: z.string(),
    baseBranch: z.string().default("main"),
  }),
  z.object({
    kind: z.literal("reminder"),
  }),
]);
export type PlaybookStep = z.infer<typeof PlaybookStep>;

export const Project = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i, "project id must be a slug"),
  name: z.string().optional(),
  status: ProjectStatus.default("live"),
  lastActivity: z.string().optional(),
  match: z
    .object({
      senders: z.array(z.string()).default([]),
      domains: z.array(z.string()).default([]),
      keywords: z.array(z.string()).default([]),
    })
    .default({ senders: [], domains: [], keywords: [] }),
  /** Path to a short markdown summary of the project's architecture, written during discovery. */
  summary: z.string().optional(),
  /** Generic action name -> how it is performed in this project. */
  playbook: z.record(z.string(), PlaybookStep).default({}),
  /** Generic action name -> autonomy override. Can only lower friction within the risk ceiling. */
  autonomy: z.record(z.string(), AutonomySetting).default({}),
});
export type Project = z.infer<typeof Project>;

export const ProjectsFile = z.object({
  projects: z.array(Project).default([]),
});
export type ProjectsFile = z.infer<typeof ProjectsFile>;

/** "server/tool" -> risk level. Confirmed by the user during onboarding. */
export const ToolsFile = z.object({
  tools: z.record(z.string(), RiskLevel).default({}),
});
export type ToolsFile = z.infer<typeof ToolsFile>;

export const ModelRef = z.object({
  provider: z.enum(["ollama", "anthropic"]),
  model: z.string(),
});
export type ModelRef = z.infer<typeof ModelRef>;

export const Stage = z.enum(["filter", "route", "plan", "discovery"]);
export type Stage = z.infer<typeof Stage>;

export const Settings = z.object({
  /** "suggest": level 2 waits for approval. "auto": level 2 runs, level 3 still waits. */
  mode: z.enum(["suggest", "auto"]).default("suggest"),
  /** When true everything becomes a suggestion, nothing executes. */
  killSwitch: z.boolean().default(false),
  gmail: z
    .object({
      pollSeconds: z.number().int().min(15).default(60),
      query: z.string().default("in:inbox -category:promotions -category:social"),
    })
    .default({ pollSeconds: 60, query: "in:inbox -category:promotions -category:social" }),
  models: z
    .object({
      /** Primary model per stage. A local model here falls back to `fallback` on failure. */
      filter: ModelRef.default({ provider: "ollama", model: "qwen3:8b" }),
      route: ModelRef.default({ provider: "ollama", model: "qwen3:8b" }),
      plan: ModelRef.default({ provider: "anthropic", model: "claude-sonnet-5-5" }),
      discovery: ModelRef.default({ provider: "anthropic", model: "claude-sonnet-5-5" }),
      fallback: ModelRef.default({ provider: "anthropic", model: "claude-haiku-5-5" }),
      ollamaUrl: z.string().default("http://127.0.0.1:11434"),
      /** Below this confidence a local filter answer is re-asked to the fallback model. */
      minLocalConfidence: z.number().min(0).max(1).default(0.7),
    })
    .default({
      filter: { provider: "ollama", model: "qwen3:8b" },
      route: { provider: "ollama", model: "qwen3:8b" },
      plan: { provider: "anthropic", model: "claude-sonnet-5-5" },
      discovery: { provider: "anthropic", model: "claude-sonnet-5-5" },
      fallback: { provider: "anthropic", model: "claude-haiku-5-5" },
      ollamaUrl: "http://127.0.0.1:11434",
      minLocalConfidence: 0.7,
    }),
  org: z
    .object({
      /** Set to false (or enforce via managed config) when the organization blocks local models. */
      allowLocalModels: z.boolean().default(true),
    })
    .default({ allowLocalModels: true }),
  promotion: z
    .object({
      /** Consecutive unedited approvals before the agent offers to make an action automatic. */
      threshold: z.number().int().min(3).default(10),
    })
    .default({ threshold: 10 }),
  server: z
    .object({
      port: z.number().int().default(47811),
    })
    .default({ port: 47811 }),
});
export type Settings = z.infer<typeof Settings>;
