import { chmodSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const answers = { select: [] as unknown[], confirm: [] as boolean[], password: [] as string[] };
vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(async ({ choices }: { choices: { value: unknown }[] }) => (answers.select.length ? answers.select.shift() : choices[0].value)),
  confirm: vi.fn(async ({ default: d }: { default?: boolean }) => answers.confirm.shift() ?? d ?? false),
  password: vi.fn(async () => answers.password.shift() ?? ""),
  input: vi.fn(async () => ""),
  checkbox: vi.fn(async () => []),
}));
vi.mock("../../src/gmail/auth.js", async (orig) => ({ ...(await orig<object>()), authorizeInteractive: vi.fn(async () => undefined) }));

const { setupClaude, setupGmail, setupLocalModel } = await import("../../src/setup.js");
const { getSecret, setSecret } = await import("../../src/util/secrets.js");
const { resetClaudeCache } = await import("../../src/util/claude-cli.js");
const { authorizeInteractive } = await import("../../src/gmail/auth.js");
const { Settings } = await import("../../src/config/schema.js");

const lines: string[] = [];
const io = { log: (s: string) => void lines.push(s) };
const saved = process.env.IBO_CLAUDE_BIN;
afterEach(() => {
  process.env.IBO_CLAUDE_BIN = saved;
  resetClaudeCache();
  lines.length = 0;
});

function fakeClaudeOnPath() {
  const bin = mkdtempSync(join(tmpdir(), "setup-claude-"));
  const target = join(bin, "claude");
  copyFileSync(fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url)), target);
  chmodSync(target, 0o755);
  process.env.IBO_CLAUDE_BIN = target;
  resetClaudeCache();
}

describe("ibo setup steps", () => {
  it("uses the Claude Code login without asking for a key", async () => {
    fakeClaudeOnPath();
    expect(await setupClaude(io)).toBe("claude-code");
    expect(lines.join()).toMatch(/no API key needed/);
  });

  it("asks for a key when Claude Code is missing, and can skip", async () => {
    answers.select = ["key"];
    answers.password = ["sk-test"];
    expect(await setupClaude(io)).toBe("api");
    expect(await getSecret("anthropic-api-key")).toBe("sk-test");
    expect(await setupClaude(io)).toBe("api");
    answers.select = ["skip"];
    expect(await setupClaude({ ...io, force: true })).toBe("none");
  });

  it("signs in to Gmail once", async () => {
    await setupGmail(io);
    expect(authorizeInteractive).toHaveBeenCalledTimes(1);
    await setSecret("google-refresh-token", "rt");
    await setupGmail(io);
    expect(authorizeInteractive).toHaveBeenCalledTimes(1);
  });

  it("picks and downloads a local model when Ollama runs, and respects the org block", async () => {
    const s = Settings.parse({});
    const ollama = { available: vi.fn(async () => true), hasModel: vi.fn(async () => false), pull: vi.fn(async () => undefined) };
    await setupLocalModel(s, io, ollama as never);
    expect(ollama.pull).toHaveBeenCalledTimes(1);
    expect(s.models.filter.provider).toBe("ollama");
    expect(lines.join()).toMatch(/Local model/);

    const blocked = Settings.parse({ org: { allowLocalModels: false } });
    await setupLocalModel(blocked, io, ollama as never);
    expect(ollama.pull).toHaveBeenCalledTimes(1);
  });
});
