#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. Records its arguments, edits a file in the
// working directory like a real session would, and prints Claude Code's JSON output.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

// Print mode with a canned answer: used for the planning model and connector calls.
if (args[0] === "--version") {
  process.stdout.write("9.9.9 (Claude Code)\n");
} else if (process.env.FAKE_CLAUDE_RESULT !== undefined) {
  let stdin = "";
  process.stdin.on("data", (d) => (stdin += d));
  process.stdin.on("end", () => {
    if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), args, stdin }) + "\n");
    process.stdout.write(JSON.stringify({ type: "result", is_error: process.env.FAKE_CLAUDE_ERROR === "1", result: process.env.FAKE_CLAUDE_RESULT }));
  });
  process.stdin.resume();
} else {

if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), args }) + "\n");
if (process.env.FAKE_CLAUDE_FAIL) {
  process.stderr.write("simulated failure\n");
  process.exit(2);
}
writeFileSync(join(process.cwd(), "FIX.md"), "Fixed the date filter.\n");
process.stdout.write(JSON.stringify({ type: "result", result: "Reproduced the bug and fixed the date filter." }));
}
