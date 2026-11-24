import type { z } from "zod";
import type { ModelRef, Settings, Stage } from "../config/schema.js";
import { describeModel, type Provider, type StructuredRequest } from "./providers.js";

export interface ModelCallResult<T> {
  data: T;
  model: string;
  fellBack: boolean;
  fallbackReason?: string;
}

export interface ModelRouterOptions {
  settings: Settings["models"];
  allowLocalModels: boolean;
  providers: Record<ModelRef["provider"], Provider>;
  onFallback?: (stage: Stage, from: string, to: string, reason: string) => void;
}

/**
 * Picks the model for each pipeline stage.
 * Order of decision: organization policy first, then the stage setting.
 * A local model that is blocked, missing, failing, or returns invalid output
 * falls back to the paid model. The reverse never happens automatically.
 */
export class ModelRouter {
  constructor(private readonly opts: ModelRouterOptions) {}

  primaryFor(stage: Stage): ModelRef {
    const ref = this.opts.settings[stage];
    if (ref.provider === "ollama" && !this.opts.allowLocalModels) return this.opts.settings.fallback;
    return ref;
  }

  async call<T>(stage: Stage, req: StructuredRequest, schema: z.ZodType<T>): Promise<ModelCallResult<T>> {
    const primary = this.primaryFor(stage);
    const configured = this.opts.settings[stage];
    const blockedByOrg = configured.provider === "ollama" && !this.opts.allowLocalModels;

    try {
      const data = await this.invoke(primary, req, schema);
      return {
        data,
        model: describeModel(primary),
        fellBack: blockedByOrg,
        fallbackReason: blockedByOrg ? "local models blocked by organization policy" : undefined,
      };
    } catch (err) {
      if (primary.provider !== "ollama") throw err;
      const fallback = this.opts.settings.fallback;
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.onFallback?.(stage, describeModel(primary), describeModel(fallback), reason);
      const data = await this.invoke(fallback, req, schema);
      return { data, model: describeModel(fallback), fellBack: true, fallbackReason: reason };
    }
  }

  /** Ask the fallback model directly, used when a local answer has low confidence. */
  async callFallback<T>(req: StructuredRequest, schema: z.ZodType<T>): Promise<ModelCallResult<T>> {
    const fallback = this.opts.settings.fallback;
    const data = await this.invoke(fallback, req, schema);
    return { data, model: describeModel(fallback), fellBack: true, fallbackReason: "low confidence" };
  }

  private async invoke<T>(ref: ModelRef, req: StructuredRequest, schema: z.ZodType<T>): Promise<T> {
    const provider = this.opts.providers[ref.provider];
    if (ref.provider === "ollama" && !(await provider.available())) {
      throw new Error("local model server is not running");
    }
    const raw = await provider.structured(ref.model, req);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error(`invalid output from ${describeModel(ref)}`);
    return parsed.data;
  }
}
