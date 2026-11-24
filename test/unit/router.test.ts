import { describe, expect, it } from "vitest";
import { routeEmail } from "../../src/pipeline/router.js";
import { email, project } from "../helpers.js";

const projects = [
  project({ id: "coleven", match: { senders: ["jack@coleven.com"], domains: ["coleven.com"], keywords: ["hawk graph"] } }),
  project({ id: "acme", status: "dormant", match: { senders: [], domains: ["acme.io"], keywords: ["acme api"] } }),
  project({ id: "shamir", match: { senders: [], domains: [], keywords: ["decisions bot", "kibbutz"] } }),
];

describe("routeEmail", () => {
  it("matches an exact sender first", () => {
    const r = routeEmail(email(), projects);
    expect(r.project?.id).toBe("coleven");
    expect(r.matchedBy).toBe("sender");
  });
  it("matches domains and subdomains", () => {
    expect(routeEmail(email({ fromAddress: "dev@eu.acme.io" }), projects).project?.id).toBe("acme");
  });
  it("flags dormant projects for reactivation", () => {
    expect(routeEmail(email({ fromAddress: "x@acme.io" }), projects).needsReactivation).toBe(true);
  });
  it("falls back to keywords", () => {
    const r = routeEmail(email({ fromAddress: "someone@gmail.com", subject: "Kibbutz decisions bot question", body: "" }), projects);
    expect(r.project?.id).toBe("shamir");
    expect(r.matchedBy).toBe("keyword");
  });
  it("returns null for ambiguous keyword ties", () => {
    const r = routeEmail(email({ fromAddress: "x@gmail.com", subject: "hawk graph and acme api", body: "" }), projects);
    expect(r.project).toBeNull();
  });
  it("returns null when nothing matches", () => {
    expect(routeEmail(email({ fromAddress: "new@stranger.org", subject: "hello", body: "" }), projects).project).toBeNull();
  });
});
