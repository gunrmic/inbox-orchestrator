import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultScanRoots, findRepos } from "../../src/discovery/repos.js";

describe("findRepos", () => {
  const saved = process.env.IBO_SCAN_ROOTS;
  afterEach(() => {
    process.env.IBO_SCAN_ROOTS = saved;
  });

  it("finds repos at any depth up to the limit, without descending into a repo or node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "ibo-repos-"));
    const repo = (p: string) => mkdirSync(join(root, p, ".git"), { recursive: true });
    repo("coleven-capture");
    repo("clients/acme/web");
    repo("coleven-capture/packages/inner"); // inside a repo: counted once
    repo("app/node_modules/dep"); // skipped
    repo("a/b/c/too-deep");
    mkdirSync(join(root, "base44-app"), { recursive: true });
    writeFileSync(join(root, "base44-app", "package.json"), "{}");
    mkdirSync(join(root, "notes"), { recursive: true });
    const found = findRepos([root], 3).map((f) => f.slice(root.length + 1)).sort();
    expect(found).toEqual(["base44-app", "clients/acme/web", "coleven-capture"]);
    expect(findRepos([join(root, "missing")])).toEqual([]);
  });

  it("uses IBO_SCAN_ROOTS when set, else the usual code folders under home", () => {
    process.env.IBO_SCAN_ROOTS = "/x:/y";
    expect(defaultScanRoots("/h")).toEqual(["/x", "/y"]);
    delete process.env.IBO_SCAN_ROOTS;
    expect(defaultScanRoots("/h")).toContain("/h/projects");
    expect(defaultScanRoots("/h")).toContain("/h/apps");
  });
});
