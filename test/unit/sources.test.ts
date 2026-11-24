import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { lastFileChange } from "../../src/discovery/activity.js";
import { scanCodexSessions, scanEditorWorkspaces, editorStorageRoots } from "../../src/discovery/editors.js";
import { readAssistantExport } from "../../src/discovery/exports.js";
import { linkByName, nameTokens, orgOfDomain, proposeDeterministic, type Evidence } from "../../src/discovery/propose.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

describe("other coding tools", () => {
  it("reads the working folder of Codex sessions", async () => {
    const root = tmp("codex-");
    mkdirSync(join(root, "2026", "11", "20"), { recursive: true });
    const line = (o: object) => JSON.stringify(o);
    writeFileSync(join(root, "2026", "11", "20", "rollout-a.jsonl"), [line({ type: "session_meta", payload: { cwd: "/w/coleven" } }), "not json"].join("\n"));
    writeFileSync(join(root, "2026", "11", "20", "rollout-b.jsonl"), line({ cwd: "/w/coleven" }));
    writeFileSync(join(root, "2026", "11", "20", "rollout-c.jsonl"), "garbage");
    const old = join(root, "old.jsonl");
    writeFileSync(old, line({ cwd: "/w/old" }));
    utimesSync(old, daysAgo(400), daysAgo(400));
    const found = await scanCodexSessions(root);
    expect(found).toEqual([expect.objectContaining({ folder: "/w/coleven", sessions: 2, via: "Codex" })]);
    expect(await scanCodexSessions(join(root, "missing"))).toEqual([]);
  });

  it("reads the folders Cursor and VS Code opened, skipping gone or old ones", () => {
    const home = tmp("editors-");
    const project = join(home, "projects", "coleven-capture");
    mkdirSync(project, { recursive: true });
    const roots = editorStorageRoots(home);
    const ws = (root: string, hash: string, body: object) => {
      mkdirSync(join(root, hash), { recursive: true });
      writeFileSync(join(root, hash, "workspace.json"), JSON.stringify(body));
      return join(root, hash, "workspace.json");
    };
    ws(roots[0].root, "a", { folder: pathToFileURL(project).href });
    ws(roots[1].root, "b", { folder: pathToFileURL(project).href });
    ws(roots[0].root, "gone", { folder: pathToFileURL(join(home, "deleted")).href });
    ws(roots[0].root, "remote", { folder: "vscode-remote://ssh/x" });
    const old = ws(roots[0].root, "old", { folder: pathToFileURL(home).href });
    utimesSync(old, daysAgo(400), daysAgo(400));
    mkdirSync(join(roots[0].root, "broken"), { recursive: true });
    writeFileSync(join(roots[0].root, "broken", "workspace.json"), "{");
    const found = scanEditorWorkspaces(roots);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ folder: project, sessions: 2, via: "Cursor" });
  });

  it("finds the newest file change, ignoring node_modules and .git", () => {
    const dir = tmp("files-");
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "src", "a.ts"), "x");
    writeFileSync(join(dir, "node_modules", "dep.js"), "x");
    utimesSync(join(dir, "src", "a.ts"), daysAgo(10), daysAgo(10));
    expect(lastFileChange(dir)!.slice(0, 10)).toBe(daysAgo(10).toISOString().slice(0, 10));
    expect(lastFileChange(join(dir, "missing"))).toBeNull();
  });
});

describe("assistant exports", () => {
  it("reads Claude projects and chats from a folder or a zip", () => {
    const dir = tmp("claude-export-");
    writeFileSync(
      join(dir, "projects.json"),
      JSON.stringify([
        { name: "Coleven", description: "Hawk Graph analyst app", updated_at: "2026-11-19T10:00:00Z" },
        { name: "How to use Claude", is_starter_project: true },
      ]),
    );
    writeFileSync(join(dir, "conversations.json"), JSON.stringify([{ name: "Coleven entity schema", updated_at: "2026-11-20T10:00:00Z", chat_messages: [] }]));
    const a = readAssistantExport(dir);
    expect(a.source).toBe("Claude");
    expect(a.projects).toEqual([{ name: "Coleven", description: "Hawk Graph analyst app", lastActivity: "2026-11-19T10:00:00.000Z" }]);
    expect(a.titles[0].title).toBe("Coleven entity schema");

    const zip = join(tmp("zip-"), "data.zip");
    execFileSync("zip", ["-q", "-j", zip, join(dir, "projects.json"), join(dir, "conversations.json")]);
    expect(readAssistantExport(zip).projects).toHaveLength(1);
  });

  it("reads ChatGPT conversation titles and rejects other files", () => {
    const file = join(tmp("gpt-"), "conversations.json");
    writeFileSync(file, JSON.stringify([{ title: "Coleven pricing", update_time: 1763000000, mapping: {} }, { title: "" }]));
    const a = readAssistantExport(file);
    expect(a.source).toBe("ChatGPT");
    expect(a.titles).toEqual([{ title: "Coleven pricing", lastActivity: new Date(1763000000 * 1000).toISOString() }]);
    const other = join(tmp("x-"), "notes.txt");
    writeFileSync(other, "hi");
    expect(() => readAssistantExport(other)).toThrow(/not a Claude or ChatGPT/);
    expect(() => readAssistantExport("/nope.zip")).toThrow(/No such file/);
  });
});

describe("linking signals by name", () => {
  it("extracts name tokens and the organisation from a domain", () => {
    expect(nameTokens("coleven-capture")).toEqual(["coleven", "capture"]);
    expect(nameTokens("coleven.com")).toEqual(["coleven"]);
    expect(orgOfDomain("mail.coleven.com")).toBe("coleven");
    expect(orgOfDomain("shamir.co.il")).toBe("shamir");
  });

  const now = Date.parse("2026-11-24T12:00:00Z");
  const base: Evidence = {
    sessions: {
      folders: [{ folder: "/p/coleven-capture", lastActivity: "", sessions: 0, servers: {}, via: ["Cursor"], lastFileChange: "2026-11-20T00:00:00Z" }],
      servers: [],
    },
    repos: [],
    probes: [],
    senders: [
      { domain: "coleven.com", count: 12, senders: ["jack@coleven.com"], last: "2026-11-23T00:00:00Z" },
      { domain: "acme.io", count: 7, senders: ["ceo@acme.io"], last: "2026-11-01T00:00:00Z" },
      { domain: "rare.com", count: 1, senders: ["x@rare.com"], last: "2026-11-01T00:00:00Z" },
    ],
    assistants: [
      {
        source: "Claude",
        projects: [
          { name: "Coleven", description: "", lastActivity: "2026-11-22T00:00:00Z" },
          { name: "Shamir", description: "Kibbutz decisions bot", lastActivity: "2026-11-23T00:00:00Z" },
        ],
        titles: [{ title: "Shamir vendor proposal", lastActivity: "2026-11-24T00:00:00Z" }],
      },
    ],
  };

  it("joins a folder, an email domain and a Claude Project into one live project", () => {
    const c = proposeDeterministic(base, now);
    const coleven = c.find((x) => x.project.id === "coleven-capture")!;
    expect(coleven.project.match.domains).toEqual(["coleven.com"]);
    expect(coleven.project.status).toBe("live");
    expect(coleven.evidence.join("\n")).toMatch(/seen in Cursor[\s\S]*Claude Project "Coleven"[\s\S]*coleven.com: 12 emails from them/);

    const shamir = c.find((x) => x.project.id === "shamir")!;
    expect(shamir.evidence[0]).toMatch(/1 related chats/);
    expect(shamir.project.lastActivity).toBe("2026-11-24T00:00:00Z");

    const acme = c.find((x) => x.project.id === "acme")!;
    expect(acme.project.match.domains).toEqual(["acme.io"]);
    expect(acme.question?.options[0].label).toMatch(/client/);
    expect(c.find((x) => x.project.id === "rare")).toBeUndefined();
  });

  it("treats domains you reply to or meet with as projects, without asking", () => {
    const ev: Evidence = {
      ...base,
      assistants: undefined,
      senders: [],
      recipients: [{ domain: "kibbutz-shamir.org.il", count: 3, last: "2026-11-23T00:00:00Z" }],
      meetings: [{ domain: "admetec.com", count: 2, last: "2026-11-20T00:00:00Z", titles: ["KOL sync"] }],
    };
    const c = proposeDeterministic(ev, now);
    const shamir = c.find((x) => x.project.id === "kibbutz-shamir")!;
    expect(shamir.question).toBeUndefined();
    expect(shamir.evidence[0]).toMatch(/you wrote to them 3 times/);
    const adm = c.find((x) => x.project.id === "admetec")!;
    expect(adm.evidence.join(" ")).toMatch(/2 meetings[\s\S]*KOL sync/);
    expect(adm.confidence).toBe(0.6);
  });

  it("works with no assistant exports", () => {
    expect(linkByName([], { ...base, assistants: undefined, senders: [] })).toEqual([]);
  });
});
