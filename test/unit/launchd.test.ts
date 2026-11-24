import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), platform: () => "linux" }));
const { LABEL, installAgent, renderPlist } = await import("../../src/util/launchd.js");
const { suggestLocalModel } = await import("../../src/util/local-model.js");

describe("launchd plist", () => {
  const render = () => renderPlist("/opt/node", "/app/dist/cli.js", "/usr/bin:/a&b");

  it("runs `ibo start` at login and keeps it alive", () => {
    const xml = render();
    expect(xml).toContain(`<key>Label</key><string>${LABEL}</string>`);
    expect(xml).toMatch(/<string>\/opt\/node<\/string>\s*<string>\/app\/dist\/cli.js<\/string>\s*<string>start<\/string>/);
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
  });

  it("escapes XML and logs to the state folder", () => {
    const xml = render();
    expect(xml).toContain("/usr/bin:/a&amp;b");
    expect(xml).toContain(`${process.env.IBO_HOME}/logs/daemon.log`);
  });

  it("refuses to install outside macOS", async () => {
    await expect(installAgent("/x")).rejects.toThrow(/macOS only/);
  });
});

describe("local model suggestion", () => {
  const GB = 1024 ** 3;
  it("scales with memory", () => {
    expect(suggestLocalModel(8 * GB)).toBe("qwen3:4b");
    expect(suggestLocalModel(16 * GB)).toBe("qwen3:8b");
    expect(suggestLocalModel(32 * GB)).toBe("qwen3:14b");
    expect(suggestLocalModel(64 * GB)).toBe("qwen3:30b");
  });
});
