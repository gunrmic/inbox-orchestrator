import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { ProjectsFile, Settings, ToolsFile } from "../../src/config/schema.js";
import { effectiveRisk } from "../../src/policy/risk.js";

const read = (f: string) => YAML.parse(readFileSync(new URL(`../../examples/${f}`, import.meta.url), "utf8"));

describe("example configs", () => {
  it("parse with the real schemas", () => {
    expect(Settings.parse(read("settings.yaml")).mode).toBe("suggest");
    expect(ProjectsFile.parse(read("projects.yaml")).projects).toHaveLength(2);
    const tools = ToolsFile.parse(read("tools.yaml")).tools;
    expect(effectiveRisk("base44/create_checkpoint", tools)).toBe(1);
  });
});
