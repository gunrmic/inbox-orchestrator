import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProjects, saveSettings, saveTools } from "../../src/config/load.js";
import { Settings } from "../../src/config/schema.js";
import { emailSource, pollOnce } from "../../src/daemon.js";
import { FixtureSource } from "../../src/gmail/source.js";
import { ModelRouter } from "../../src/models/router.js";
import type { Provider, StructuredRequest } from "../../src/models/providers.js";
import { buildRuntime, type Runtime } from "../../src/runtime.js";
import { email, project } from "../helpers.js";

let rt: Runtime | null = null;
afterEach(async () => {
  await rt?.close();
  rt = null;
  delete process.env.IBO_TEST_INBOX;
});

function fakeModels(): ModelRouter {
  const provider: Provider = {
    id: "anthropic",
    available: async () => true,
    structured: async (_m: string, req: StructuredRequest) => {
      if (req.name === "triage") {
        const isNewsletter = req.user.includes("newsletter");
        return { hasAction: !isNewsletter, intents: isNewsletter ? [] : ["bug_report"], confidence: 0.95 };
      }
      if (req.user.includes("explode")) throw new Error("model down");
      return { rationale: "r", actions: [{ action: "prepare_fix", summary: "Checkpoint the fix", args: { note: "date filter" } }] };
    },
  };
  return new ModelRouter({ settings: Settings.parse({}).models, allowLocalModels: false, providers: { anthropic: provider, ollama: provider } });
}

describe("daemon poll cycle", () => {
  it("processes new mail from the source, skips newsletters, and survives a failing email", async () => {
    saveSettings(Settings.parse({}));
    saveProjects({
      projects: [project({ id: "hawk", match: { senders: ["jack@coleven.com"], domains: [], keywords: [] }, playbook: { prepare_fix: { kind: "mcp", server: "apps", tool: "create_checkpoint" } } })],
    });
    saveTools({ tools: { "apps/create_checkpoint": 1 } });

    const inbox = join(mkdtempSync(join(tmpdir(), "ibo-inbox-")), "inbox.json");
    writeFileSync(
      inbox,
      JSON.stringify([
        email({ id: "bug", subject: "Graph broken" }),
        email({ id: "news", subject: "Weekly newsletter", body: "newsletter" }),
        email({ id: "boom", subject: "explode", body: "explode" }),
      ]),
    );

    const executed: string[] = [];
    rt = buildRuntime(() => {});
    rt.models = fakeModels();
    rt.executor = { run: async ({ record }) => (executed.push(record.action), "done") };

    const n = await pollOnce(rt, new FixtureSource(inbox));
    expect(n).toBe(3);
    expect(executed).toEqual(["prepare_fix"]);
    expect(rt.store.get("gmail:lastPoll")).toBeTruthy();
    expect(rt.store.recentAudit().some((a) => a.kind === "error" && a.detail.includes("boom"))).toBe(true);

    expect(await pollOnce(rt, new FixtureSource(inbox))).toBe(0);
  });

  it("uses the fixture inbox only when IBO_TEST_INBOX is set", async () => {
    process.env.IBO_TEST_INBOX = "/tmp/x.json";
    expect(await emailSource()).toBeInstanceOf(FixtureSource);
    delete process.env.IBO_TEST_INBOX;
    await expect(emailSource()).rejects.toThrow(/ibo setup gmail/);
  });
});
