/**
 * Loads the built main.js the way Obsidian does, as CommonJS with only the
 * modules Obsidian provides, as on mobile where Node's are missing, and
 * checks it exports a plugin class. Run after `bun run build`.
 */
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";

class Plugin {}
const load = createRequire(import.meta.url);
const stub = (exports: Record<string, unknown>) =>
  new Proxy(exports, {
    get: (target, key) => (key in target ? target[key as string] : class {}),
  });
const provided = /^(obsidian|@codemirror\/[a-z]+|@lezer\/[a-z]+)$/u;
/** Obsidian's own copies of the editor packages, here whichever copy the dependencies resolve to. */
function editorPackage(name: string): unknown {
  const from = Bun.resolveSync("@flow-industries/seal", import.meta.dir);
  return load(Bun.resolveSync(name, from)) as unknown;
}
const required = new Set<string>();
const module = { exports: {} as Record<string, unknown> };
const code = await Bun.file("main.js").text();
const run = compileFunction(code, ["module", "exports", "require"]) as (
  module: { exports: Record<string, unknown> },
  exports: Record<string, unknown>,
  require: (name: string) => unknown,
) => void;
run(module, module.exports, (name) => {
  if (!provided.test(name)) throw new Error(`main.js requires ${name} at load`);
  required.add(name);
  return name === "obsidian" ? stub({ Plugin }) : editorPackage(name);
});
const plugin = module.exports.default;
if (typeof plugin !== "function" || !(plugin.prototype instanceof Plugin))
  throw new Error("main.js doesn't export a Plugin subclass as default");
process.stdout.write(
  `main.js loads (${(code.length / 1024).toFixed(0)} KiB), requiring only ${[...required].join(", ")}\n`,
);
