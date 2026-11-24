import Anthropic from "@anthropic-ai/sdk";
import type { ModelRef } from "../config/schema.js";
import { extractJson, hasClaude, resultText, runClaude } from "../util/claude-cli.js";

export interface StructuredRequest {
  system: string;
  user: string;
  /** Name of the structured result, used as the forced tool name for Anthropic. */
  name: string;
  description: string;
  /** JSON Schema of the expected object. */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface Provider {
  readonly id: string;
  structured(model: string, req: StructuredRequest): Promise<unknown>;
  available(): Promise<boolean>;
}

/**
 * Claude through the user's own Claude Code login (Pro/Max subscription), so no API key is
 * needed. Runs `claude -p` with every tool disabled and a single turn: the email is data only.
 */
export class ClaudeCliProvider implements Provider {
  readonly id = "claude-cli";

  async available(): Promise<boolean> {
    return hasClaude();
  }

  async structured(model: string, req: StructuredRequest): Promise<unknown> {
    const prompt = [
      req.user,
      "",
      `Answer with one JSON object for "${req.name}" (${req.description}) and nothing else.`,
      "It must match this JSON Schema:",
      JSON.stringify(req.schema),
    ].join("\n");
    const out = await runClaude(
      [
        "-p",
        "--output-format",
        "json",
        "--model",
        model,
        "--max-turns",
        "1",
        "--system-prompt",
        req.system,
        "--disallowedTools",
        "Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite",
        "--strict-mcp-config",
      ],
      { input: prompt, timeoutMs: 5 * 60_000 },
    );
    return extractJson(resultText(out));
  }
}

/**
 * Claude via the API key when there is one, otherwise via the Claude Code login.
 * Most users of this tool already have Claude Code, so setup needs no key at all.
 */
export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  private client: Anthropic | null = null;

  constructor(
    private readonly apiKey: () => Promise<string | null>,
    private readonly cli: Provider = new ClaudeCliProvider(),
  ) {}

  /** "api" with a key, "claude-code" with only Claude Code, null with neither. */
  async route(): Promise<"api" | "claude-code" | null> {
    if (await this.apiKey()) return "api";
    if (await this.cli.available()) return "claude-code";
    return null;
  }

  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    const key = await this.apiKey();
    if (!key) throw new Error("No Anthropic API key and no Claude Code login. Install Claude Code or run `ibo setup anthropic`.");
    this.client = new Anthropic({ apiKey: key });
    return this.client;
  }

  async available(): Promise<boolean> {
    return (await this.route()) !== null;
  }

  async structured(model: string, req: StructuredRequest): Promise<unknown> {
    if ((await this.route()) === "claude-code") return this.cli.structured(model, req);
    const client = await this.getClient();
    const res = await client.messages.create({
      model,
      max_tokens: req.maxTokens ?? 2048,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      tools: [
        {
          name: req.name,
          description: req.description,
          input_schema: req.schema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: req.name },
    });
    const block = res.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") throw new Error("Model returned no structured result.");
    return block.input;
  }
}

export class OllamaProvider implements Provider {
  readonly id = "ollama";

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async available(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Installed model names, e.g. "qwen3:8b". */
  async models(): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  }

  async hasModel(name: string): Promise<boolean> {
    const names = await this.models();
    return names.includes(name) || names.includes(`${name}:latest`);
  }

  /** Downloads a model. Can take minutes; Ollama answers when it is done. */
  async pull(name: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name, stream: false }),
      signal: AbortSignal.timeout(60 * 60_000),
    });
    if (!res.ok) throw new Error(`Ollama could not pull ${name}: ${res.status}`);
  }

  async structured(model: string, req: StructuredRequest): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model,
        stream: false,
        format: req.schema,
        options: { temperature: 0 },
        messages: [
          { role: "system", content: `${req.system}\n\nAnswer only with JSON matching the schema for "${req.name}".` },
          { role: "user", content: req.user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    const text = data.message?.content ?? "";
    return JSON.parse(text);
  }
}

export const describeModel = (ref: ModelRef) => `${ref.provider}:${ref.model}`;
