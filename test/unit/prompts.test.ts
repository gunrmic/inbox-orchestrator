import { describe, expect, it } from "vitest";
import { emailAsData, FILTER_SYSTEM, planSchema, planSystem, UNTRUSTED_NOTE } from "../../src/pipeline/prompts.js";
import { email } from "../helpers.js";

describe("prompts", () => {
  it("wrap the email as labelled data with attachments", () => {
    const text = emailAsData(email({ attachments: [{ filename: "a.png", mimeType: "image/png", size: 1 }] }));
    expect(text.startsWith("<email>")).toBe(true);
    expect(text.endsWith("</email>")).toBe(true);
    expect(text).toContain("Attachments: a.png (image/png)");
  });

  it("truncate long bodies", () => {
    const text = emailAsData(email({ body: "x".repeat(10_000) }), 100);
    expect(text).toContain("[truncated]");
    expect(text.length).toBeLessThan(400);
  });

  it("include the untrusted-content rule in every system prompt", () => {
    expect(FILTER_SYSTEM).toContain(UNTRUSTED_NOTE);
    const sys = planSystem("Hawk", "Built on Base44", [{ name: "prepare_fix", description: "fix it" }]);
    expect(sys).toContain(UNTRUSTED_NOTE);
    expect(sys).toContain("- prepare_fix: fix it");
    expect(sys).toContain("Built on Base44");
    expect(planSystem("x", "", [])).toContain("(no summary yet)");
  });

  it("restrict plan actions to the allowed names", () => {
    const schema = planSchema(["a", "b"]);
    expect(schema.properties.actions.items.properties.action.enum).toEqual(["a", "b"]);
    expect(schema.properties.actions.maxItems).toBe(5);
  });
});
