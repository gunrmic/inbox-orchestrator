import { defineConfig } from "vitest/config";

/**
 * Three suites:
 * - unit:        pure logic, no network, no child processes
 * - integration: real SQLite, real git, a real MCP server over stdio, the HTTP API in-process
 * - e2e:         the built `ibo` CLI and daemon as child processes, with fake model servers
 *
 * Every suite uses a throwaway IBO_HOME and the file secrets backend, so nothing touches
 * your real config or macOS Keychain.
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/daemon.ts"], // covered by e2e as child processes
      reporter: ["text-summary", "html", "lcov"],
      thresholds: { lines: 85, functions: 85, branches: 70, statements: 85 },
    },
    projects: [
      { extends: true, test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
      { extends: true, test: { name: "integration", include: ["test/integration/**/*.test.ts"], testTimeout: 30_000 } },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          exclude: ["test/e2e/install.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: { name: "install", include: ["test/e2e/install.test.ts"], testTimeout: 300_000, hookTimeout: 300_000 },
      },
    ],
  },
});
