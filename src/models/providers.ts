import Anthropic from "@anthropic-ai/sdk";
import type { ModelRef } from "../config/schema.js";

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

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  private client: Anthropic | null = null;

  constructor(private readonly apiKey: () => Promise<string | null>) {}

  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    const key = await this.apiKey();
    if (!key) throw new Error("No Anthropic API key. Run `ibo setup` or set ANTHROPIC_API_KEY.");
    this.client = new Anthropic({ apiKey: key });
    return this.client;
  }

  async available(): Promise<boolean> {
    return (await this.apiKey()) !== null;
  }

  async structured(model: string, req: StructuredRequest): Promise<unknown> {
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
