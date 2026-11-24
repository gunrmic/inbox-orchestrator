import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

// Git hooks export GIT_DIR, GIT_INDEX_FILE and friends. Inside the pre-commit hook those
// would point every `git -C <temp repo>` in the tests at this repository's index.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

// Never touch the real state folder or the macOS Keychain from tests.
process.env.IBO_SECRETS_BACKEND = "file";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;

beforeEach(() => {
  process.env.IBO_HOME = mkdtempSync(join(tmpdir(), "ibo-test-"));
});
