import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ModelRouter } from "../src/models/router.js";
import type { Provider } from "../src/models/providers.js";
import { settings } from "./helpers.js";

const Out = z.object({ ok: z.boolean() });
const req = { system: "s", user: "u", name: "n", description: "d", schema: {} };

function fake(id: string, impl: () => unknown, available = true): Provider & { calls: number } {
  const p = {
    id,
    calls: 0,
    available: async () => available,
    structured: async () => {
      p.calls += 1;
      return impl();
    },
  };
  return p;
}

describe("ModelRouter", () => {
  it("uses the local model when it works", async () => {
    const ollama = fake("ollama", () => ({ ok: true }));
    const anthropic = fake("anthropic", () => ({ ok: true }));
    const r = new ModelRouter({ settings: settings().models, allowLocalModels: true, providers: { ollama, anthropic } });
    const res = await r.call("filter", req, Out);
    expect(res.model.startsWith("ollama:")).toBe(true);
    expect(anthropic.calls).toBe(0);
  });

  it("falls back to the paid model when the local server is down", async () => {
    const ollama = fake("ollama", () => ({ ok: true }), false);
    const anthropic = fake("anthropic", () => ({ ok: true }));
    const onFallback = vi.fn();
    const r = new ModelRouter({ settings: settings().models, allowLocalModels: true, providers: { ollama, anthropic }, onFallback });
    const res = await r.call("filter", req, Out);
    expect(res.fellBack).toBe(true);
    expect(res.model.startsWith("anthropic:")).toBe(true);
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it("falls back when the local model returns invalid output", async () => {
    const ollama = fake("ollama", () => ({ nope: 1 }));
    const anthropic = fake("anthropic", () => ({ ok: true }));
    const r = new ModelRouter({ settings: settings().models, allowLocalModels: true, providers: { ollama, anthropic } });
    expect((await r.call("filter", req, Out)).fellBack).toBe(true);
  });

  it("skips local models entirely when the organization blocks them", async () => {
    const ollama = fake("ollama", () => ({ ok: true }));
    const anthropic = fake("anthropic", () => ({ ok: true }));
    const r = new ModelRouter({ settings: settings().models, allowLocalModels: false, providers: { ollama, anthropic } });
    const res = await r.call("filter", req, Out);
    expect(ollama.calls).toBe(0);
    expect(res.model.startsWith("anthropic:")).toBe(true);
  });

  it("never falls back from paid to local", async () => {
    const ollama = fake("ollama", () => ({ ok: true }));
    const anthropic = fake("anthropic", () => {
      throw new Error("boom");
    });
    const r = new ModelRouter({ settings: settings().models, allowLocalModels: true, providers: { ollama, anthropic } });
    await expect(r.call("plan", req, Out)).rejects.toThrow("boom");
    expect(ollama.calls).toBe(0);
  });
});
