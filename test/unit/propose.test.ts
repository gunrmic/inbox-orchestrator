import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRouter } from "../../src/models/router.js";
import type { Provider } from "../../src/models/providers.js";
import { proposeDeterministic, proposeWithModel, type Evidence } from "../../src/discovery/propose.js";
import { settings } from "../helpers.js";

const NOW = Date.parse("2026-11-24T12:00:00Z");

function evidence(folder: string): Evidence {
  return {
    sessions: {
      folders: [{ folder, lastActivity: "2026-11-20T10:00:00Z", sessions: 3, servers: { base44: 12 } }],
      servers: [{ server: "base44", lastUsed: "2026-11-20T10:00:00Z", calls: 12, folders: [folder] }],
    },
    repos: [{ folder, isGit: true, lastCommit: "2026-11-22T10:00:00Z", defaultBranch: "develop", remote: "git@x:y.git" }],
    probes: [],
    senders: [{ domain: "coleven.com", count: 140, senders: ["jack@coleven.com"], last: "2026-11-23T00:00:00Z" }],
  };
}

describe("proposeDeterministic", () => {
  it("creates one project per folder with git-based actions and its docs as summary", () => {
    const folder = mkdtempSync(join(tmpdir(), "hawk-"));
    writeFileSync(join(folder, "CLAUDE.md"), "# Hawk\nNext.js app");
    const [c] = proposeDeterministic(evidence(folder), NOW);
    expect(c.project.status).toBe("live");
    expect(c.project.lastActivity).toBe("2026-11-22T10:00:00Z");
    expect(c.project.playbook.prepare_fix).toEqual({ kind: "claude-code", repo: folder, baseBranch: "develop" });
    expect(c.summary).toContain("Next.js app");
    expect(c.evidence.join(" ")).toContain("base44 (12 calls)");
  });
});

describe("proposeWithModel", () => {
  it("maps the model's proposal into validated projects", async () => {
    const folder = "/Users/omer/code/hawk";
    const answer = {
      projects: [
        {
          id: "Hawk Graph",
          name: "Hawk Graph",
          folder,
          domains: ["coleven.com"],
          senders: ["jack@coleven.com"],
          keywords: ["Hawk"],
          summary: "Base44 app",
          confidence: 0.9,
          playbook: {
            prepare_fix: { kind: "mcp", server: "base44", tool: "create_checkpoint" },
            reproduce_bug: { kind: "claude-code" },
            broken: { kind: "mcp", server: "base44" },
          },
          question: { text: "Link coleven.com to Hawk?", options: [{ label: "Yes", reason: "names match" }, { label: "No", reason: "" }] },
        },
        { id: "old", name: "Old", summary: "", confidence: 0.2, lastActivity: "2024-01-01T00:00:00Z" },
      ],
    };
    const provider: Provider = {
      id: "anthropic",
      available: async () => true,
      structured: async (_m, req) => {
        expect(req.name).toBe("propose_projects");
        expect(req.user).toContain("coleven.com");
        return answer;
      },
    };
    const router = new ModelRouter({ settings: settings().models, allowLocalModels: true, providers: { anthropic: provider, ollama: provider } });
    const [hawk, old] = await proposeWithModel(router, evidence(folder), NOW);

    expect(hawk.project.id).toBe("hawk-graph");
    expect(hawk.project.status).toBe("live");
    expect(hawk.project.match.domains).toEqual(["coleven.com"]);
    expect(hawk.project.playbook).toEqual({
      prepare_fix: { kind: "mcp", server: "base44", tool: "create_checkpoint" },
      reproduce_bug: { kind: "claude-code", repo: folder, baseBranch: "main" },
    });
    expect(hawk.question?.options[0].label).toBe("Yes");
    expect(old.project.status).toBe("dead");
  });
});
