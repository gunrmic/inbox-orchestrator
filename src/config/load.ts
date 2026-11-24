import { existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { paths, ensureHome } from "./paths.js";
import { ProjectsFile, Settings, ToolsFile } from "./schema.js";

function readYaml<T extends z.ZodTypeAny>(file: string, schema: T): z.infer<T> {
  if (!existsSync(file)) return schema.parse({});
  const raw = YAML.parse(readFileSync(file, "utf8")) ?? {};
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid config in ${file}:\n${issues}`);
  }
  return parsed.data;
}

function writeYaml(file: string, value: unknown, header?: string): void {
  ensureHome();
  const body = YAML.stringify(value, { lineWidth: 0 });
  writeFileSync(file, (header ? `${header}\n` : "") + body, { mode: 0o600 });
}

export const loadSettings = (): Settings => readYaml(paths.settings, Settings);
export const loadProjects = (): ProjectsFile => readYaml(paths.projects, ProjectsFile);
export const loadTools = (): ToolsFile => readYaml(paths.tools, ToolsFile);

export const saveSettings = (s: Settings) =>
  writeYaml(paths.settings, s, "# inbox-orchestrator settings. See README for every field.");
export const saveProjects = (p: ProjectsFile) =>
  writeYaml(
    paths.projects,
    p,
    "# Written by `ibo onboard`. Safe to edit by hand. Re-run onboarding to add projects.",
  );
export const saveTools = (t: ToolsFile) =>
  writeYaml(
    paths.tools,
    t,
    "# MCP tool risk levels: 0 read, 1 local+reversible, 2 visible to others, 3 dangerous.\n# Tools missing from this file are treated as level 3.",
  );
