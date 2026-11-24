// Bundles the CLI and daemon into one file with every dependency inside, at build/cli,
// which electron-builder copies into the app as Contents/Resources/cli. One file because
// electron-builder leaves node_modules out of extra resources. Run from menubar/ via `npm run dist`.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "cli");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "cli.ts")],
  outfile: join(out, "dist", "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "external",
  // Some dependencies are CommonJS and call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __ibo_cr } from 'node:module'; const require = __ibo_cr(import.meta.url);" },
  logLevel: "warning",
});
// The CLI reads its version from ../package.json.
cpSync(join(root, "package.json"), join(out, "package.json"));
if (existsSync(join(root, "LICENSE"))) cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
writeFileSync(join(out, "README.txt"), "inbox-orchestrator CLI and daemon, bundled. Source: https://github.com/gunrmic/inbox-orchestrator\n");
console.log(`Bundled CLI in ${out}`);
