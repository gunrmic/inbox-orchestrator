import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** The Claude Code binary. IBO_CLAUDE_BIN overrides it (tests, custom installs). */
export const claudeBin = () => process.env.IBO_CLAUDE_BIN ?? "claude";

let cached: { bin: string; ok: boolean } | null = null;

/** Is Claude Code installed? Cached per binary. */
export async function hasClaude(): Promise<boolean> {
  const bin = claudeBin();
  if (cached?.bin === bin) return cached.ok;
  let ok = false;
  try {
    await execFileP(bin, ["--version"], { timeout: 10_000 });
    ok = true;
  } catch {
    ok = false;
  }
  cached = { bin, ok };
  return ok;
}

export function resetClaudeCache(): void {
  cached = null;
}

/** Runs `claude` with the prompt on stdin. Resolves with stdout, rejects on a non-zero exit. */
export function runClaude(args: string[], opts: { input?: string; cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, { cwd: opts.cwd, env: process.env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 10 * 60_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Claude Code (is \`claude\` on PATH?): ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`Claude Code exited ${code}: ${err.slice(-1000)}`));
    });
    child.stdin.end(opts.input ?? "");
  });
}

/** Claude Code's --output-format json wraps the answer as {result}. */
export function resultText(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    if (parsed.is_error) throw new Error(parsed.result ?? "Claude Code returned an error.");
    return parsed.result ?? stdout;
  } catch (e) {
    if (e instanceof SyntaxError) return stdout;
    throw e;
  }
}

/** First JSON object in a model answer, tolerating ```json fences and prose around it. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in the answer.");
  return JSON.parse(body.slice(start, end + 1));
}
