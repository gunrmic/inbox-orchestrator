import { describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { join } from "node:path";
import { anthropicKey, getSecret, setSecret } from "../../src/util/secrets.js";

describe("secrets (file backend)", () => {
  it("stores and reads a secret with 0600 permissions", async () => {
    expect(await getSecret("token")).toBeNull();
    await setSecret("token", "s3cret\n");
    expect(await getSecret("token")).toBe("s3cret");
    expect(statSync(join(process.env.IBO_HOME!, "secrets", "token")).mode & 0o777).toBe(0o600);
  });

  it("sanitizes names into safe file names", async () => {
    await setSecret("../../etc/passwd", "x");
    expect(await getSecret("../../etc/passwd")).toBe("x");
  });

  it("prefers ANTHROPIC_API_KEY from the environment", async () => {
    await setSecret("anthropic-api-key", "from-store");
    expect(await anthropicKey()).toBe("from-store");
    process.env.ANTHROPIC_API_KEY = "from-env";
    try {
      expect(await anthropicKey()).toBe("from-env");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
