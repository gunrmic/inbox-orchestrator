import { describe, expect, it } from "vitest";
import { decide, shouldOfferPromotion } from "../src/policy/engine.js";
import { effectiveRisk, isDiscoverySafe, riskFloor, suggestRisk } from "../src/policy/risk.js";
import { email, project, settings } from "./helpers.js";

const coleven = project({
  id: "coleven",
  match: { senders: ["jack@coleven.com"], domains: [], keywords: [] },
  playbook: {
    prepare_fix: { kind: "mcp", server: "base44", tool: "create_checkpoint" },
    publish: { kind: "mcp", server: "base44", tool: "publish_app" },
    schedule_meeting: { kind: "mcp", server: "gcal", tool: "create_event" },
    reproduce_bug: { kind: "claude-code", repo: "/tmp/repo", baseBranch: "main" },
  },
});
const risks = { "base44/create_checkpoint": 1, "base44/publish_app": 0, "gcal/create_event": 2 } as const;
const input = (action: string, patch: Partial<Parameters<typeof decide>[0]> = {}) => ({
  planned: { action, summary: action, args: {} },
  project: coleven,
  needsReactivation: false,
  email: email(),
  settings: settings(),
  toolRisks: { ...risks },
  ...patch,
});

describe("risk", () => {
  it("never lets config lower a dangerous tool below 3", () => {
    expect(riskFloor("publish_app")).toBe(3);
    expect(effectiveRisk("base44/publish_app", { "base44/publish_app": 0 })).toBe(3);
  });
  it("treats unconfirmed tools as dangerous", () => {
    expect(effectiveRisk("x/list_things", {})).toBe(3);
  });
  it("suggests levels from names and annotations", () => {
    expect(suggestRisk("list_issues")).toBe(0);
    expect(suggestRisk("anything", { readOnlyHint: true })).toBe(0);
    expect(suggestRisk("create_checkpoint")).toBe(1);
    expect(suggestRisk("create_event")).toBe(2);
    expect(suggestRisk("send_email")).toBe(3);
    expect(suggestRisk("frobnicate")).toBe(3);
    expect(suggestRisk("update_entities", { destructiveHint: true })).toBe(3);
  });
  it("only allows read-only tools during discovery", () => {
    expect(isDiscoverySafe("list_user_apps")).toBe(true);
    expect(isDiscoverySafe("delete_list")).toBe(false);
    expect(isDiscoverySafe("create_app")).toBe(false);
  });
});

describe("decide", () => {
  it("runs local reversible actions", () => {
    expect(decide(input("prepare_fix")).kind).toBe("execute");
    expect(decide(input("reproduce_bug")).kind).toBe("execute");
  });
  it("suggests actions visible to others in suggest mode", () => {
    expect(decide(input("schedule_meeting")).kind).toBe("suggest");
  });
  it("runs level 2 in auto mode but never level 3", () => {
    const auto = settings({ mode: "auto" });
    expect(decide(input("schedule_meeting", { settings: auto })).kind).toBe("execute");
    const d = decide(input("publish", { settings: auto }));
    expect(d.kind).toBe("suggest");
    expect(d.risk).toBe(3);
  });
  it("lets a project promote one level-2 action", () => {
    const p = { ...coleven, autonomy: { schedule_meeting: "auto" as const } };
    expect(decide(input("schedule_meeting", { project: p })).kind).toBe("execute");
  });
  it("cannot promote level 3 even with an override", () => {
    const p = { ...coleven, autonomy: { publish: "auto" as const } };
    expect(decide(input("publish", { project: p })).kind).toBe("suggest");
  });
  it("turns everything into a suggestion under the kill switch", () => {
    expect(decide(input("prepare_fix", { settings: settings({ killSwitch: true }) })).kind).toBe("suggest");
  });
  it("only suggests reminders for unknown senders and denies the rest", () => {
    expect(decide(input("create_reminder", { project: null })).kind).toBe("suggest");
    expect(decide(input("prepare_fix", { project: null })).kind).toBe("deny");
  });
  it("blocks code execution for mail that fails SPF and DKIM", () => {
    const spoofed = email({ auth: { spf: "fail", dkim: "fail" } });
    expect(decide(input("reproduce_bug", { email: spoofed })).kind).toBe("deny");
    expect(decide(input("prepare_fix", { email: spoofed })).kind).toBe("suggest");
  });
  it("asks before acting on a dormant project", () => {
    expect(decide(input("prepare_fix", { needsReactivation: true })).kind).toBe("suggest");
  });
  it("denies actions with no executor", () => {
    expect(decide(input("launch_rockets")).kind).toBe("deny");
  });
});

describe("promotion", () => {
  it("offers promotion only for level 2 after the threshold", () => {
    expect(shouldOfferPromotion(10, 2, undefined, 10)).toBe(true);
    expect(shouldOfferPromotion(9, 2, undefined, 10)).toBe(false);
    expect(shouldOfferPromotion(50, 3, undefined, 10)).toBe(false);
    expect(shouldOfferPromotion(50, 2, "auto", 10)).toBe(false);
  });
});
