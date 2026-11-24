import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

// Never touch the real state folder or the macOS Keychain from tests.
process.env.IBO_SECRETS_BACKEND = "file";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;

beforeEach(() => {
  process.env.IBO_HOME = mkdtempSync(join(tmpdir(), "ibo-test-"));
});
