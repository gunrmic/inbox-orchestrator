import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
    constructor(public opts: unknown) {}
  },
}));

const { AnthropicProvider, OllamaProvider, describeModel } = await import("../../src/models/providers.js");

const req = { system: "sys", user: "usr", name: "triage", description: "d", schema: { type: "object" } };

describe("AnthropicProvider", () => {
  beforeEach(() => create.mockReset());

  it("forces the structured tool and returns its input", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "triage", input: { ok: 1 } }] });
    const p = new AnthropicProvider(async () => "key");
    expect(await p.structured("claude-x", req)).toEqual({ ok: 1 });
    const args = create.mock.calls[0][0];
    expect(args).toMatchObject({ model: "claude-x", system: "sys", tool_choice: { type: "tool", name: "triage" } });
    expect(args.tools[0]).toMatchObject({ name: "triage", input_schema: { type: "object" } });
    expect(args.messages).toEqual([{ role: "user", content: "usr" }]);
  });

  it("fails without a structured result", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: "no" }] });
    await expect(new AnthropicProvider(async () => "key").structured("m", req)).rejects.toThrow(/no structured result/);
  });

  it("fails clearly without an API key", async () => {
    const p = new AnthropicProvider(async () => null);
    expect(await p.available()).toBe(false);
    await expect(p.structured("m", req)).rejects.toThrow(/No Anthropic API key/);
  });
});

describe("OllamaProvider", () => {
  it("reports availability from /api/tags", async () => {
    const ok = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await new OllamaProvider("http://h", ok as unknown as typeof fetch).available()).toBe(true);
    expect(ok.mock.calls[0][0]).toBe("http://h/api/tags");
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await new OllamaProvider("http://h", down as unknown as typeof fetch).available()).toBe(false);
  });

  it("sends the schema as format with temperature 0 and parses the JSON answer", async () => {
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ model: "qwen", stream: false, format: { type: "object" }, options: { temperature: 0 } });
      expect(body.messages[0].role).toBe("system");
      return new Response(JSON.stringify({ message: { content: '{"hasAction":true}' } }), { status: 200 });
    });
    const p = new OllamaProvider("http://h", f as unknown as typeof fetch);
    expect(await p.structured("qwen", req)).toEqual({ hasAction: true });
  });

  it("throws on HTTP errors and invalid JSON", async () => {
    const bad = vi.fn(async () => new Response("x", { status: 500 }));
    await expect(new OllamaProvider("http://h", bad as unknown as typeof fetch).structured("m", req)).rejects.toThrow(/500/);
    const junk = vi.fn(async () => new Response(JSON.stringify({ message: { content: "not json" } }), { status: 200 }));
    await expect(new OllamaProvider("http://h", junk as unknown as typeof fetch).structured("m", req)).rejects.toThrow();
  });

  it("describes models as provider:model", () => {
    expect(describeModel({ provider: "ollama", model: "qwen3:8b" })).toBe("ollama:qwen3:8b");
  });
});
