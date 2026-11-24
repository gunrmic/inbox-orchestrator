import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), platform: () => "linux" }));
const runClaudeCode = vi.fn(async () => "Branch ibo/1-x");
vi.mock("../../src/executors/claude-code.js", async (orig) => ({
  ...(await orig<typeof import("../../src/executors/claude-code.js")>()),
  runClaudeCode,
}));

const { DefaultExecutor } = await import("../../src/executors/index.js");
const { slugify, ALLOWED_TOOLS, DISALLOWED_TOOLS } = await import("../../src/executors/claude-code.js");
import type { ActionRecord } from "../../src/types.js";
import { email } from "../helpers.js";

const record = (patch: Partial<ActionRecord> = {}): ActionRecord => ({
  id: 7,
  emailId: "m1",
  projectId: "p",
  action: "x",
  summary: "Fix the date filter",
  args: {},
  risk: 1,
  decision: "execute",
  reason: "",
  status: "executing",
  result: null,
  createdAt: "",
  updatedAt: "",
  ...patch,
});

describe("DefaultExecutor", () => {
  const hub = { callTool: vi.fn(async () => "tool ok") };
  const ex = new DefaultExecutor(hub as never);

  it("calls the MCP tool with defaults under the planner's args", async () => {
    const out = await ex.run({
      record: record({ args: { title: "T", project: "OVERRIDE" } }),
      step: { kind: "mcp", server: "jira", tool: "create_issue", defaults: { project: "HG", type: "Bug" } },
      project: null,
      email: null,
    });
    expect(out).toBe("tool ok");
    expect(hub.callTool).toHaveBeenCalledWith("jira", "create_issue", { project: "OVERRIDE", type: "Bug", title: "T" });
  });

  it("only logs reminders outside macOS", async () => {
    const out = await ex.run({ record: record({ args: { title: "Call Jack" } }), step: { kind: "reminder" }, project: null, email: email() });
    expect(out).toBe("Reminder (not on macOS, logged only): Call Jack");
  });

  it("passes the task and the email as context to Claude Code", async () => {
    await ex.run({
      record: record({ args: { task: "Reproduce the bug" } }),
      step: { kind: "claude-code", repo: "/repo", baseBranch: "develop" },
      project: null,
      email: email(),
    });
    expect(runClaudeCode).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "/repo", baseBranch: "develop", actionId: 7, task: "Reproduce the bug", title: "Fix the date filter" }),
    );
    expect((runClaudeCode.mock.calls[0] as unknown as [{ emailContext: string }])[0].emailContext).toContain("<email>");
  });
});

describe("Claude Code safety lists", () => {
  it("never allow push, remotes or network tools", () => {
    expect(ALLOWED_TOOLS.some((t) => /push|remote|curl|wget|WebFetch/.test(t))).toBe(false);
    expect(DISALLOWED_TOOLS).toEqual(expect.arrayContaining(["Bash(git push:*)", "WebFetch", "WebSearch"]));
  });
  it("slugify branch names", () => {
    expect(slugify("Fix: the Date filter!!")).toBe("fix-the-date-filter");
    expect(slugify("")).toBe("task");
    expect(slugify("x".repeat(80))).toHaveLength(40);
  });
});
