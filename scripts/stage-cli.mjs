// Stages the built CLI with production dependencies into build/cli, which electron-builder
// copies into the app as Contents/Resources/cli. Run from menubar/ via `npm run dist`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "cli");
if (!existsSync(join(root, "dist", "cli.js"))) throw new Error("Build the CLI first: npm run build (in the repo root).");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ["dist", "package.json", "package-lock.json", "LICENSE"]) {
  if (existsSync(join(root, f))) cpSync(join(root, f), join(out, f), { recursive: true });
}
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-fund", "--no-audit", "--loglevel=error"], { cwd: out, stdio: "inherit" });
console.log(`Staged CLI in ${out}`);
